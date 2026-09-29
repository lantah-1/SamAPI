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

export interface ModelPriceTier extends ModelPriceRates {
  rules?: ModelPriceRule[];
  maxInputTokens?: number;
}

export interface OfficialPriceSource {
  id: string;
  name: string;
  url: string;
}

export interface ModelPrice extends ModelPriceTier {
  id: string;
  providerId: string;
  model: string;
  updatedAt: string;
  source?: OfficialPriceSource;
  serviceTiers?: Record<string, ModelPriceTier>;
  cacheReadRequiresMode?: boolean;
}

export function normalizeServiceTier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const tier = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,63}$/.test(tier) ? tier === "standard" ? "default" : tier : undefined;
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
  parserVersion?: number;
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
  serviceTier?: string;
  usage?: TokenUsage;
  finalized?: boolean;
  estimation?: {
    method: "content" | "same-request" | "historical" | "rejected";
    sampleCount?: number;
    inputEstimated?: boolean;
    outputEstimated?: boolean;
    tokenizer?: "o200k_base" | "cl100k_base";
    cacheUsageMissing?: boolean;
    cacheEstimated?: boolean;
    cacheSampleCount?: number;
  };
}

export interface UsageTotals extends TokenUsage {
  requests: number;
  downstreamRequests: number;
  failedRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  historicalEstimatedRequests: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCachedInputTokens: number;
  estimatedTotalTokens: number;
  estimatedUsageCostUsd: number;
  pendingRequests: number;
  missingUsageRequests: number;
  unpricedRequests: number;
  estimatedCostUsd: number;
}

export interface UsageEstimationResult {
  updated: number;
  remaining: number;
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
