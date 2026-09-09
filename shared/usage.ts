export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  cacheWriteLongInputTokens?: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ModelPriceRates {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  explicitCachedInputUsdPerMillion?: number;
  cacheReadUnavailable?: boolean;
  cacheWriteUsdPerMillion?: number;
  cacheWriteLongUsdPerMillion?: number;
  outputUsdPerMillion: number;
}

export interface ModelPriceRule extends ModelPriceRates {
  aboveInputTokens?: number;
  weekdaysUtc?: number[];
  startMinuteUtc?: number;
  endMinuteUtc?: number;
  effectiveFrom?: string;
  effectiveUntil?: string;
}

export interface OfficialPriceSource {
  id: string;
  name: string;
  url: string;
}

export interface ModelPrice extends ModelPriceRates {
  id: string;
  providerId: string;
  model: string;
  updatedAt: string;
  source?: OfficialPriceSource;
  rules?: ModelPriceRule[];
  maxInputTokens?: number;
  cacheReadRequiresMode?: boolean;
}

export type ModelPriceInput = Pick<ModelPrice, "providerId" | "model" | "inputUsdPerMillion" | "cachedInputUsdPerMillion" | "cacheWriteUsdPerMillion" | "cacheWriteLongUsdPerMillion" | "outputUsdPerMillion">;
export type OfficialModelPrice = Omit<ModelPrice, "id" | "updatedAt"> & { source: OfficialPriceSource };

export interface ModelPriceSyncState extends OfficialPriceSource {
  status: "pending" | "success" | "failed";
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  nextSyncAt?: string;
  modelCount: number;
  error?: string;
}

export interface ModelPriceSyncReport {
  running: boolean;
  sources: ModelPriceSyncState[];
}

export interface UsageRecordInput {
  id: string;
  requestId: string;
  apiKeyId: string;
  apiKeyName: string;
  providerId: string;
  providerName: string;
  model: string;
  createdAt: string;
  statusCode: number;
  cacheMode?: "implicit" | "explicit";
  usage?: TokenUsage;
}

export interface UsageTotals extends TokenUsage {
  requests: number;
  downstreamRequests: number;
  failedRequests: number;
  reportedRequests: number;
  missingUsageRequests: number;
  unpricedRequests: number;
  estimatedCostUsd: number;
}

export interface UsageFilters {
  apiKeyId?: string;
  from?: string;
  to?: string;
  timezoneOffsetMinutes?: number;
}

export interface UsageReport {
  totals: UsageTotals;
  clients: Array<UsageTotals & { apiKeyId: string; apiKeyName: string }>;
  models: Array<UsageTotals & { providerId: string; providerName: string; model: string }>;
  daily: Array<UsageTotals & { date: string }>;
  keys: Array<{ id: string; name: string; prefix?: string }>;
}
