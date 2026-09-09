import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { ModelPrice, ModelPriceInput, ModelPriceRates, ModelPriceSyncState, OfficialModelPrice, TokenUsage, UsageFilters, UsageRecordInput, UsageReport, UsageTotals } from "../../shared/usage.js";

const rateFields = ["inputUsdPerMillion", "cachedInputUsdPerMillion", "cacheWriteUsdPerMillion", "cacheWriteLongUsdPerMillion", "outputUsdPerMillion"] as const;

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
export function usageCostNano(usage: TokenUsage, price: ModelPriceInput & Partial<ModelPrice>, createdAt = new Date().toISOString(), cacheMode?: UsageRecordInput["cacheMode"]): bigint | null {
  if (price.maxInputTokens !== undefined && usage.inputTokens > price.maxInputTokens) return null;
  const at = new Date(createdAt);
  if (!Number.isFinite(at.getTime())) return null;
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  let rates: ModelPriceRates = price;
  for (const rule of price.rules || []) {
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
  COUNT(input_tokens) AS reportedRequests, COUNT(*) - COUNT(input_tokens) AS missingUsageRequests,
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
      for (const rates of [price, ...(price.rules || [])]) {
        if (rates.explicitCachedInputUsdPerMillion !== undefined) validatePrice({ ...price, inputUsdPerMillion: rates.explicitCachedInputUsdPerMillion });
      }
      if (price.maxInputTokens !== undefined && (!Number.isSafeInteger(price.maxInputTokens) || price.maxInputTokens <= 0)) throw new Error("官方上下文上限无效");
      for (const rule of price.rules || []) {
        validatePrice({ ...rule, model: price.model, providerId: "" });
        if (rule.aboveInputTokens !== undefined && (!Number.isSafeInteger(rule.aboveInputTokens) || rule.aboveInputTokens < 0)) throw new Error("官方长上下文阈值无效");
        if (rule.weekdaysUtc && (!rule.weekdaysUtc.length || rule.weekdaysUtc.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) throw new Error("官方分时计费日期无效");
        if ((rule.startMinuteUtc === undefined) !== (rule.endMinuteUtc === undefined)
          || (rule.startMinuteUtc !== undefined && (!Number.isInteger(rule.startMinuteUtc) || rule.startMinuteUtc < 0 || !Number.isInteger(rule.endMinuteUtc) || rule.endMinuteUtc! > 1440 || rule.startMinuteUtc >= rule.endMinuteUtc!))) throw new Error("官方分时计费时间无效");
        if ([rule.effectiveFrom, rule.effectiveUntil].some((value) => value !== undefined && !Number.isFinite(Date.parse(value)))
          || (rule.effectiveFrom && rule.effectiveUntil && Date.parse(rule.effectiveFrom) >= Date.parse(rule.effectiveUntil))) throw new Error("官方价格生效时间无效");
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

  record(input: UsageRecordInput) {
    this.sql.transaction(() => {
      const existing = this.sql.prepare("SELECT price_json, created_at, cache_mode FROM usage_records WHERE id = ?").get(input.id) as { price_json: string | null; created_at: string; cache_mode: UsageRecordInput["cacheMode"] | null } | undefined;
      const price = existing ? (existing.price_json ? JSON.parse(existing.price_json) as ModelPrice : undefined) : this.findPrice(input.providerId, input.model);
      const usage = input.usage ? normalizedUsage(input.usage) : undefined;
      const cost = usage && price ? usageCostNano(usage, price, existing?.created_at || input.createdAt, existing ? existing.cache_mode ?? undefined : input.cacheMode) : null;
      this.sql.prepare(`INSERT INTO usage_records (id, request_id, api_key_id, api_key_name, provider_id, provider_name, model, created_at, status_code,
        input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, cost_nano, price_json, cache_write_long_input_tokens, cache_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET input_tokens = COALESCE(excluded.input_tokens, input_tokens),
          cached_input_tokens = COALESCE(excluded.cached_input_tokens, cached_input_tokens), cache_write_input_tokens = COALESCE(excluded.cache_write_input_tokens, cache_write_input_tokens),
          output_tokens = COALESCE(excluded.output_tokens, output_tokens), cost_nano = COALESCE(excluded.cost_nano, cost_nano),
          cache_write_long_input_tokens = CASE WHEN excluded.input_tokens IS NOT NULL THEN excluded.cache_write_long_input_tokens ELSE cache_write_long_input_tokens END`)
        .run(input.id, input.requestId, input.apiKeyId, input.apiKeyName, input.providerId, input.providerName, input.model, input.createdAt, input.statusCode,
          usage?.inputTokens ?? null, usage?.cachedInputTokens ?? null, usage?.cacheWriteInputTokens ?? null, usage?.outputTokens ?? null, cost, price ? JSON.stringify(price) : null, usage?.cacheWriteLongInputTokens || 0, input.cacheMode ?? null);
    })();
  }

  /** Deliberately only fills unpriced records; previously priced bills are immutable. */
  priceUnpricedRecords(): number {
    return this.sql.transaction(() => {
      let changed = 0;
      const select = this.sql.prepare(`SELECT id, provider_id, model, created_at, cache_mode, input_tokens, cached_input_tokens, cache_write_input_tokens, cache_write_long_input_tokens, output_tokens FROM usage_records WHERE id > ? AND input_tokens IS NOT NULL AND cost_nano IS NULL ORDER BY id LIMIT 500`);
      const update = this.sql.prepare("UPDATE usage_records SET cost_nano = ?, price_json = ? WHERE id = ?");
      let cursor = "";
      while (true) {
        const rows = select.all(cursor) as Array<{ id: string; provider_id: string; model: string; created_at: string; cache_mode: UsageRecordInput["cacheMode"] | null; input_tokens: number; cached_input_tokens: number; cache_write_input_tokens: number; cache_write_long_input_tokens: number; output_tokens: number }>;
        if (!rows.length) break;
        for (const row of rows) {
          const price = this.findPrice(row.provider_id, row.model);
          if (!price) continue;
          const usage = { inputTokens: row.input_tokens, cachedInputTokens: row.cached_input_tokens, cacheWriteInputTokens: row.cache_write_input_tokens, cacheWriteLongInputTokens: row.cache_write_long_input_tokens, outputTokens: row.output_tokens, totalTokens: row.input_tokens + row.output_tokens };
          const cost = usageCostNano(usage, price, row.created_at, row.cache_mode ?? undefined);
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
