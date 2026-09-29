import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { ModelPrice, ModelPriceInput, ModelPriceRates, ModelPriceSyncState, OfficialModelPrice, TokenUsage, UsageEstimationResult, UsageFilters, UsageRecordInput, UsageReport, UsageTotals } from "../../shared/usage.js";
import { normalizeServiceTier } from "../../shared/usage.js";
import { estimateTextTokens } from "../usage-estimate.js";

const rateFields = ["inputUsdPerMillion", "cachedInputUsdPerMillion", "cacheWriteUsdPerMillion", "cacheWriteLongUsdPerMillion", "outputUsdPerMillion"] as const;
type UsageSample = { input_tokens: number; output_tokens: number; cached_input_tokens: number; cache_write_input_tokens: number; cache_write_long_input_tokens: number };
const sampleColumns = "input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens, cache_write_long_input_tokens";
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function applyCacheEstimate(usage: TokenUsage, samples: UsageSample[]) {
  usage.cachedInputTokens = Math.min(usage.inputTokens, Math.round(usage.inputTokens * median(samples.map((sample) => sample.cached_input_tokens / sample.input_tokens))));
  usage.cacheWriteInputTokens = Math.min(usage.inputTokens - usage.cachedInputTokens, Math.round(usage.inputTokens * median(samples.map((sample) => sample.cache_write_input_tokens / sample.input_tokens))));
  usage.cacheWriteLongInputTokens = Math.min(usage.cacheWriteInputTokens, Math.round(usage.inputTokens * median(samples.map((sample) => sample.cache_write_long_input_tokens / sample.input_tokens))));
}

export function validatePrice(input: ModelPriceInput): ModelPriceInput {
  if (!input || typeof input.model !== "string" || !input.model.trim() || input.model.length > 200) throw new Error("请填写准确的上游模型名称");
  if (typeof input.providerId !== "string" || input.providerId.length > 200) throw new Error("供应商无效");
  for (const field of rateFields) {
    const rate = input[field];
    if ((field === "cacheWriteUsdPerMillion" || field === "cacheWriteLongUsdPerMillion") && rate === undefined) continue;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 100000 || Math.abs(rate * 1e6 - Math.round(rate * 1e6)) > 0.0001) {
      throw new Error("单价须为 0–100000 之间的数字，最多六位小数");
    }
  }
  return { providerId: input.providerId.trim(), model: input.model.trim(), inputUsdPerMillion: input.inputUsdPerMillion, cachedInputUsdPerMillion: input.cachedInputUsdPerMillion, cacheWriteUsdPerMillion: input.cacheWriteUsdPerMillion, cacheWriteLongUsdPerMillion: input.cacheWriteLongUsdPerMillion, outputUsdPerMillion: input.outputUsdPerMillion };
}

export function validateUsageFilters(filters: UsageFilters) {
  const from = filters.from ? new Date(filters.from) : undefined;
  const to = filters.to ? new Date(filters.to) : undefined;
  if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime()))) throw new Error("用量查询日期无效");
  if (from && to && from >= to) throw new Error("结束日期必须晚于开始日期");
  const offset = filters.timezoneOffsetMinutes ?? 0;
  if (!Number.isInteger(offset) || Math.abs(offset) > 840) throw new Error("时区偏移无效");
  return { from: from?.toISOString(), to: to?.toISOString(), offset };
}

function normalizedUsage(usage: TokenUsage): TokenUsage {
  for (const value of [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("上游 Token 用量无效");
  }
  if (usage.cachedInputTokens + usage.cacheWriteInputTokens > usage.inputTokens || !Number.isSafeInteger(usage.inputTokens + usage.outputTokens)) throw new Error("上游 Token 用量无效");
  if (usage.cacheWriteLongInputTokens !== undefined && (!Number.isSafeInteger(usage.cacheWriteLongInputTokens) || usage.cacheWriteLongInputTokens < 0 || usage.cacheWriteLongInputTokens > usage.cacheWriteInputTokens)) throw new Error("上游缓存写入用量无效");
  return { ...usage, totalTokens: usage.inputTokens + usage.outputTokens };
}

/** Fixed-point nano-USD; round once after summing all token categories. */
export function usageCostNano(usage: TokenUsage, price: ModelPriceInput & Partial<ModelPrice>, createdAt = new Date().toISOString(), cacheMode?: UsageRecordInput["cacheMode"], serviceTier?: string): bigint | null {
  const tier = normalizeServiceTier(serviceTier);
  // Manual prices are deliberately flat overrides. Official nonstandard tiers
  // need their own published rates; an unknown tier must never use standard rates.
  const schedule = !tier || tier === "default" || (!price.source && !price.serviceTiers) ? price
    : price.serviceTiers && Object.hasOwn(price.serviceTiers, tier) ? price.serviceTiers[tier] : undefined;
  if (!schedule || (schedule.maxInputTokens !== undefined && usage.inputTokens > schedule.maxInputTokens)) return null;
  const at = new Date(createdAt);
  if (!Number.isFinite(at.getTime())) return null;
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  let rates: ModelPriceRates = schedule;
  for (const rule of schedule.rules || []) {
    if (rule.aboveInputTokens !== undefined && usage.inputTokens <= rule.aboveInputTokens) continue;
    if (rule.effectiveFrom && at.getTime() < Date.parse(rule.effectiveFrom)) continue;
    if (rule.effectiveUntil && at.getTime() >= Date.parse(rule.effectiveUntil)) continue;
    if (rule.weekdaysUtc && !rule.weekdaysUtc.includes(at.getUTCDay())) continue;
    if (rule.startMinuteUtc !== undefined && minute < rule.startMinuteUtc) continue;
    if (rule.endMinuteUtc !== undefined && minute >= rule.endMinuteUtc) continue;
    rates = rule;
  }
  const cachedRate = price.cacheReadRequiresMode && cacheMode === "explicit" ? rates.explicitCachedInputUsdPerMillion
    : (price.cacheReadRequiresMode && !cacheMode) || rates.cacheReadUnavailable ? undefined : rates.cachedInputUsdPerMillion;
  if (usage.cachedInputTokens > 0 && cachedRate === undefined) return null;
  const longWrites = usage.cacheWriteLongInputTokens || 0;
  if (usage.cacheWriteInputTokens > longWrites && rates.cacheWriteUsdPerMillion === undefined) return null;
  if (longWrites > 0 && rates.cacheWriteLongUsdPerMillion === undefined) return null;
  const entries = [
    [usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens, rates.inputUsdPerMillion],
    [usage.cachedInputTokens, cachedRate ?? 0],
    [usage.cacheWriteInputTokens - longWrites, rates.cacheWriteUsdPerMillion ?? 0],
    [longWrites, rates.cacheWriteLongUsdPerMillion ?? 0],
    [usage.outputTokens, rates.outputUsdPerMillion]
  ];
  const micros = entries.reduce((sum, [tokens, rate]) => sum + BigInt(tokens) * BigInt(Math.round(rate * 1e6)), 0n);
  const nano = (micros + 500n) / 1000n;
  return nano <= 9223372036854775807n ? nano : null;
}

const totalsSql = `COUNT(*) AS requests, COUNT(DISTINCT request_id) AS downstreamRequests,
  COALESCE(SUM(status_code >= 400), 0) AS failedRequests,
  COALESCE(SUM(input_tokens IS NOT NULL AND estimation_json IS NULL), 0) AS reportedRequests,
  COALESCE(SUM(input_tokens IS NOT NULL AND estimation_json IS NOT NULL), 0) AS estimatedRequests,
  COALESCE(SUM(json_extract(estimation_json, '$.method') IN ('same-request', 'historical')), 0) AS historicalEstimatedRequests,
  COALESCE(SUM(CASE WHEN estimation_json IS NOT NULL AND COALESCE(json_extract(estimation_json, '$.inputEstimated'), 1) THEN input_tokens ELSE 0 END), 0) AS estimatedInputTokens,
  COALESCE(SUM(CASE WHEN estimation_json IS NOT NULL AND COALESCE(json_extract(estimation_json, '$.outputEstimated'), 1) THEN output_tokens ELSE 0 END), 0) AS estimatedOutputTokens,
  COALESCE(SUM(CASE WHEN json_extract(estimation_json, '$.cacheEstimated') THEN cached_input_tokens ELSE 0 END), 0) AS estimatedCachedInputTokens,
  COALESCE(SUM(CASE WHEN estimation_json IS NOT NULL THEN
    CASE WHEN COALESCE(json_extract(estimation_json, '$.inputEstimated'), 1) THEN input_tokens ELSE 0 END +
    CASE WHEN COALESCE(json_extract(estimation_json, '$.outputEstimated'), 1) THEN output_tokens ELSE 0 END ELSE 0 END), 0) AS estimatedTotalTokens,
  COALESCE(SUM(CASE WHEN estimation_json IS NOT NULL THEN cost_nano / 1000000000.0 ELSE 0 END), 0) AS estimatedUsageCostUsd,
  COALESCE(SUM(finalized = 0), 0) AS pendingRequests,
  COALESCE(SUM(input_tokens IS NULL AND finalized = 1), 0) AS missingUsageRequests,
  COALESCE(SUM(input_tokens IS NOT NULL AND cost_nano IS NULL), 0) AS unpricedRequests,
  COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens, COALESCE(SUM(cache_write_input_tokens), 0) AS cacheWriteInputTokens,
  COALESCE(SUM(input_tokens + output_tokens), 0) AS totalTokens,
  COALESCE(SUM(cost_nano / 1000000000.0), 0) AS estimatedCostUsd`;

export class UsageStore {
  constructor(private readonly sql: Database) {
    sql.exec(`CREATE TABLE IF NOT EXISTS model_prices (
      id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model TEXT NOT NULL, data_json TEXT NOT NULL,
      UNIQUE(provider_id, model)
    );
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, api_key_id TEXT NOT NULL, api_key_name TEXT NOT NULL,
      provider_id TEXT NOT NULL, provider_name TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL,
      status_code INTEGER NOT NULL, input_tokens INTEGER, cached_input_tokens INTEGER, cache_write_input_tokens INTEGER,
      output_tokens INTEGER, cost_nano INTEGER, price_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_records(created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_client_created ON usage_records(api_key_id, created_at);
    CREATE TABLE IF NOT EXISTS model_price_sync (source_id TEXT PRIMARY KEY, data_json TEXT NOT NULL);`);
    const columns = sql.prepare("PRAGMA table_info(usage_records)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "cache_write_long_input_tokens")) sql.exec("ALTER TABLE usage_records ADD COLUMN cache_write_long_input_tokens INTEGER NOT NULL DEFAULT 0");
    if (!columns.some((column) => column.name === "cache_mode")) sql.exec("ALTER TABLE usage_records ADD COLUMN cache_mode TEXT");
    if (!columns.some((column) => column.name === "estimation_json")) sql.exec("ALTER TABLE usage_records ADD COLUMN estimation_json TEXT");
    if (!columns.some((column) => column.name === "finalized")) sql.exec("ALTER TABLE usage_records ADD COLUMN finalized INTEGER NOT NULL DEFAULT 1");
    if (!columns.some((column) => column.name === "service_tier")) sql.exec("ALTER TABLE usage_records ADD COLUMN service_tier TEXT");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_usage_request ON usage_records(request_id, created_at); CREATE INDEX IF NOT EXISTS idx_usage_client_model_created ON usage_records(api_key_id, model, created_at)");
  }

  listPrices(): ModelPrice[] {
    return (this.sql.prepare("SELECT data_json FROM model_prices ORDER BY model, provider_id").all() as Array<{ data_json: string }>).map((row) => JSON.parse(row.data_json) as ModelPrice);
  }

  savePrice(input: ModelPriceInput): ModelPrice {
    const value = validatePrice(input);
    const current = this.sql.prepare("SELECT id FROM model_prices WHERE provider_id = ? AND model = ?").get(value.providerId, value.model) as { id: string } | undefined;
    const price: ModelPrice = { ...value, id: current?.id || `price-${randomUUID()}`, updatedAt: new Date().toISOString() };
    this.sql.prepare(`INSERT INTO model_prices (id, provider_id, model, data_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(provider_id, model) DO UPDATE SET data_json = excluded.data_json`).run(price.id, price.providerId, price.model, JSON.stringify(price));
    return price;
  }

  deletePrice(id: string) { this.sql.prepare("DELETE FROM model_prices WHERE id = ?").run(id); }

  priceSyncStates(): ModelPriceSyncState[] {
    return (this.sql.prepare("SELECT data_json FROM model_price_sync ORDER BY source_id").all() as Array<{ data_json: string }>).map((row) => JSON.parse(row.data_json));
  }

  savePriceSyncState(state: ModelPriceSyncState) {
    this.sql.prepare("INSERT INTO model_price_sync (source_id, data_json) VALUES (?, ?) ON CONFLICT(source_id) DO UPDATE SET data_json = excluded.data_json").run(state.id, JSON.stringify(state));
  }

  saveOfficialPrices(prices: OfficialModelPrice[], state: ModelPriceSyncState) {
    // Validate the complete response before changing any live prices.
    for (const price of prices) {
      validatePrice(price);
      if (price.source.id !== state.id || price.providerId !== "") throw new Error("官方价格来源无效");
      for (const tier of Object.keys(price.serviceTiers || {})) if (normalizeServiceTier(tier) !== tier || ["auto", "default", "standard"].includes(tier)) throw new Error("官方服务档位无效");
      for (const schedule of [price, ...Object.values(price.serviceTiers || {})]) {
        validatePrice({ ...schedule, model: price.model, providerId: "" });
        for (const rates of [schedule, ...(schedule.rules || [])]) {
          if (rates.explicitCachedInputUsdPerMillion !== undefined) validatePrice({ ...price, inputUsdPerMillion: rates.explicitCachedInputUsdPerMillion });
        }
        if (schedule.maxInputTokens !== undefined && (!Number.isSafeInteger(schedule.maxInputTokens) || schedule.maxInputTokens <= 0)) throw new Error("官方上下文上限无效");
        for (const rule of schedule.rules || []) {
          validatePrice({ ...rule, model: price.model, providerId: "" });
          if (rule.aboveInputTokens !== undefined && (!Number.isSafeInteger(rule.aboveInputTokens) || rule.aboveInputTokens < 0)) throw new Error("官方长上下文阈值无效");
          if (rule.weekdaysUtc && (!rule.weekdaysUtc.length || rule.weekdaysUtc.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) throw new Error("官方分时计费日期无效");
          if ((rule.startMinuteUtc === undefined) !== (rule.endMinuteUtc === undefined)
            || (rule.startMinuteUtc !== undefined && (!Number.isInteger(rule.startMinuteUtc) || rule.startMinuteUtc < 0 || !Number.isInteger(rule.endMinuteUtc) || rule.endMinuteUtc! > 1440 || rule.startMinuteUtc >= rule.endMinuteUtc!))) throw new Error("官方分时计费时间无效");
          if ([rule.effectiveFrom, rule.effectiveUntil].some((value) => value !== undefined && !Number.isFinite(Date.parse(value)))
            || (rule.effectiveFrom && rule.effectiveUntil && Date.parse(rule.effectiveFrom) >= Date.parse(rule.effectiveUntil))) throw new Error("官方价格生效时间无效");
        }
      }
    }
    return this.sql.transaction(() => {
      const current = new Map(this.listPrices().filter((price) => price.providerId === "").map((price) => [price.model, price]));
      // An official page can stop listing retired models or change only part of its layout.
      // Keep their last known prices and timestamps until an explicit replacement arrives.
      const insert = this.sql.prepare("INSERT INTO model_prices (id, provider_id, model, data_json) VALUES (?, '', ?, ?) ON CONFLICT(provider_id, model) DO UPDATE SET data_json = excluded.data_json");
      for (const value of prices) {
        const previous = current.get(value.model);
        if (previous && !previous.source) continue;
        if (previous?.source && previous.source.id !== value.source.id) continue;
        const price: ModelPrice = { ...value, id: previous?.id || `price-${randomUUID()}`, updatedAt: state.lastSuccessAt! };
        insert.run(price.id, price.model, JSON.stringify(price));
      }
      this.savePriceSyncState(state);
    })();
  }

  private findPrice(providerId: string, model: string): ModelPrice | undefined {
    const row = this.sql.prepare("SELECT data_json FROM model_prices WHERE model = ? AND provider_id IN (?, '') ORDER BY (provider_id = ?) DESC LIMIT 1").get(model, providerId, providerId) as { data_json: string } | undefined;
    if (row) return JSON.parse(row.data_json) as ModelPrice;
    const normalized = model.toLowerCase().replace(/^(?:openai|anthropic|google|deepseek-ai|minimaxai|moonshotai|z-ai|智谱|qwen|stepfun-ai|xiaomi)\//, "");
    const candidates = [normalized];
    // Dated Claude snapshots share their exact model family's published price.
    if (/^claude-/.test(normalized)) candidates.push(normalized.replace(/-\d{8}$/, ""));
    for (const candidate of candidates) {
      const canonical = this.sql.prepare("SELECT data_json FROM model_prices WHERE model = ? COLLATE NOCASE AND provider_id IN (?, '') ORDER BY (provider_id = ?) DESC LIMIT 1").get(candidate, providerId, providerId) as { data_json: string } | undefined;
      if (canonical) return JSON.parse(canonical.data_json) as ModelPrice;
    }
    return undefined;
  }

  private nearbySamples(input: Pick<UsageRecordInput, "apiKeyId" | "providerId" | "model" | "createdAt" | "cacheMode">, inputTokens?: number): UsageSample[] {
    const at = Date.parse(input.createdAt);
    if (!Number.isFinite(at)) return [];
    const where = `api_key_id = ? AND provider_id = ? AND model = ? AND COALESCE(cache_mode, 'implicit') = ?
      AND input_tokens > 0 AND estimation_json IS NULL AND status_code < 400 AND finalized = 1
      AND created_at >= ? AND created_at <= ? AND input_tokens >= ? AND input_tokens <= ?`;
    const params = [input.apiKeyId, input.providerId, input.model, input.cacheMode || "implicit",
      new Date(at - 86400000).toISOString(), new Date(at + 86400000).toISOString(), inputTokens === undefined ? 0 : inputTokens / 2, inputTokens === undefined ? Number.MAX_SAFE_INTEGER : inputTokens * 2];
    return this.sql.prepare(`SELECT ${sampleColumns} FROM (SELECT ${sampleColumns} FROM usage_records WHERE ${where} AND created_at <= ? ORDER BY created_at DESC LIMIT 10)
      UNION ALL SELECT ${sampleColumns} FROM (SELECT ${sampleColumns} FROM usage_records WHERE ${where} AND created_at > ? ORDER BY created_at LIMIT 10)`)
      .all(...params, input.createdAt, ...params, input.createdAt) as UsageSample[];
  }

  record(input: UsageRecordInput) {
    this.sql.transaction(() => {
      const existing = this.sql.prepare("SELECT price_json, created_at, cache_mode, service_tier, input_tokens, estimation_json FROM usage_records WHERE id = ?").get(input.id) as { price_json: string | null; created_at: string; cache_mode: UsageRecordInput["cacheMode"] | null; service_tier: string | null; input_tokens: number | null; estimation_json: string | null } | undefined;
      const price = existing ? (existing.price_json ? JSON.parse(existing.price_json) as ModelPrice : undefined) : this.findPrice(input.providerId, input.model);
      const preserveReported = existing?.input_tokens != null && !existing.estimation_json && Boolean(input.estimation);
      const usage = input.usage && !preserveReported ? normalizedUsage(input.usage) : undefined;
      let estimation = input.estimation;
      if (usage?.inputTokens && estimation?.cacheUsageMissing) {
        const reference = this.nearbySamples(input, usage.inputTokens);
        if (reference.length >= 3) {
          applyCacheEstimate(usage, reference);
          estimation = { ...estimation, cacheUsageMissing: false, cacheEstimated: true, cacheSampleCount: reference.length };
        }
      }
      const serviceTier = normalizeServiceTier(input.serviceTier) ?? existing?.service_tier ?? undefined;
      const cost = usage?.totalTokens === 0 ? 0n : usage && price && !(usage.inputTokens > 0 && estimation?.cacheUsageMissing)
        ? usageCostNano(usage, price, existing?.created_at || input.createdAt, existing ? existing.cache_mode ?? undefined : input.cacheMode, serviceTier) : null;
      this.sql.prepare(`INSERT INTO usage_records (id, request_id, api_key_id, api_key_name, provider_id, provider_name, model, created_at, status_code,
        input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, cost_nano, price_json, cache_write_long_input_tokens, cache_mode, estimation_json, finalized, service_tier)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET finalized = MAX(finalized, excluded.finalized),
          status_code = CASE WHEN excluded.finalized = 1 THEN excluded.status_code ELSE status_code END`)
        .run(input.id, input.requestId, input.apiKeyId, input.apiKeyName, input.providerId, input.providerName, input.model, input.createdAt, input.statusCode,
          usage?.inputTokens ?? null, usage?.cachedInputTokens ?? null, usage?.cacheWriteInputTokens ?? null, usage?.outputTokens ?? null, cost, price ? JSON.stringify(price) : null, usage?.cacheWriteLongInputTokens || 0, input.cacheMode ?? null,
          estimation && usage ? JSON.stringify(estimation) : null, input.finalized === false ? 0 : 1, serviceTier ?? null);
      // A late real usage report replaces an estimate, including its cost. Incomplete
      // saves and subsequent estimates can never erase or downgrade reported counts.
      if (existing && usage) this.sql.prepare(`UPDATE usage_records SET input_tokens = ?, cached_input_tokens = ?, cache_write_input_tokens = ?,
        cache_write_long_input_tokens = ?, output_tokens = ?, cost_nano = ?, estimation_json = ? WHERE id = ?`)
        .run(usage.inputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens, usage.cacheWriteLongInputTokens || 0, usage.outputTokens, cost, estimation ? JSON.stringify(estimation) : null, input.id);
      if (existing && !preserveReported && (usage || existing.input_tokens === null) && input.finalized !== false && serviceTier) {
        this.sql.prepare("UPDATE usage_records SET service_tier = ? WHERE id = ?").run(serviceTier, input.id);
      }
    })();
  }

  estimateMissingRecords(filters: UsageFilters = {}): UsageEstimationResult {
    const { from, to } = validateUsageFilters(filters);
    const conditions = ["input_tokens IS NULL", "finalized = 1"];
    const parameters: string[] = [];
    if (filters.apiKeyId) { conditions.push("api_key_id = ?"); parameters.push(filters.apiKeyId); }
    if (from) { conditions.push("created_at >= ?"); parameters.push(from); }
    if (to) { conditions.push("created_at < ?"); parameters.push(to); }
    const where = conditions.join(" AND ");
    const hasLogs = Boolean(this.sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_logs'").get());
    const sibling = this.sql.prepare(`SELECT ${sampleColumns} FROM usage_records WHERE request_id = ? AND api_key_id = ? AND provider_id = ? AND model = ?
      AND input_tokens > 0 AND estimation_json IS NULL AND finalized = 1 AND status_code < 400 ORDER BY created_at DESC LIMIT 1`);
    const later = this.sql.prepare("SELECT 1 FROM usage_records WHERE request_id = ? AND created_at > ? LIMIT 1");
    const select = this.sql.prepare(`SELECT id, request_id AS requestId, api_key_id AS apiKeyId, api_key_name AS apiKeyName, provider_id AS providerId,
      provider_name AS providerName, model, created_at AS createdAt, status_code AS statusCode, cache_mode AS cacheMode, service_tier AS serviceTier
      FROM usage_records WHERE ${where} AND id > ? ORDER BY id LIMIT 500`);
    let updated = 0;
    let cursor = "";
    while (true) {
      const rows = select.all(...parameters, cursor) as UsageRecordInput[];
      if (!rows.length) break;
      this.sql.transaction(() => {
        for (const row of rows) {
          const logRow = hasLogs ? this.sql.prepare("SELECT data_json FROM request_logs WHERE id = ?").get(row.requestId) as { data_json: string } | undefined : undefined;
          const log = logRow ? JSON.parse(logRow.data_json) as { result?: { status?: string; body?: string; streamStartedWith?: string }; upstream?: { provider?: string; model?: string } } : undefined;
          if (log?.result?.status === "pending") continue;
          let inputTokens: number;
          let outputTokens: number;
          let estimation: NonNullable<UsageRecordInput["estimation"]>;
          let cacheReference: UsageSample[] = [];
          if (row.statusCode >= 400) {
            // Historical rejected requests have no retained generation evidence.
            // Zero is explicitly an estimate, never a claim about the provider's bill.
            inputTokens = 0; outputTokens = 0; estimation = { method: "rejected" };
          } else {
            const sameRequest = sibling.get(row.requestId, row.apiKeyId, row.providerId, row.model) as UsageSample | undefined;
            const reference = this.nearbySamples(row);
            if (!sameRequest && !reference.length) continue;
            inputTokens = sameRequest?.input_tokens ?? Math.round(median(reference.map((item) => item.input_tokens)));
            const isLast = !later.get(row.requestId, row.createdAt);
            const matchingLog = isLast && log?.upstream?.provider === row.providerName && log.upstream.model === row.model ? log.result : undefined;
            if (matchingLog?.status === "success" && matchingLog.body && !matchingLog.body.includes("内容已截断")) outputTokens = estimateTextTokens(matchingLog.body, row.model);
            else if (!isLast || (matchingLog && ["failed", "cancelled"].includes(matchingLog.status || "") && !matchingLog.streamStartedWith)) outputTokens = 0;
            else outputTokens = reference.length ? Math.round(median(reference.map((item) => item.output_tokens))) : sameRequest!.output_tokens;
            cacheReference = sameRequest ? [sameRequest] : reference;
            estimation = { method: sameRequest ? "same-request" : "historical", sampleCount: sameRequest ? 1 : reference.length, cacheEstimated: true, cacheSampleCount: cacheReference.length };
          }
          const usage = { inputTokens, outputTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalTokens: inputTokens + outputTokens };
          if (cacheReference.length) applyCacheEstimate(usage, cacheReference);
          this.record({ ...row, finalized: true, estimation, usage });
          updated++;
        }
      })();
      cursor = rows.at(-1)!.id;
    }
    const remaining = (this.sql.prepare(`SELECT count(*) AS count FROM usage_records WHERE ${where}`).get(...parameters) as { count: number }).count;
    return { updated, remaining };
  }

  recoverInterruptedRecords() {
    // Request-log startup recovery runs first. Do not leave interrupted attempts
    // labelled as live forever, and do not touch requests that are still pending.
    this.sql.prepare(`UPDATE usage_records SET finalized = 1 WHERE finalized = 0 AND NOT EXISTS
      (SELECT 1 FROM request_logs l WHERE l.id = usage_records.request_id AND json_extract(l.data_json, '$.result.status') = 'pending')`).run();
  }

  /** Deliberately only fills unpriced records; previously priced bills are immutable. */
  priceUnpricedRecords(): number {
    return this.sql.transaction(() => {
      let changed = 0;
      const select = this.sql.prepare(`SELECT id, provider_id, model, created_at, cache_mode, service_tier, input_tokens, cached_input_tokens, cache_write_input_tokens, cache_write_long_input_tokens, output_tokens FROM usage_records WHERE id > ? AND input_tokens IS NOT NULL AND cost_nano IS NULL
        AND NOT COALESCE(json_extract(estimation_json, '$.cacheUsageMissing'), 0) ORDER BY id LIMIT 500`);
      const update = this.sql.prepare("UPDATE usage_records SET cost_nano = ?, price_json = ? WHERE id = ?");
      let cursor = "";
      while (true) {
        const rows = select.all(cursor) as Array<{ id: string; provider_id: string; model: string; created_at: string; cache_mode: UsageRecordInput["cacheMode"] | null; service_tier: string | null; input_tokens: number; cached_input_tokens: number; cache_write_input_tokens: number; cache_write_long_input_tokens: number; output_tokens: number }>;
        if (!rows.length) break;
        for (const row of rows) {
          const price = this.findPrice(row.provider_id, row.model);
          if (!price) continue;
          const usage = { inputTokens: row.input_tokens, cachedInputTokens: row.cached_input_tokens, cacheWriteInputTokens: row.cache_write_input_tokens, cacheWriteLongInputTokens: row.cache_write_long_input_tokens, outputTokens: row.output_tokens, totalTokens: row.input_tokens + row.output_tokens };
          const cost = usageCostNano(usage, price, row.created_at, row.cache_mode ?? undefined, row.service_tier ?? undefined);
          if (cost === null) continue;
          update.run(cost, JSON.stringify(price), row.id);
          changed++;
        }
        cursor = rows[rows.length - 1].id;
      }
      return changed;
    })();
  }

  report(filters: UsageFilters = {}, activeKeys: Array<{ id: string; name: string; prefix?: string }> = []): UsageReport {
    const { from, to, offset } = validateUsageFilters(filters);
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (filters.apiKeyId) { conditions.push("api_key_id = ?"); parameters.push(filters.apiKeyId); }
    if (from) { conditions.push("created_at >= ?"); parameters.push(from); }
    if (to) { conditions.push("created_at < ?"); parameters.push(to); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const totals = this.sql.prepare(`SELECT ${totalsSql} FROM usage_records ${where}`).get(...parameters) as UsageTotals;
    const clients = this.sql.prepare(`SELECT api_key_id AS apiKeyId, MAX(api_key_name) AS apiKeyName, ${totalsSql} FROM usage_records ${where} GROUP BY api_key_id ORDER BY totalTokens DESC`).all(...parameters) as UsageReport["clients"];
    const models = this.sql.prepare(`SELECT provider_id AS providerId, MAX(provider_name) AS providerName, model, ${totalsSql} FROM usage_records ${where} GROUP BY provider_id, model ORDER BY totalTokens DESC`).all(...parameters) as UsageReport["models"];
    const daily = this.sql.prepare(`SELECT date(created_at, ?) AS date, ${totalsSql} FROM usage_records ${where} GROUP BY date ORDER BY date DESC`).all(`${offset} minutes`, ...parameters) as UsageReport["daily"];
    const keys = new Map((this.sql.prepare("SELECT api_key_id AS id, MAX(api_key_name) AS name FROM usage_records GROUP BY api_key_id").all() as UsageReport["keys"]).map((key) => [key.id, key]));
    for (const key of activeKeys) keys.set(key.id, { id: key.id, name: key.name, prefix: key.prefix });
    for (const client of clients) client.apiKeyName = keys.get(client.apiKeyId)?.name || client.apiKeyName;
    return { totals, clients, models, daily, keys: [...keys.values()] };
  }
}
