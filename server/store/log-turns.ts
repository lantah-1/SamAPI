import { createHash, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { RequestLog, RequestLogAttempt, RequestLogCall, RequestLogPhase, RequestLogResult, RequestLogSummary, RequestLogTool } from "../../shared/types.js";
import { legacyLogScope, logRequestContext, type LogRequestContext, type LogResponseTool } from "../log-context.js";
import { limitLogText } from "../log-content.js";

type Content = Pick<RequestLog, "kind" | "upstream" | "result"> & { requestHeaders?: RequestLog["requestHeaders"] };
type Entry = { id: string; created_at: string; updated_at: string; turn_id: string; request_id: string; is_root_request: number; data_json: string };
type Turn = { id: string; created_at: string; updated_at: string; revision: number; scope: string | null; root_message: number; request_headers_json: string | null };
type ToolRow = { id: string; request_id: string; result_request_id: string | null; call_id: string | null; name: string; created_at: string; updated_at: string; status: RequestLogTool["status"]; result: string };

function phase(status: RequestLogResult["status"], pendingTools: number): RequestLogPhase {
  return status === "pending" ? "running" : status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : pendingTools ? "waiting-tools" : "returned";
}

/** Logical turns own physical requests; each request keeps its own upstream attempts. */
export class RequestLogTurns {
  constructor(private readonly sqlite: Database) {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS request_log_turns (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        correlation_key TEXT UNIQUE, scope TEXT, root_message INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
        request_headers_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_request_log_turns_updated ON request_log_turns(updated_at);
      CREATE TABLE IF NOT EXISTS request_log_links (
        scope TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
        turn_id TEXT NOT NULL REFERENCES request_log_turns(id) ON DELETE CASCADE,
        PRIMARY KEY(scope, kind, value, turn_id)
      );
      CREATE TABLE IF NOT EXISTS request_log_tools (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES request_log_turns(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL, result_request_id TEXT, event_key TEXT NOT NULL, call_id TEXT, name TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL,
        UNIQUE(turn_id, request_id, event_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_request_log_tools_call ON request_log_tools(turn_id, call_id) WHERE call_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_request_log_tools_turn ON request_log_tools(turn_id);
    `);
    const turnColumns = new Set((this.sqlite.pragma("table_info(request_log_turns)") as Array<{ name: string }>).map((column) => column.name));
    if (!turnColumns.has("revision")) this.sqlite.exec("ALTER TABLE request_log_turns ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
    if (!turnColumns.has("request_headers_json")) this.sqlite.exec("ALTER TABLE request_log_turns ADD COLUMN request_headers_json TEXT");
    const columns = new Set((this.sqlite.pragma("table_info(request_logs)") as Array<{ name: string }>).map((column) => column.name));
    for (const [name, definition] of [
      ["turn_id", "TEXT REFERENCES request_log_turns(id) ON DELETE CASCADE"],
      ["request_id", "TEXT"], ["updated_at", "TEXT"], ["is_root_request", "INTEGER NOT NULL DEFAULT 0"]
    ]) if (!columns.has(name)) this.sqlite.exec(`ALTER TABLE request_logs ADD COLUMN ${name} ${definition}`);
    this.sqlite.exec("CREATE INDEX IF NOT EXISTS idx_request_logs_turn ON request_logs(turn_id, request_id)");
  }

  entry(id: string, createdAt: string, parentRequestId?: string) {
    const previous = this.sqlite.prepare("SELECT turn_id, request_id FROM request_logs WHERE id = ?").get(id) as Pick<Entry, "turn_id" | "request_id"> | undefined;
    if (previous?.turn_id) return { turnId: previous.turn_id, requestId: previous.request_id };
    if (parentRequestId) {
      const parent = this.sqlite.prepare("SELECT turn_id FROM request_logs WHERE id = ?").get(parentRequestId) as { turn_id: string } | undefined;
      // Clearing/retaining logs while an upstream is running must not recreate deleted turns.
      if (!parent) return undefined;
      return { turnId: parent.turn_id, requestId: parentRequestId };
    }
    this.sqlite.prepare("INSERT OR IGNORE INTO request_log_turns (id, created_at, updated_at) VALUES (?, ?, ?)").run(id, createdAt, createdAt);
    return { turnId: id, requestId: id };
  }

  touch(turnId: string, timestamp = new Date().toISOString()) {
    this.sqlite.prepare("UPDATE request_log_turns SET updated_at = ?, revision = revision + 1 WHERE id = ?").run(timestamp, turnId);
  }

  captureHeaders(turnId: string, headers: Record<string, string>) {
    // The first downstream request supplies the turn's headers; retries and continuations never replace them.
    this.sqlite.prepare("UPDATE request_log_turns SET request_headers_json = ? WHERE id = ? AND request_headers_json IS NULL")
      .run(JSON.stringify(headers), turnId);
  }

  resolve(id: string): Turn | undefined {
    return this.sqlite.prepare(`SELECT * FROM request_log_turns WHERE id = ? OR id =
      (SELECT turn_id FROM request_logs WHERE id = ?) LIMIT 1`).get(id, id) as Turn | undefined;
  }

  private message(id: string) {
    return (this.sqlite.prepare(`SELECT m.content FROM request_log_message_refs r JOIN request_log_messages m ON m.id = r.message_id
      WHERE r.log_id = ? ORDER BY r.position DESC LIMIT 1`).get(id) as { content: string } | undefined)?.content;
  }

  private setMessage(id: string, message: string) {
    const messageId = createHash("sha256").update(message).digest("hex");
    this.sqlite.prepare("INSERT OR IGNORE INTO request_log_messages (id, content) VALUES (?, ?)").run(messageId, message);
    this.sqlite.prepare("DELETE FROM request_log_message_refs WHERE log_id = ?").run(id);
    this.sqlite.prepare("INSERT INTO request_log_message_refs (log_id, position, message_id) VALUES (?, 0, ?)").run(id, messageId);
  }

  associate(id: string, context: LogRequestContext) {
    return this.sqlite.transaction(() => {
      let turn = this.resolve(id);
      if (!turn) return;
      // Clients can reuse turn/session headers when polling models. These operations
      // must not replace a conversation's input or final response.
      if (this.sqlite.prepare("SELECT 1 FROM request_logs WHERE id = ? AND json_extract(data_json, '$.kind') = 'models'").get(id)) return turn.id;
      if (context.isRootTurn) this.sqlite.prepare("UPDATE request_logs SET is_root_request = 1 WHERE id = ?").run(id);
      let target: Turn | undefined;
      if (context.correlationKey) {
        target = this.sqlite.prepare("SELECT * FROM request_log_turns WHERE correlation_key = ?").get(context.correlationKey) as Turn | undefined;
      } else {
        const matches = new Set<string>();
        const lookup = this.sqlite.prepare("SELECT turn_id FROM request_log_links WHERE scope = ? AND kind = ? AND value = ? LIMIT 2");
        for (const result of context.toolResults) if (result.callId) {
          for (const row of lookup.all(context.scope, "tool", result.callId) as Array<{ turn_id: string }>) matches.add(row.turn_id);
        }
        if (context.previousResponseId) for (const row of lookup.all(context.scope, "response", context.previousResponseId) as Array<{ turn_id: string }>) matches.add(row.turn_id);
        if (matches.size === 1) {
          const linked = this.resolve([...matches][0]);
          if (linked && (!context.currentMessage || context.currentMessage === this.message(linked.id))) target = linked;
        }
      }
      if (target && target.id !== turn.id) {
        this.sqlite.prepare("UPDATE request_logs SET turn_id = ? WHERE turn_id = ?").run(target.id, turn.id);
        this.sqlite.prepare("DELETE FROM request_log_message_refs WHERE log_id IN (SELECT id FROM request_logs WHERE turn_id = ? AND id != ?)").run(target.id, target.id);
        this.sqlite.prepare("DELETE FROM request_log_turns WHERE id = ?").run(turn.id);
        turn = target;
      }
      if (!target && context.correlationKey) this.sqlite.prepare("UPDATE request_log_turns SET correlation_key = ? WHERE id = ?").run(context.correlationKey, turn.id);
      this.sqlite.prepare("UPDATE request_log_turns SET scope = COALESCE(scope, ?) WHERE id = ?").run(context.scope, turn.id);
      if (context.currentMessage && (!this.message(turn.id) || (context.isRootTurn && !turn.root_message))) this.setMessage(turn.id, context.currentMessage);
      if (context.isRootTurn) this.sqlite.prepare("UPDATE request_log_turns SET root_message = 1 WHERE id = ?").run(turn.id);
      for (const result of context.toolResults) {
        const rows = result.callId
          ? this.sqlite.prepare("SELECT id FROM request_log_tools WHERE turn_id = ? AND call_id = ?").all(turn.id, result.callId) as Array<{ id: string }>
          : result.name ? this.sqlite.prepare("SELECT id FROM request_log_tools WHERE turn_id = ? AND name = ? AND status = 'pending' LIMIT 2").all(turn.id, result.name) as Array<{ id: string }> : [];
        const timestamp = new Date().toISOString();
        if (rows.length === 1) {
          const status = result.failed ? "failed" : "success";
          const text = limitLogText(result.text);
          this.sqlite.prepare("UPDATE request_log_tools SET result_request_id = ?, updated_at = ?, status = ?, result = ? WHERE id = ? AND (result_request_id IS NULL OR status != ? OR result != ?)")
            .run(id, timestamp, status, text, rows[0].id, status, text);
        } else {
          const eventKey = `result:${result.callId || createHash("sha256").update(`${result.name || ""}:${result.text}`).digest("hex")}`;
          this.sqlite.prepare(`INSERT OR IGNORE INTO request_log_tools
            (id, turn_id, request_id, result_request_id, event_key, call_id, name, created_at, updated_at, status, result)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(`tool-${randomUUID()}`, turn.id, id, id, eventKey, result.callId || null, result.name || "工具回传", timestamp, timestamp, result.failed ? "failed" : "success", limitLogText(result.text));
        }
      }
      this.touch(turn.id);
      return turn.id;
    })();
  }

  observe(id: string, observationId: string, responseIds: string[], tools: LogResponseTool[]) {
    const turn = this.resolve(id);
    if (!turn) return;
    this.sqlite.transaction(() => {
      const link = this.sqlite.prepare("INSERT OR IGNORE INTO request_log_links (scope, kind, value, turn_id) VALUES (?, ?, ?, ?)");
      if (turn.scope) for (const responseId of responseIds) link.run(turn.scope, "response", responseId, turn.id);
      for (const tool of tools) {
        if (turn.scope && tool.callId) link.run(turn.scope, "tool", tool.callId, turn.id);
        const timestamp = new Date().toISOString();
        const existing = tool.callId
          ? this.sqlite.prepare("SELECT id FROM request_log_tools WHERE turn_id = ? AND call_id = ?").get(turn.id, tool.callId) as { id: string } | undefined
          : undefined;
        if (existing) {
          this.sqlite.prepare("UPDATE request_log_tools SET name = ? WHERE id = ?").run(tool.name, existing.id);
        } else {
          this.sqlite.prepare(`INSERT INTO request_log_tools
            (id, turn_id, request_id, event_key, call_id, name, created_at, updated_at, status, result)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '')
            ON CONFLICT(turn_id, request_id, event_key) DO UPDATE SET name = excluded.name, call_id = COALESCE(excluded.call_id, request_log_tools.call_id)`)
            .run(`tool-${randomUUID()}`, turn.id, id, `${observationId}:${tool.key}`, tool.callId || null, tool.name, timestamp, timestamp, tool.completed ? "success" : "pending");
        }
      }
      if (tools.length) this.touch(turn.id);
    })();
  }

  interruptTools(requestId: string) {
    this.sqlite.prepare(`UPDATE request_log_tools SET status = 'cancelled', updated_at = ?, result = '所属接口调用未正常完成，尚未收到工具回传'
      WHERE request_id = ? AND status = 'pending'`).run(new Date().toISOString(), requestId);
  }

  migrate(groupLegacy: boolean) {
    this.sqlite.transaction(() => {
      let after = 0;
      while (true) {
        const entries = this.sqlite.prepare("SELECT rowid AS seq, * FROM request_logs WHERE rowid > ? ORDER BY rowid LIMIT 50").all(after) as Array<Entry & { seq: number }>;
        if (!entries.length) break;
        for (const entry of entries) {
          if (!entry.turn_id) {
            const link = this.entry(entry.id, entry.created_at)!;
            this.sqlite.prepare("UPDATE request_logs SET turn_id = ?, request_id = ?, updated_at = ? WHERE id = ?").run(link.turnId, link.requestId, entry.created_at, entry.id);
          }
          if (groupLegacy) {
            const content = JSON.parse(entry.data_json) as Content;
            const message = this.message(entry.id);
            if (message) this.setMessage(entry.id, message);
            const headers = content.requestHeaders || {};
            const scope = legacyLogScope(headers);
            if (scope) {
              const context = logRequestContext(headers, {}, scope);
              if (context.correlationKey) {
                const turnId = this.associate(entry.id, { ...context, currentMessage: message });
                const clientRequestId = headers["x-client-request-id"];
                if (turnId && clientRequestId && content.result.status === "failed") {
                  const parent = this.sqlite.prepare(`SELECT id FROM request_logs WHERE turn_id = ? AND id = request_id AND id != ?
                    AND created_at <= ? AND json_extract(data_json, '$.requestHeaders.x-client-request-id') = ? ORDER BY created_at, rowid LIMIT 1`)
                    .get(turnId, entry.id, entry.created_at, clientRequestId) as { id: string } | undefined;
                  if (parent) this.sqlite.prepare("UPDATE request_logs SET request_id = ? WHERE id = ?").run(parent.id, entry.id);
                }
              }
            }
          }
          after = entry.seq;
        }
      }
      if (groupLegacy) {
        this.sqlite.prepare("UPDATE request_logs SET updated_at = created_at").run();
        this.sqlite.prepare("UPDATE request_log_turns SET updated_at = (SELECT max(created_at) FROM request_logs WHERE turn_id = request_log_turns.id)").run();
      }
      // In-flight sockets do not survive a server restart. Preserve any captured partial result.
      const pending = this.sqlite.prepare("SELECT id, turn_id, data_json FROM request_logs WHERE json_extract(data_json, '$.result.status') = 'pending'").all() as Array<Pick<Entry, "id" | "turn_id" | "data_json">>;
      for (const entry of pending) {
        const content = JSON.parse(entry.data_json) as Content;
        content.result = { ...content.result, status: "cancelled", statusCode: 499, body: limitLogText(`${content.result.body}${content.result.body ? "\n\n" : ""}[服务已重启，该接口调用未记录完成结果]`) };
        delete content.result.stage;
        const timestamp = new Date().toISOString();
        this.sqlite.prepare("UPDATE request_logs SET data_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(content), timestamp, entry.id);
        this.interruptTools(entry.id);
        this.touch(entry.turn_id, timestamp);
      }
    })();
  }

  get(id: string): RequestLog | undefined {
    const turn = this.resolve(id);
    if (!turn) return;
    const entries = this.sqlite.prepare("SELECT * FROM request_logs WHERE turn_id = ? ORDER BY created_at, rowid").all(turn.id) as Entry[];
    const requests = entries.filter((entry) => entry.request_id === entry.id);
    if (!requests.length) return;
    const calls: RequestLogCall[] = requests.map((request) => {
      const content = JSON.parse(request.data_json) as Content;
      const attempts: RequestLogAttempt[] = entries.filter((entry) => entry.request_id === request.id && entry.id !== request.id).map((entry) => {
        const value = JSON.parse(entry.data_json) as Content;
        return { id: entry.id, createdAt: entry.created_at, updatedAt: entry.updated_at, upstream: value.upstream, result: value.result };
      });
      const previous = attempts.at(-1);
      const betweenAttempts = content.result.status === "pending" && ["receiving-request", "preparing-upstream", "waiting-retry"].includes(content.result.stage || "");
      if (content.upstream && !betweenAttempts && !(content.result.status === "failed" && previous && previous.upstream?.url === content.upstream.url && previous.result.statusCode === content.result.statusCode)) {
        attempts.push({ id: request.id, createdAt: request.created_at, updatedAt: request.updated_at, upstream: content.upstream, result: content.result });
      }
      return { id: request.id, createdAt: request.created_at, updatedAt: request.updated_at, result: { ...content.result, body: attempts.length ? "" : content.result.body }, attempts };
    });
    const tools = (this.sqlite.prepare("SELECT * FROM request_log_tools WHERE turn_id = ? ORDER BY created_at, rowid").all(turn.id) as ToolRow[]).map((tool): RequestLogTool => ({
      id: tool.id, requestId: tool.request_id, resultRequestId: tool.result_request_id || undefined, callId: tool.call_id || undefined,
      name: tool.name, createdAt: tool.created_at, updatedAt: tool.updated_at, status: tool.status, result: tool.result
    }));
    // A child request can start or finish after the main answer. Keep it in the chain,
    // but use the latest known main request as the standalone result when identifiable.
    const resultRequest = requests.filter((request) => request.is_root_request).at(-1) || requests.at(-1)!;
    const latest = JSON.parse(resultRequest.data_json) as Content;
    const currentIndex = requests.indexOf(resultRequest);
    const previousCall = calls.slice(0, currentIndex)
      .filter((call, index) => call.result.status !== "pending" && (!resultRequest.is_root_request || requests[index].is_root_request)).at(-1);
    const previousResult = latest.result.status === "pending"
      ? calls[currentIndex].attempts.filter((attempt) => attempt.result.status !== "pending").at(-1)
        || (previousCall && (previousCall.attempts.at(-1) || previousCall))
      : undefined;
    const pending = calls.some((call) => call.result.status === "pending");
    const result = { ...latest.result, ...(pending ? { status: "pending" as const } : {}) };
    const message = this.message(turn.id);
    return { id: turn.id, createdAt: turn.created_at, updatedAt: turn.updated_at, revision: turn.revision,
      ...(latest.kind ? { kind: latest.kind } : {}),
      requestHeaders: JSON.parse(turn.request_headers_json || "{}") as Record<string, string>, msg: message ? [message] : [], upstream: latest.upstream, result,
      ...(previousResult ? { previousResultId: previousResult.id } : {}),
      phase: phase(result.status, tools.filter((tool) => tool.status === "pending").length), calls, tools };
  }

  list(limit: number, offset = 0, since?: string): RequestLogSummary[] {
    const rows = this.sqlite.prepare(`SELECT t.id, t.created_at, t.updated_at, t.revision,
      json_extract(l.data_json, '$.kind') AS kind,
      (SELECT substr(m.content, 1, 200) FROM request_log_message_refs r JOIN request_log_messages m ON m.id = r.message_id WHERE r.log_id = t.id ORDER BY r.position DESC LIMIT 1) AS msg,
      json_extract(l.data_json, '$.upstream') AS upstream_json,
      json_extract(l.data_json, '$.result.status') AS status,
      json_extract(l.data_json, '$.result.stage') AS stage,
      json_extract(l.data_json, '$.result.statusCode') AS status_code,
      substr(json_extract(l.data_json, '$.result.body'), 1, 240) AS body,
      (SELECT count(*) FROM request_logs r WHERE r.turn_id = t.id AND r.request_id = r.id) AS requests,
      (SELECT count(*) FROM request_logs r WHERE r.turn_id = t.id AND json_extract(r.data_json, '$.upstream.url') IS NOT NULL
        AND (r.id != r.request_id OR json_extract(r.data_json, '$.result.status') != 'pending'
          OR COALESCE(json_extract(r.data_json, '$.result.stage'), '') NOT IN ('receiving-request', 'preparing-upstream', 'waiting-retry'))
        AND (r.id != r.request_id OR json_extract(r.data_json, '$.result.status') != 'failed'
          OR NOT EXISTS (SELECT 1 FROM request_logs a WHERE a.request_id = r.id AND a.id != r.id))) AS attempts,
      (SELECT count(*) FROM request_logs r WHERE r.turn_id = t.id AND r.request_id = r.id AND json_extract(r.data_json, '$.result.status') = 'pending') AS pending,
      (SELECT count(*) FROM request_log_tools r WHERE r.turn_id = t.id) AS tools,
      (SELECT count(*) FROM request_log_tools r WHERE r.turn_id = t.id AND r.status = 'pending') AS pending_tools
      FROM request_log_turns t JOIN request_logs l ON l.id =
        (SELECT id FROM request_logs WHERE turn_id = t.id AND id = request_id ORDER BY is_root_request DESC, created_at DESC, rowid DESC LIMIT 1)
      ${since ? "WHERE t.updated_at >= ?" : ""} ORDER BY t.updated_at DESC, t.rowid DESC LIMIT ? OFFSET ?`)
      .all(...(since ? [since, limit, offset] : [limit, offset])) as Array<{ id: string; created_at: string; updated_at: string; revision: number; kind: RequestLog["kind"] | null; msg: string | null; upstream_json: string | null; status: RequestLogResult["status"]; stage: RequestLogResult["stage"] | null; status_code: number; body: string; requests: number; attempts: number; pending: number; tools: number; pending_tools: number }>;
    return rows.map((row) => {
      const status = row.pending ? "pending" : row.status;
      return { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision, msg: row.msg || "", messageCount: row.msg ? 1 : 0,
        ...(row.kind ? { kind: row.kind } : {}),
        upstream: row.upstream_json ? JSON.parse(row.upstream_json) as RequestLog["upstream"] : undefined,
        result: { status, ...(row.stage ? { stage: row.stage } : {}), statusCode: row.status_code, body: row.body || "" }, phase: phase(status, row.pending_tools),
        requestCount: row.requests, attemptCount: row.attempts, toolCount: row.tools };
    });
  }

  count() { return (this.sqlite.prepare("SELECT count(*) AS count FROM request_log_turns").get() as { count: number }).count; }
  delete(id: string) { const turn = this.resolve(id); if (turn) this.sqlite.prepare("DELETE FROM request_log_turns WHERE id = ?").run(turn.id); }
  clear() { this.sqlite.prepare("DELETE FROM request_log_turns").run(); }
  trim(limit: number) {
    this.sqlite.prepare(`DELETE FROM request_log_turns WHERE id IN
      (SELECT id FROM request_log_turns ORDER BY updated_at DESC, rowid DESC LIMIT -1 OFFSET ?)
      AND NOT EXISTS (SELECT 1 FROM request_logs r WHERE r.turn_id = request_log_turns.id
        AND r.id = r.request_id AND json_extract(r.data_json, '$.result.status') = 'pending')`).run(limit);
  }
}
