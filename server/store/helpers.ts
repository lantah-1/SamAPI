import { createHash } from "node:crypto";
import type {
  AppDatabase,
  AppSettings,
  AppThemeId,
  GroupRouteMember,
  GroupRouteStrategy,
  GrokOAuthFormat,
  RouteProxyConfig,
  TemporaryAccount,
  TemporaryAccountAvailability,
  TemporaryAccountImportMode,
  TemporaryAccountProviderType,
  TemporaryAccountQuotaStage
} from "../../shared/types.js";

export const ENDPOINTS = ["messages", "chat/completions", "responses"] as const;
export const THEME_IDS: AppThemeId[] = ["fresh", "salt", "citrus", "rose", "midnight"];
export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const GROK_BASE_URL = "https://api.x.ai/v1";
export const CHATGPT_OFFICIAL_PROVIDER_KEY_ID = "provider-key-chatgpt-official";
export const CHATGPT_OFFICIAL_PROVIDER_KEY_LABEL = "ChatGPT 官方";
export const GROK_OFFICIAL_PROVIDER_KEY_ID = "provider-key-grok-official";
export const GROK_OFFICIAL_PROVIDER_KEY_LABEL = "Grok 官方";
export const TEMPORARY_ACCOUNT_PROVIDER_LABELS: Record<TemporaryAccountProviderType, string> = {
  gpt: "GPT",
  grok: "Grok",
  claude: "Claude",
  gemini: "Gemini"
};
export const DEFAULT_SETTINGS: AppSettings = {
  maxRequestLogs: 100,
  themeId: "fresh",
  adminSessionTtlMinutes: 30,
  temporaryAccountStrategy: "sequential"
};

export function now() {
  return new Date().toISOString();
}

export function hashSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

export function normalizePasswordHash(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined;
}

export function normalizeBaseUrl(value: string) {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("地址 URL 必须是合法的网址，例如 https://api.example.com/v1");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("地址 URL 仅支持 http:// 或 https:// 开头的合法网址");
  }
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

export function normalizeSiteType(value: unknown) {
  return value === "newapi" ? "newapi" : "unknown";
}

export function normalizeSettings(input?: Partial<AppSettings>): AppSettings {
  const maxRequestLogs = Number(input?.maxRequestLogs ?? DEFAULT_SETTINGS.maxRequestLogs);
  const adminSessionTtlMinutes = Number(input?.adminSessionTtlMinutes ?? DEFAULT_SETTINGS.adminSessionTtlMinutes);
  const themeId = THEME_IDS.includes(input?.themeId as AppThemeId) ? (input?.themeId as AppThemeId) : DEFAULT_SETTINGS.themeId;
  const temporaryAccountStrategy = normalizeGroupStrategy(input?.temporaryAccountStrategy ?? DEFAULT_SETTINGS.temporaryAccountStrategy);
  return {
    maxRequestLogs: Number.isFinite(maxRequestLogs) ? Math.min(5000, Math.max(1, Math.floor(maxRequestLogs))) : DEFAULT_SETTINGS.maxRequestLogs,
    themeId,
    adminSessionTtlMinutes: Number.isFinite(adminSessionTtlMinutes)
      ? Math.min(60 * 24 * 30, Math.max(1, Math.floor(adminSessionTtlMinutes)))
      : DEFAULT_SETTINGS.adminSessionTtlMinutes,
    temporaryAccountStrategy
  };
}

export function groupMemberKey(member: GroupRouteMember) {
  return `${member.siteId}::${member.apiKeyId}::${member.model}`;
}

export function normalizeMatchRule(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeRouteProxy(input: unknown): RouteProxyConfig | undefined {
  if (!isRecord(input)) return undefined;
  const mode = input.mode === "system" || input.mode === "custom" ? input.mode : "direct";
  if (mode === "custom") {
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!url) throw new Error("自定义代理地址不能为空");
    try {
      const parsed = new URL(url);
      if (!parsed.protocol || !parsed.hostname) throw new Error("invalid proxy url");
    } catch {
      throw new Error("自定义代理地址必须是合法 URL，例如 http://127.0.0.1:7890");
    }
    return { mode, url };
  }
  return mode === "system" ? { mode } : undefined;
}

export function normalizeGroupStrategy(value: unknown): GroupRouteStrategy {
  if (value === "sequential") return "sequential";
  if (value === "random") return "random";
  if (value === "priority") return "priority";
  if (value === "stable-first" || value == null || value === "") return "stable-first";
  throw new Error("请选择有效的分组策略");
}

export function matchRuleTokens(rule: string) {
  return rule
    .split(/[\n,，;；]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

export function modelMatchesRule(model: string, rule: string) {
  const normalizedModel = model.trim().toLowerCase();
  if (!normalizedModel) return false;
  return matchRuleTokens(rule).some((token) => normalizedModel.startsWith(token));
}

export function modelMatchTokens(value: string) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function smartModelMatches(model: string, query: string) {
  if (modelMatchesRule(model, query)) return true;
  const modelTokens = modelMatchTokens(model);
  const queryTokens = modelMatchTokens(query);
  if (modelTokens.length === 0 || queryTokens.length === 0) return false;
  const modelCounts = new Map<string, number>();
  for (const token of modelTokens) modelCounts.set(token, (modelCounts.get(token) || 0) + 1);
  return queryTokens.every((token) => {
    const current = modelCounts.get(token) || 0;
    if (current <= 0) return false;
    modelCounts.set(token, current - 1);
    return true;
  });
}

export function normalizeModelList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,，;；\s]+/)
      : [];
  return Array.from(new Set(values.map((model) => String(model).trim()).filter(Boolean))).sort();
}

export function extractTemporarySecret(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const keyValueMatch = trimmed.match(/^([\w\u4e00-\u9fff ._-]{1,80})\s*[:：=]\s*(.+)$/);
  if (keyValueMatch?.[1] && keyValueMatch[2]) {
    const normalizedKey = keyValueMatch[1]
      .trim()
      .toLowerCase()
      .replace(/[\s.\-]+/g, "_");
    const isAuxiliaryToken = normalizedKey.includes("refresh") || normalizedKey === "id_token" || normalizedKey.includes("session");
    const isPrimarySecret = (
      normalizedKey.includes("access") ||
      normalizedKey.includes("authorization") ||
      normalizedKey.includes("bearer") ||
      normalizedKey.includes("api_key") ||
      normalizedKey === "apikey" ||
      normalizedKey === "key" ||
      normalizedKey === "sk" ||
      normalizedKey === "sso" ||
      normalizedKey === "sso_token" ||
      normalizedKey === "token" ||
      normalizedKey === "令牌" ||
      normalizedKey === "访问令牌"
    );
    if (isPrimarySecret && !isAuxiliaryToken) {
      const secret = extractTemporarySecret(keyValueMatch[2]);
      if (secret) return secret;
    }
  }
  const bearerMatch = trimmed.match(/Bearer\s+([A-Za-z0-9._\-]+(?:-[A-Za-z0-9._\-]+)*)/i);
  if (bearerMatch?.[1]) return bearerMatch[1];
  const ssoMatch = trimmed.match(/(?:^|[;\s])sso=([^;\s]+)/i);
  if (ssoMatch?.[1]) return ssoMatch[1].trim();
  const skMatch = trimmed.match(/\b(sk-[A-Za-z0-9][A-Za-z0-9._\-]{8,}|sk-proj-[A-Za-z0-9._\-]{8,})\b/);
  if (skMatch?.[1]) return skMatch[1];
  if (/^[A-Za-z0-9._\-]{20,}$/.test(trimmed)) return trimmed;
  const fields = temporaryAccountLineFields(trimmed);
  if (fields.length > 1) {
    for (const field of fields) {
      const secret = extractTemporarySecret(field);
      if (secret) return secret;
    }
  }
  return undefined;
}

export function temporaryAccountLineFields(line: string) {
  return line
    .split(/[|,\t]+|;{2,}|-{4,}/)
    .map((field) => field.trim())
    .filter(Boolean);
}

export function emailFromTemporaryLine(line: string) {
  return temporaryAccountLineFields(line)
    .map((field) => field.trim())
    .find((field) => /^[^\s@|,]+@[^\s@|,]+\.[^\s@|,]+$/.test(field));
}

export function browserCookieStateFromText(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const keyValueMatch = trimmed.match(/^(?:cookie|cookies|cf_clearance|浏览器cookie|浏览器态)\s*[:：=]\s*(.+)$/i);
  const cookieText = keyValueMatch?.[1]?.trim() || trimmed;
  if (/^(cf_clearance|__cf_bm|_cfuvid)\s*=/i.test(cookieText) || /;\s*(cf_clearance|__cf_bm|_cfuvid)\s*=/i.test(cookieText)) return cookieText;
  if (/^[A-Za-z0-9._\-]{20,}$/.test(cookieText) && /cf_clearance/i.test(trimmed)) return `cf_clearance=${cookieText}`;
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function temporaryAccountLabel(record: Record<string, unknown>, fallback: string) {
  for (const key of ["label", "name", "email", "username", "user_id", "principal_id", "sub", "account", "account_id", "remark", "备注", "pool"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

export function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function firstStringField(records: Record<string, unknown>[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = stringField(record, key);
      if (value) return value;
    }
  }
  return undefined;
}

export function firstBrowserCookieState(records: Record<string, unknown>[]) {
  for (const record of records) {
    for (const key of ["session_token", "sessionToken", "cf_clearance", "cookie", "cookies", "browser_cookie", "browserCookie", "浏览器cookie", "浏览器态"]) {
      const value = record[key];
      const cookieState = key === "cf_clearance" && typeof value === "string" && value.trim()
        ? `cf_clearance=${value.trim()}`
        : browserCookieStateFromText(value);
      if (cookieState) return cookieState;
    }
  }
  return undefined;
}

export function firstTemporarySecret(records: Record<string, unknown>[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const secret = extractTemporarySecret(record[key]);
      if (secret) return secret;
    }
  }
  return undefined;
}

export function jwtPayload(token?: string) {
  const parts = token?.split(".") || [];
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function codexAccountIdFromIdToken(idToken?: string) {
  const payload = jwtPayload(idToken);
  const auth = isRecord(payload?.["https://api.openai.com/auth"]) ? payload?.["https://api.openai.com/auth"] : undefined;
  const accountId = isRecord(auth) ? auth.chatgpt_account_id || auth.account_id || auth.user_id : undefined;
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
}

export function emailFromIdToken(idToken?: string) {
  const email = jwtPayload(idToken)?.email;
  return typeof email === "string" && email.trim() ? email.trim() : undefined;
}

export function temporaryAccountLabelFromRecords(records: Record<string, unknown>[], fallback: string) {
  for (const record of records) {
    const label = temporaryAccountLabel(record, "");
    if (label) return label;
  }
  const idToken = firstStringField(records, ["id_token", "idToken"]);
  return emailFromIdToken(idToken) || fallback;
}

export function temporaryAccountType(record: Record<string, unknown>, secret: string, accountId?: string): TemporaryAccount["accountType"] {
  const type = stringField(record, "type")?.toLowerCase();
  if (type === "codex") return "codex";
  if (type === "oauth") return "codex";
  if (accountId || stringField(record, "account_id") || stringField(record, "chatgpt_account_id")) return "codex";
  return secret.startsWith("sk-") ? "openai-api-key" : "codex";
}

export function numberLike(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const normalized = Number(value.replace(/,/g, "").trim());
    return Number.isFinite(normalized) ? normalized : value.trim();
  }
  return undefined;
}

export function quotaStageFromRecord(label: string, record: Record<string, unknown>, unit?: string): TemporaryAccountQuotaStage | undefined {
  const remaining = numberLike(record.remaining ?? record.remain ?? record.left ?? record.available ?? record.balance ?? record.quota_remaining ?? record["剩余"]);
  const total = numberLike(record.total ?? record.limit ?? record.quota ?? record.amount ?? record["总量"]);
  const used = numberLike(record.used ?? record.usage ?? record.consumed ?? record["已用"]);
  const resetAt = typeof (record.resetAt ?? record.reset_at ?? record.expiresAt ?? record.expires_at ?? record.expire_at ?? record["重置时间"]) === "string"
    ? String(record.resetAt ?? record.reset_at ?? record.expiresAt ?? record.expires_at ?? record.expire_at ?? record["重置时间"]).trim()
    : undefined;
  if (remaining == null && total == null && used == null && !resetAt) return undefined;
  return {
    label,
    remaining,
    total,
    used,
    unit: unit || (typeof record.unit === "string" ? record.unit : undefined),
    resetAt
  };
}

export function normalizeTemporaryAccountAvailability(value: unknown): TemporaryAccountAvailability {
  if (value === "available" || value === "unavailable") return value;
  return "unknown";
}

export function normalizeTemporaryAccountProviderType(value: unknown): TemporaryAccountProviderType {
  if (value === "grok") return "grok";
  if (value === "claude") return "claude";
  if (value === "gemini") return "gemini";
  return "gpt";
}

export function numericQuotaValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = Number(value.replace(/,/g, "").replace(/%$/, "").trim());
  return Number.isFinite(normalized) ? normalized : undefined;
}

export function accountHasUsableQuota(account: TemporaryAccount) {
  const numericRemaining = account.quotaStages
    .map((stage) => numericQuotaValue(stage.remaining))
    .filter((value): value is number => value != null);
  if (numericRemaining.length === 0) return true;
  return numericRemaining.some((value) => value > 0);
}

export function temporaryAccountCanBeUsed(account: TemporaryAccount) {
  if (account.availability === "unavailable") return false;
  return accountHasUsableQuota(account);
}

export function extractQuotaStages(record: Record<string, unknown>): TemporaryAccountQuotaStage[] {
  const stages: TemporaryAccountQuotaStage[] = [];
  const pushStage = (stage?: TemporaryAccountQuotaStage) => {
    if (stage && !stages.some((item) => item.label === stage.label)) stages.push(stage);
  };
  pushStage(quotaStageFromRecord("总额度", record));
  for (const key of ["quota", "balance", "usage", "limit", "remain", "remaining", "credit"]) {
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) pushStage(quotaStageFromRecord(key, value as Record<string, unknown>));
  }
  for (const key of ["stages", "quotaStages", "quotas", "plans", "periods", "阶段", "额度"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item && typeof item === "object") {
          const itemRecord = item as Record<string, unknown>;
          const label = typeof itemRecord.label === "string" || typeof itemRecord.name === "string"
            ? String(itemRecord.label || itemRecord.name)
            : `阶段 ${index + 1}`;
          pushStage(quotaStageFromRecord(label, itemRecord));
        }
      });
    } else if (value && typeof value === "object") {
      for (const [label, item] of Object.entries(value as Record<string, unknown>)) {
        if (item && typeof item === "object") pushStage(quotaStageFromRecord(label, item as Record<string, unknown>));
        else pushStage({ label, remaining: numberLike(item) });
      }
    }
  }
  return stages;
}

export function mergeQuotaStages(records: Record<string, unknown>[]) {
  const stages: TemporaryAccountQuotaStage[] = [];
  for (const record of records) {
    for (const stage of extractQuotaStages(record)) {
      if (!stages.some((item) => item.label === stage.label)) stages.push(stage);
    }
  }
  return stages;
}

export function modelsFromRecord(record: Record<string, unknown>) {
  return normalizeModelList(record.models || record.model || record["模型"]);
}

type TemporaryAccountImportCandidate = {
  label: string;
  secret: string;
  accountType?: TemporaryAccount["accountType"];
  accountId?: string;
  email?: string;
  refreshToken?: string;
  idToken?: string;
  sessionToken?: string;
  grokOAuthFormat?: GrokOAuthFormat;
  oauthClientId?: string;
  oauthTokenEndpoint?: string;
  upstreamBaseUrl?: string;
  tokenExpiresAt?: string;
  grokUsingApi?: boolean;
  models: string[];
  quotaStages: TemporaryAccountQuotaStage[];
};

function booleanField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  if (value.trim().toLowerCase() === "true") return true;
  if (value.trim().toLowerCase() === "false") return false;
  return undefined;
}

function oauthExpiry(record: Record<string, unknown>) {
  const explicit = firstStringField([record], ["expired", "expires_at"]);
  if (explicit && Number.isFinite(Date.parse(explicit))) return new Date(explicit).toISOString();
  const expiresIn = typeof record.expires_in === "number" ? record.expires_in : Number(record.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) return new Date(Date.now() + expiresIn * 1000).toISOString();
  const token = firstStringField([record], ["id_token", "access_token"]);
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? new Date(exp * 1000).toISOString() : undefined;
}

function grokOAuthFormat(record: Record<string, unknown>): GrokOAuthFormat | undefined {
  const type = stringField(record, "type")?.toLowerCase();
  const authKind = stringField(record, "auth_kind")?.toLowerCase();
  if (type === "xai" || authKind === "oauth" || ["base_url", "token_endpoint", "last_refresh", "expired", "redirect_uri"].some((key) => key in record)) {
    return type && type !== "xai" ? undefined : "cpa-oauth";
  }
  const provider = stringField(record, "provider")?.toLowerCase();
  if (provider && provider !== "grok_build") return undefined;
  if (provider === "grok_build" || ["client_id", "name", "user_id", "principal_id", "team_id", "expires_at", "scope"].some((key) => key in record)) {
    return "grok2api-oauth";
  }
  return "grok2api-oauth";
}

function parseGrokOAuthImport(content: string, models: string[], mode: TemporaryAccountImportMode) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || Array.isArray(parsed.accounts) || "sso_token" in parsed || "sso" in parsed) return [];
  const format = grokOAuthFormat(parsed);
  const expectedFormat = mode === "cpa" ? "cpa-oauth" : mode === "subapi" ? "grok2api-oauth" : undefined;
  if (!format || (expectedFormat && format !== expectedFormat)) return [];
  const tokenType = stringField(parsed, "token_type");
  if (tokenType && tokenType.toLowerCase() !== "bearer") return [];
  const accessToken = firstStringField([parsed], ["access_token"]);
  const refreshToken = firstStringField([parsed], ["refresh_token"]);
  if (!accessToken && !refreshToken) return [];
  const idToken = firstStringField([parsed], ["id_token"]);
  const accountId = firstStringField([parsed], ["user_id", "principal_id", "sub"]) || stringField(jwtPayload(idToken) || {}, "sub");
  const email = firstStringField([parsed], ["email"]) || emailFromIdToken(idToken);
  return [{
    label: firstStringField([parsed], ["name"]) || email || accountId || (format === "cpa-oauth" ? "CPA Grok OAuth" : "grok2api OAuth"),
    secret: accessToken || "",
    accountId,
    email,
    refreshToken,
    idToken,
    grokOAuthFormat: format,
    oauthClientId: firstStringField([parsed], ["client_id", "oidc_client_id"]),
    oauthTokenEndpoint: firstStringField([parsed], ["token_endpoint"]),
    upstreamBaseUrl: firstStringField([parsed], ["base_url"]),
    tokenExpiresAt: oauthExpiry(parsed),
    grokUsingApi: booleanField(parsed, "using_api"),
    models,
    quotaStages: []
  }] satisfies TemporaryAccountImportCandidate[];
}

export function temporaryAccountFromRecord(
  record: Record<string, unknown>,
  models: string[],
  fallbackLabel: string
) {
  const credentials = isRecord(record.credentials) ? record.credentials : {};
  const extra = isRecord(record.extra) ? record.extra : {};
  const tokens = isRecord(record.tokens) ? record.tokens : {};
  const auth = isRecord(record.auth) ? record.auth : {};
  const records = [record, credentials, extra, tokens, auth];
  const recordModels = records.flatMap((item) => modelsFromRecord(item));
  const mergedModels = recordModels.length > 0 ? recordModels : models;
  const secret = firstTemporarySecret(records, [
    "api_key",
    "apiKey",
    "key",
    "token",
    "sso",
    "sso_token",
    "ssoToken",
    "access_token",
    "accessToken",
    "secret",
    "authorization",
    "Authorization",
    "cookie",
    "cookies",
    "sk"
  ]);
  if (!secret) return undefined;

  const idToken = firstStringField(records, ["id_token", "idToken"]);
  const accountId = firstStringField(records, [
    "account_id",
    "chatgpt_account_id",
    "chatgptAccountId",
    "accountId",
    "principal_id",
    "principalId",
    "user_id",
    "userId",
    "sub"
  ]) || codexAccountIdFromIdToken(idToken);
  return {
    label: temporaryAccountLabelFromRecords(records, fallbackLabel),
    secret,
    accountType: temporaryAccountType(record, secret, accountId),
    accountId,
    email: firstStringField(records, ["email", "mail", "username"]) || emailFromIdToken(idToken),
    refreshToken: firstStringField(records, ["refresh_token", "refreshToken"]),
    idToken,
    sessionToken: firstBrowserCookieState(records) || firstStringField(records, ["session_token", "sessionToken"]),
    models: mergedModels,
    quotaStages: mergeQuotaStages(records)
  };
}

export function collectTemporaryAccounts(
  value: unknown,
  models: string[],
  output: TemporaryAccountImportCandidate[]
) {
  if (Array.isArray(value)) {
    for (const item of value) collectTemporaryAccounts(item, models, output);
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const account = temporaryAccountFromRecord(record, models, `账号 ${output.length + 1}`);
    if (account) {
      output.push(account);
      return;
    }
    const containerModels = modelsFromRecord(record);
    const nestedModels = containerModels.length > 0 ? containerModels : models;
    for (const nestedKey of ["accounts", "data", "items", "list", "keys", "tokens", "subscriptions", "result", "basic", "super", "heavy"]) {
      if (nestedKey in record) collectTemporaryAccounts(record[nestedKey], nestedModels, output);
    }
    for (const [nestedKey, nestedValue] of Object.entries(record)) {
      if (["accounts", "data", "items", "list", "keys", "tokens", "subscriptions", "result", "basic", "super", "heavy"].includes(nestedKey)) continue;
      if (nestedValue && typeof nestedValue === "object") collectTemporaryAccounts(nestedValue, nestedModels, output);
    }
    return;
  }
  const secret = extractTemporarySecret(value);
  if (secret) output.push({ label: `账号 ${output.length + 1}`, secret, accountType: secret.startsWith("sk-") ? "openai-api-key" : "codex", models, quotaStages: [] });
}

export function normalizeLooseTemporaryAccountKey(key: string) {
  const normalized = key
    .trim()
    .toLowerCase()
    .replace(/[\s.\-]+/g, "_");
  if (["access_token", "accesstoken", "access", "authorization", "bearer", "token", "令牌", "访问令牌"].includes(normalized)) return "access_token";
  if (["refresh_token", "refreshtoken", "refresh", "刷新令牌"].includes(normalized)) return "refresh_token";
  if (["id_token", "idtoken"].includes(normalized)) return "id_token";
  if (["account_id", "accountid", "chatgpt_account_id", "chatgptaccountid", "账号id", "账户id"].includes(normalized)) return "account_id";
  if (["email", "mail", "username", "user", "邮箱", "账号", "账户"].includes(normalized)) return "email";
  if (["label", "name", "remark", "备注", "名称"].includes(normalized)) return "label";
  if (["session_token", "sessiontoken", "session", "cf_clearance", "cookie", "cookies", "browser_cookie", "browsercookie", "浏览器cookie", "浏览器态"].includes(normalized)) return "session_token";
  if (["api_key", "apikey", "key", "sk"].includes(normalized)) return "api_key";
  if (["type", "account_type", "类型"].includes(normalized)) return "type";
  if (["models", "model", "模型"].includes(normalized)) return "models";
  if (["sso", "sso_token", "ssotoken"].includes(normalized)) return "sso";
  return undefined;
}

export function parseLooseTemporaryAccountKeyValue(line: string) {
  const match = line.match(/^(.{1,80}?)[\s]*[:：=][\s]*(.+)$/);
  if (!match?.[1] || !match[2]?.trim()) return undefined;
  const key = normalizeLooseTemporaryAccountKey(match[1]);
  if (!key) return undefined;
  return { key, value: match[2].trim() };
}

export function isLooseTemporaryAccountSeparator(line: string) {
  return !line || /^[-=_*#]{3,}$/.test(line);
}

export function collectLooseTemporaryAccountBlocks(content: string, models: string[], output: TemporaryAccountImportCandidate[]) {
  let record: Record<string, unknown> = {};
  const flush = () => {
    if (Object.keys(record).length === 0) return;
    collectTemporaryAccounts(record, models, output);
    record = {};
  };
  const setField = (key: string, value: string) => {
    if (!value.trim()) return;
    if (record[key] == null) record[key] = value.trim();
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (isLooseTemporaryAccountSeparator(line)) {
      flush();
      continue;
    }

    const fields = temporaryAccountLineFields(line);
    const keyValues = fields.map(parseLooseTemporaryAccountKeyValue).filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (keyValues.length > 0) {
      for (const item of keyValues) setField(item.key, item.value);
      continue;
    }

    const titleMatch = line.match(/^(账号|账户|account)\s*(?:#?\d+)?\s*[#：:\-]?\s*(.+)?$/i);
    if (titleMatch && !extractTemporarySecret(line)) {
      flush();
      if (titleMatch[2]?.trim()) setField("label", titleMatch[2].trim());
      continue;
    }

    const secret = extractTemporarySecret(line);
    if (secret) {
      setField(secret.startsWith("sk-") ? "api_key" : "access_token", secret);
      const cookieState = browserCookieStateFromText(line);
      if (cookieState) setField("session_token", cookieState);
      const email = emailFromTemporaryLine(line);
      if (email) setField("email", email);
      continue;
    }

    const cookieState = browserCookieStateFromText(line);
    if (cookieState) {
      setField("session_token", cookieState);
      continue;
    }

    const email = emailFromTemporaryLine(line);
    if (email) setField("email", email);
  }

  flush();
}

export function mergeTemporaryAccountImportCandidate(
  existing: TemporaryAccountImportCandidate,
  incoming: TemporaryAccountImportCandidate
): TemporaryAccountImportCandidate {
  return {
    ...existing,
    label: existing.label || incoming.label,
    accountType: existing.accountType || incoming.accountType,
    accountId: existing.accountId || incoming.accountId,
    email: existing.email || incoming.email,
    refreshToken: existing.refreshToken || incoming.refreshToken,
    idToken: existing.idToken || incoming.idToken,
    sessionToken: existing.sessionToken || incoming.sessionToken,
    grokOAuthFormat: existing.grokOAuthFormat || incoming.grokOAuthFormat,
    oauthClientId: existing.oauthClientId || incoming.oauthClientId,
    oauthTokenEndpoint: existing.oauthTokenEndpoint || incoming.oauthTokenEndpoint,
    upstreamBaseUrl: existing.upstreamBaseUrl || incoming.upstreamBaseUrl,
    tokenExpiresAt: existing.tokenExpiresAt || incoming.tokenExpiresAt,
    grokUsingApi: existing.grokUsingApi ?? incoming.grokUsingApi,
    models: existing.models.length > 0 ? existing.models : incoming.models,
    quotaStages: existing.quotaStages.length > 0 ? existing.quotaStages : incoming.quotaStages
  };
}

export function parseTemporaryAccountImport(
  content: string,
  models: string[],
  providerType: TemporaryAccountProviderType = "gpt",
  mode: TemporaryAccountImportMode = "auto"
) {
  if (providerType === "grok") return parseGrokOAuthImport(content.trim(), models, mode);
  const output: TemporaryAccountImportCandidate[] = [];
  const trimmed = content.trim();
  if (!trimmed) return output;

  try {
    const parsed = JSON.parse(trimmed);
    collectTemporaryAccounts(parsed, models, output);
  } catch {
    // Fall through to line parser.
  }

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    try {
      const parsed = JSON.parse(line);
      collectTemporaryAccounts(parsed, models, output);
      continue;
    } catch {
      // Not JSONL.
    }
    const secret = extractTemporarySecret(line);
    if (!secret) continue;
    const email = emailFromTemporaryLine(line);
    const label = line
      .replace(secret, "")
      .replace(/[,\t|:;]+/g, " ")
      .trim();
    output.push({ label: email || label || `账号 ${output.length + 1}`, secret, accountType: secret.startsWith("sk-") ? "openai-api-key" : "codex", email, sessionToken: browserCookieStateFromText(line), models, quotaStages: [] });
  }

  collectLooseTemporaryAccountBlocks(trimmed, models, output);

  const unique = new Map<string, (typeof output)[number]>();
  for (const account of output) {
    const existing = unique.get(account.secret);
    unique.set(account.secret, existing ? mergeTemporaryAccountImportCandidate(existing, account) : account);
  }
  return Array.from(unique.values());
}

export function createEmptyDatabase(): AppDatabase {
  return {
    sites: [],
    apiKeys: [],
    providerApiKeyGroups: [],
    temporaryAccountGroups: [],
    headerTemplates: [],
    routes: [],
    settings: { ...DEFAULT_SETTINGS }
  };
}
