import { createHash, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { RequestLog, RequestLogInput, RequestLogUpstreamRequest } from "../../shared/types.js";
import { limitLogText, responseLogText } from "../log-content.js";
import { currentUserMessages, logRequestContext, type LogResponseTool } from "../log-context.js";
import { RequestLogTurns } from "./log-turns.js";

type LogContent = Pick<RequestLog, "upstream" | "result"> & { requestHeaders?: RequestLog["requestHeaders"] };
type LogPatch = Partial<Omit<RequestLogInput, "id" | "createdAt">>;
type LegacyLog = RequestLogInput & { upstreamAttempts?: RequestLogUpstreamRequest[] };
type LogRow = { id: string; created_at: string; data_json: string };

function downstreamHeaders(headers: Record<string, string> = {}, legacy = false) {
  return Object.fromEntries(Object.entries(headers)
    // Older logs mixed these generated diagnostics into downstream headers.
    .filter(([key]) => !legacy || !key.toLowerCase().startsWith("upstream-"))
    .map(([key, value]) => [key, ["authorization", "x-api-key", "cookie"].includes(key.toLowerCase()) ? "***" : value]));
}

function logContent(input: LogPatch, previous?: LogContent): LogContent {
  const attempt = input.upstreamRequest;
  const url = input.upstreamUrl || attempt?.upstreamUrl || previous?.upstream?.url;
  const body = input.responsePreview ?? attempt?.responsePreview;
  const streamStartedWith = input.streamStartedWith ?? previous?.result.streamStartedWith;
  return {
    requestHeaders: previous?.requestHeaders || downstreamHeaders(input.requestHeaders),
    upstream: url ? {
      provider: input.providerName || previous?.upstream?.provider || "",
      model: attempt?.model || input.model || previous?.upstream?.model || "",
      url
    } : previous?.upstream,
    result: {
      status: input.status || previous?.result.status || "pending",
      statusCode: input.statusCode ?? previous?.result.statusCode ?? 0,
      body: body !== undefined ? limitLogText(body)
        : input.errorMessage ? limitLogText(input.errorMessage)
        : previous?.result.body || "",
      ...(streamStartedWith ? { streamStartedWith } : {})
    }
  };
}

export class RequestLogStore {
  private readonly turns: RequestLogTurns;
  private retentionLimit = 100;
  constructor(private readonly sqlite: Database, private readonly onLegacyLog: (log: LegacyLog) => void) {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS request_log_messages (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS request_log_message_refs (
        log_id TEXT NOT NULL REFERENCES request_logs(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        message_id TEXT NOT NULL REFERENCES request_log_messages(id),
        PRIMARY KEY (log_id, position)
      );
      CREATE INDEX IF NOT EXISTS idx_request_log_message_refs_message ON request_log_message_refs(message_id);
    `);
    this.turns = new RequestLogTurns(this.sqlite);
  }

  migrate(limit: number) {
    this.retentionLimit = limit;
    const version = this.sqlite.prepare("SELECT value FROM meta WHERE key = 'request_log_format'").get() as { value: string } | undefined;
    if (version?.value === "4") {
      this.turns.migrate(false);
      this.trim(limit);
      return;
    }
    let converted = false;
    this.sqlite.transaction(() => {
      let after = 0;
      while (version?.value !== "2" && version?.value !== "3") {
        // Migrate bounded batches; do not load all old request bodies into memory at startup.
        const rows = this.sqlite.prepare("SELECT rowid AS seq, id, created_at, data_json FROM request_logs WHERE rowid > ? ORDER BY rowid LIMIT 50").all(after) as Array<LogRow & { seq: number }>;
        if (!rows.length) break;
        for (const row of rows) {
          let parsed: LegacyLog & Partial<LogContent>;
          try {
            parsed = JSON.parse(row.data_json) as LegacyLog & Partial<LogContent>;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid log record");
          } catch {
            this.write(row.id, row.created_at, { requestHeaders: {}, result: { status: "failed", statusCode: 0, body: "旧日志格式损坏，无法恢复内容" } }, []);
            converted = true;
            after = row.seq;
            continue;
          }
          if (!parsed.result) {
            this.writeLegacy({ ...parsed, id: row.id, createdAt: row.created_at });
            converted = true;
          }
          after = row.seq;
        }
      }
      this.turns.migrate(version?.value !== "3");
      // Group legacy requests before removing the per-request headers used to correlate them.
      converted = this.compactHeaders() || converted;
      this.trimRows(limit);
      this.sqlite.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('request_log_format', '4')").run();
    })();
    if (converted || version?.value === "2") this.reclaimSpace();
  }

  private compactHeaders() {
    this.sqlite.prepare(`UPDATE request_log_turns SET request_headers_json = COALESCE(
      (SELECT json_extract(data_json, '$.requestHeaders') FROM request_logs
        WHERE turn_id = request_log_turns.id AND id = request_id ORDER BY created_at, rowid LIMIT 1), '{}')
      WHERE request_headers_json IS NULL`).run();
    // Keep just the main/child distinction before discarding each request's correlation headers.
    const select = this.sqlite.prepare(`SELECT rowid AS seq, id, json_extract(data_json, '$.requestHeaders') AS headers_json
      FROM request_logs WHERE rowid > ? AND json_type(data_json, '$.requestHeaders') = 'object' ORDER BY rowid LIMIT 50`);
    const markRoot = this.sqlite.prepare("UPDATE request_logs SET is_root_request = 1 WHERE id = ?");
    let after = 0;
    while (true) {
      const rows = select.all(after) as Array<{ seq: number; id: string; headers_json: string }>;
      if (!rows.length) break;
      for (const row of rows) {
        if (logRequestContext(JSON.parse(row.headers_json) as Record<string, string>, {}, "").isRootTurn) markRoot.run(row.id);
        after = row.seq;
      }
    }
    return this.sqlite.prepare(`UPDATE request_logs SET data_json = json_remove(data_json, '$.requestHeaders')
      WHERE json_type(data_json, '$.requestHeaders') IS NOT NULL`).run().changes > 0;
  }

  importLegacy(logs: RequestLogInput[], limit: number) {
    this.sqlite.transaction(() => {
      for (const log of logs.slice(0, limit).reverse()) this.writeLegacy(log);
      this.trimRows(limit);
    })();
  }

  private writeLegacy(log: LegacyLog) {
    if (!log.id || !log.createdAt) return;
    this.onLegacyLog(log);
    const attempt = log.upstreamRequest || log.upstreamAttempts?.at(-1);
    const input = {
      ...log,
      requestHeaders: downstreamHeaders(log.requestHeaders, true),
      upstreamRequest: attempt,
      responsePreview: responseLogText(log.responsePreview || attempt?.responsePreview || log.errorMessage)
    };
    this.write(log.id, log.createdAt, logContent(input), currentUserMessages(input.requestBody), { keepLegacyHeaders: true });
  }

  record(input: Omit<RequestLogInput, "id" | "createdAt">, limit: number) {
    this.retentionLimit = limit;
    const id = `log-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.sqlite.transaction(() => {
      this.write(id, createdAt, logContent(input), currentUserMessages(input.requestBody), { parentRequestId: input.parentRequestId });
      if (input.parentRequestId && (input.status === "failed" || input.status === "cancelled")) this.turns.interruptTools(input.parentRequestId);
      if (input.status !== "pending" || input.parentRequestId) this.trimRows(limit);
    })();
    return { id, createdAt };
  }

  update(id: string, patch: LogPatch) {
    const row = this.sqlite.prepare("SELECT id, created_at, data_json FROM request_logs WHERE id = ?").get(id) as LogRow | undefined;
    if (!row) return undefined;
    const content = logContent(patch, JSON.parse(row.data_json) as LogContent);
    this.sqlite.transaction(() => {
      this.write(id, row.created_at, content, patch.requestBody === undefined ? undefined : currentUserMessages(patch.requestBody));
      if (patch.status === "failed" || patch.status === "cancelled") this.turns.interruptTools(id);
      if (patch.status && patch.status !== "pending") this.trimRows(this.retentionLimit);
      this.collectUnusedMessages();
    })();
    return { id, createdAt: row.created_at };
  }

  private write(id: string, createdAt: string, content: LogContent, messages?: string[], options: { parentRequestId?: string; keepLegacyHeaders?: boolean } = {}) {
    const link = this.turns.entry(id, createdAt, options.parentRequestId);
    if (!link) return;
    const updatedAt = new Date().toISOString();
    const { requestHeaders = {}, ...entryContent } = content;
    if (link.turnId === id) this.turns.captureHeaders(link.turnId, requestHeaders);
    // An UPDATE preserves rowid and message references, unlike INSERT OR REPLACE.
    this.sqlite.prepare(`INSERT INTO request_logs (id, created_at, data_json, turn_id, request_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`).run(id, createdAt, JSON.stringify(options.keepLegacyHeaders ? content : entryContent), link.turnId, link.requestId, updatedAt);
    this.turns.touch(link.turnId, updatedAt);
    if (messages === undefined || link.turnId !== id || this.turns.resolve(id)?.scope) return;
    const messageIds = messages.map((text) => createHash("sha256").update(text).digest("hex"));
    const previousRefs = this.sqlite.prepare("SELECT message_id FROM request_log_message_refs WHERE log_id = ? ORDER BY position").all(id) as Array<{ message_id: string }>;
    if (previousRefs.length === messageIds.length && previousRefs.every((ref, index) => ref.message_id === messageIds[index])) return;
    this.sqlite.prepare("DELETE FROM request_log_message_refs WHERE log_id = ?").run(id);
    const insertMessage = this.sqlite.prepare("INSERT OR IGNORE INTO request_log_messages (id, content) VALUES (?, ?)");
    const insertRef = this.sqlite.prepare("INSERT INTO request_log_message_refs (log_id, position, message_id) VALUES (?, ?, ?)");
    messages.forEach((text, position) => {
      const messageId = messageIds[position];
      insertMessage.run(messageId, text);
      insertRef.run(id, position, messageId);
    });
  }

  get(id: string) { return this.turns.get(id); }

  list(limit: number, offset = 0, since?: string) { return this.turns.list(limit, offset, since); }

  associate(id: string, headers: Record<string, string>, body: unknown, clientScope: string) {
    const turnId = this.turns.associate(id, logRequestContext(headers, body, clientScope));
    this.turns.trim(this.retentionLimit);
    this.collectUnusedMessages();
    return turnId;
  }

  observe(id: string, observationId: string, responseIds: string[], tools: LogResponseTool[]) {
    this.turns.observe(id, observationId, responseIds, tools);
  }

  count() {
    return this.turns.count();
  }

  delete(id: string) {
    this.sqlite.transaction(() => {
      this.turns.delete(id);
      this.collectUnusedMessages();
    })();
  }

  clear() {
    this.sqlite.transaction(() => {
      this.turns.clear();
      this.collectUnusedMessages();
    })();
  }

  trim(limit: number) {
    this.retentionLimit = limit;
    this.sqlite.transaction(() => this.trimRows(limit))();
  }

  private trimRows(limit: number) {
    this.turns.trim(limit);
    this.collectUnusedMessages();
  }

  private collectUnusedMessages() {
    this.sqlite.prepare(`DELETE FROM request_log_messages WHERE NOT EXISTS
      (SELECT 1 FROM request_log_message_refs r WHERE r.message_id = request_log_messages.id)`).run();
  }

  private reclaimSpace() {
    // Replacing large legacy rows frees SQLite pages; VACUUM also returns those pages to disk.
    try {
      this.sqlite.exec("VACUUM");
      this.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    } catch (error) {
      console.warn("[logs] 日志已精简，数据库空间回收暂未完成：", error instanceof Error ? error.message : error);
    }
  }
}
