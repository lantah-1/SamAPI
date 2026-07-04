import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  ApiKeyCreated,
  ApiKeyRecord,
  AppDatabase,
  AppSettings,
  AppThemeId,
  GroupRoute,
  GroupRouteMember,
  GroupRouteStrategy,
  HeaderTemplate,
  ProviderApiKeyEntry,
  ProviderApiKeyGroup,
  ProviderApiKeyGroupInput,
  RequestLog,
  RouteRecord,
  Site,
  SiteAddress,
  SwitchRoute,
  TemporaryAccount,
  TemporaryAccountAvailability,
  TemporaryAccountGroup,
  TemporaryAccountImportInput,
  TemporaryAccountQuotaStage
} from "../shared/types.js";

const ENDPOINTS = ["messages", "chat/completions", "responses"] as const;
const THEME_IDS: AppThemeId[] = ["fresh", "salt", "citrus", "rose", "midnight"];
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_DEFAULT_MODELS = ["gpt-5.5"];
const DEFAULT_SETTINGS: AppSettings = {
  maxRequestLogs: 100,
  themeId: "fresh",
  adminSessionTtlMinutes: 30,
  temporaryAccountStrategy: "sequential"
};

function now() {
  return new Date().toISOString();
}

function hashSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

function normalizePasswordHash(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined;
}

function normalizeBaseUrl(value: string) {
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

function normalizeSiteType(value: unknown) {
  return value === "newapi" ? "newapi" : "unknown";
}

function normalizeSettings(input?: Partial<AppSettings>): AppSettings {
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

function groupMemberKey(member: GroupRouteMember) {
  return `${member.siteId}::${member.apiKeyId}::${member.model}`;
}

function normalizeMatchRule(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeGroupStrategy(value: unknown): GroupRouteStrategy {
  if (value === "sequential") return "sequential";
  if (value === "random") return "random";
  if (value === "stable-first" || value == null || value === "") return "stable-first";
  throw new Error("请选择有效的分组策略");
}

function matchRuleTokens(rule: string) {
  return rule
    .split(/[\n,，;；]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function modelMatchesRule(model: string, rule: string) {
  const normalizedModel = model.trim().toLowerCase();
  if (!normalizedModel) return false;
  return matchRuleTokens(rule).some((token) => normalizedModel.startsWith(token));
}

function modelMatchTokens(value: string) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function smartModelMatches(model: string, query: string) {
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

function normalizeModelList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,，;；\s]+/)
      : [];
  return Array.from(new Set(values.map((model) => String(model).trim()).filter(Boolean))).sort();
}

function extractTemporarySecret(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const bearerMatch = trimmed.match(/Bearer\s+([A-Za-z0-9._\-]+(?:-[A-Za-z0-9._\-]+)*)/i);
  if (bearerMatch?.[1]) return bearerMatch[1];
  const skMatch = trimmed.match(/\b(sk-[A-Za-z0-9][A-Za-z0-9._\-]{8,}|sk-proj-[A-Za-z0-9._\-]{8,})\b/);
  if (skMatch?.[1]) return skMatch[1];
  if (/^[A-Za-z0-9._\-]{20,}$/.test(trimmed)) return trimmed;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function temporaryAccountLabel(record: Record<string, unknown>, fallback: string) {
  for (const key of ["label", "name", "email", "username", "account", "remark", "备注"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstStringField(records: Record<string, unknown>[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = stringField(record, key);
      if (value) return value;
    }
  }
  return undefined;
}

function firstTemporarySecret(records: Record<string, unknown>[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const secret = extractTemporarySecret(record[key]);
      if (secret) return secret;
    }
  }
  return undefined;
}

function temporaryAccountLabelFromRecords(records: Record<string, unknown>[], fallback: string) {
  for (const record of records) {
    const label = temporaryAccountLabel(record, "");
    if (label) return label;
  }
  return fallback;
}

function temporaryAccountType(record: Record<string, unknown>, secret: string, accountId?: string): TemporaryAccount["accountType"] {
  const type = stringField(record, "type")?.toLowerCase();
  if (type === "codex") return "codex";
  if (type === "oauth") return "codex";
  if (accountId || stringField(record, "account_id") || stringField(record, "chatgpt_account_id")) return "codex";
  return secret.startsWith("sk-") ? "openai-api-key" : "codex";
}

function numberLike(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const normalized = Number(value.replace(/,/g, "").trim());
    return Number.isFinite(normalized) ? normalized : value.trim();
  }
  return undefined;
}

function quotaStageFromRecord(label: string, record: Record<string, unknown>, unit?: string): TemporaryAccountQuotaStage | undefined {
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

function normalizeTemporaryAccountAvailability(value: unknown): TemporaryAccountAvailability {
  if (value === "available" || value === "unavailable") return value;
  return "unknown";
}

function numericQuotaValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = Number(value.replace(/,/g, "").replace(/%$/, "").trim());
  return Number.isFinite(normalized) ? normalized : undefined;
}

function accountHasUsableQuota(account: TemporaryAccount) {
  const numericRemaining = account.quotaStages
    .map((stage) => numericQuotaValue(stage.remaining))
    .filter((value): value is number => value != null);
  if (numericRemaining.length === 0) return true;
  return numericRemaining.some((value) => value > 0);
}

function temporaryAccountCanBeUsed(account: TemporaryAccount) {
  if (!account.enabled) return false;
  if (account.availability === "unavailable") return false;
  return accountHasUsableQuota(account);
}

function extractQuotaStages(record: Record<string, unknown>): TemporaryAccountQuotaStage[] {
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

function mergeQuotaStages(records: Record<string, unknown>[]) {
  const stages: TemporaryAccountQuotaStage[] = [];
  for (const record of records) {
    for (const stage of extractQuotaStages(record)) {
      if (!stages.some((item) => item.label === stage.label)) stages.push(stage);
    }
  }
  return stages;
}

function modelsFromRecord(record: Record<string, unknown>) {
  return normalizeModelList(record.models || record.model || record["模型"]);
}

function temporaryAccountFromRecord(
  record: Record<string, unknown>,
  models: string[],
  fallbackLabel: string
) {
  const credentials = isRecord(record.credentials) ? record.credentials : {};
  const extra = isRecord(record.extra) ? record.extra : {};
  const records = [record, credentials, extra];
  const recordModels = records.flatMap((item) => modelsFromRecord(item));
  const mergedModels = recordModels.length > 0 ? recordModels : models;
  const secret = firstTemporarySecret(records, [
    "api_key",
    "apiKey",
    "key",
    "token",
    "access_token",
    "accessToken",
    "secret",
    "authorization",
    "Authorization",
    "sk"
  ]);
  if (!secret) return undefined;

  const accountId = firstStringField(records, ["account_id", "chatgpt_account_id", "chatgptAccountId"]);
  return {
    label: temporaryAccountLabelFromRecords(records, fallbackLabel),
    secret,
    accountType: temporaryAccountType(record, secret, accountId),
    accountId,
    email: firstStringField(records, ["email", "mail", "username"]),
    refreshToken: firstStringField(records, ["refresh_token", "refreshToken"]),
    idToken: firstStringField(records, ["id_token", "idToken"]),
    sessionToken: firstStringField(records, ["session_token", "sessionToken"]),
    models: mergedModels,
    quotaStages: mergeQuotaStages(records)
  };
}

function collectTemporaryAccounts(
  value: unknown,
  models: string[],
  output: Array<{
    label: string;
    secret: string;
    accountType?: TemporaryAccount["accountType"];
    accountId?: string;
    email?: string;
    refreshToken?: string;
    idToken?: string;
    sessionToken?: string;
    models: string[];
    quotaStages: TemporaryAccountQuotaStage[];
  }>
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
    for (const nestedKey of ["accounts", "data", "items", "list", "keys", "tokens", "subscriptions", "result"]) {
      if (nestedKey in record) collectTemporaryAccounts(record[nestedKey], nestedModels, output);
    }
    return;
  }
  const secret = extractTemporarySecret(value);
  if (secret) output.push({ label: `账号 ${output.length + 1}`, secret, accountType: secret.startsWith("sk-") ? "openai-api-key" : "codex", models, quotaStages: [] });
}

function parseTemporaryAccountImport(content: string, models: string[]) {
  const output: Array<{
    label: string;
    secret: string;
    accountType?: TemporaryAccount["accountType"];
    accountId?: string;
    email?: string;
    refreshToken?: string;
    idToken?: string;
    sessionToken?: string;
    models: string[];
    quotaStages: TemporaryAccountQuotaStage[];
  }> = [];
  const trimmed = content.trim();
  if (!trimmed) return output;

  try {
    collectTemporaryAccounts(JSON.parse(trimmed), models, output);
  } catch {
    // Fall through to line parser.
  }

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    try {
      collectTemporaryAccounts(JSON.parse(line), models, output);
      continue;
    } catch {
      // Not JSONL.
    }
    const secret = extractTemporarySecret(line);
    if (!secret) continue;
    const label = line
      .replace(secret, "")
      .replace(/[,\t|:;]+/g, " ")
      .trim();
    output.push({ label: label || `账号 ${output.length + 1}`, secret, accountType: secret.startsWith("sk-") ? "openai-api-key" : "codex", models, quotaStages: [] });
  }

  const unique = new Map<string, (typeof output)[number]>();
  for (const account of output) {
    if (!unique.has(account.secret)) unique.set(account.secret, account);
  }
  return Array.from(unique.values());
}

function createEmptyDatabase(): AppDatabase {
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

export class JsonStore {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly logsPath: string;
  readonly temporaryAccountsPath: string;
  private db: AppDatabase;
  private requestLogs: RequestLog[] = [];
  private temporaryAccountIndex = 0;

  constructor(dataDir = process.env.SAMAPI_DATA_DIR || path.resolve(process.cwd(), "data")) {
    this.dataDir = path.resolve(dataDir);
    this.dbPath = path.join(this.dataDir, "samapi.json");
    this.logsPath = path.join(this.dataDir, "request-logs.jsonl");
    this.temporaryAccountsPath = path.join(this.dataDir, "temporary-accounts.json");
    mkdirSync(this.dataDir, { recursive: true });
    this.db = this.load();
    this.ensureOfficialOpenAiSite();
    if (this.syncOpenAiModelsFromTemporaryAccounts()) this.persist();
    this.refreshGroupRouteMembers();
  }

  snapshot(options: { includeRequestLogs?: boolean; includeTemporaryAccounts?: boolean } = {}) {
    const { adminPasswordHash, ...database } = this.db;
    return {
      ...database,
      temporaryAccountGroups: options.includeTemporaryAccounts === false ? [] : database.temporaryAccountGroups,
      providerApiKeyGroups: this.db.providerApiKeyGroups.map((group) => this.toProviderApiKeyGroupView(group)),
      requestLogs: options.includeRequestLogs === false ? [] : this.listRequestLogs(),
      dbPath: this.dbPath,
      dataDir: this.dataDir,
      endpoints: [...ENDPOINTS],
      security: {
        adminPasswordCustomized: Boolean(adminPasswordHash)
      }
    };
  }

  getDb() {
    return this.db;
  }

  listRequestLogs(limit = this.db.settings.maxRequestLogs) {
    return this.requestLogs.slice(0, limit);
  }

  recordRequestLog(input: Omit<RequestLog, "id" | "createdAt">) {
    const created: RequestLog = {
      id: `log-${randomUUID()}`,
      createdAt: now(),
      ...input
    };
    this.requestLogs.unshift(created);
    appendFileSync(this.logsPath, `${JSON.stringify(created)}\n`);
    if (this.requestLogs.length > this.db.settings.maxRequestLogs) {
      this.requestLogs = this.requestLogs.slice(0, this.db.settings.maxRequestLogs);
      this.rewriteRequestLogFile();
    }
    return created;
  }

  updateSettings(input: Partial<AppSettings>) {
    this.db.settings = normalizeSettings({ ...this.db.settings, ...input });
    this.requestLogs = this.requestLogs.slice(0, this.db.settings.maxRequestLogs);
    this.rewriteRequestLogFile();
    this.persist();
    return this.db.settings;
  }

  getAdminPasswordHash() {
    return this.db.adminPasswordHash;
  }

  updateAdminPasswordHash(password: string) {
    const normalized = password.trim();
    if (normalized.length < 8) throw new Error("新管理密码至少需要 8 个字符");
    this.db.adminPasswordHash = hashSecret(normalized);
    this.persist();
  }

  ensureOfficialOpenAiSite() {
    const existing = this.officialOpenAiSite();
    if (existing) return existing;
    const timestamp = now();
    const created: Site = {
      id: `site-${randomUUID()}`,
      name: "OpenAI",
      siteType: "unknown",
      addresses: [
        {
          id: `addr-${randomUUID()}`,
          label: "官方 API",
          baseUrl: OPENAI_BASE_URL,
          enabled: true,
          models: [...OPENAI_DEFAULT_MODELS]
        }
      ],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.sites.unshift(created);
    this.persist();
    return created;
  }

  officialOpenAiSite() {
    return this.db.sites.find((site) =>
      site.addresses.some((address) => {
        try {
          const parsed = new URL(address.baseUrl);
          return parsed.hostname.toLowerCase() === "api.openai.com";
        } catch {
          return false;
        }
      })
    );
  }

  isOfficialOpenAiSite(siteId: string) {
    return this.officialOpenAiSite()?.id === siteId;
  }

  importTemporaryAccounts(input: TemporaryAccountImportInput) {
    const site = this.ensureOfficialOpenAiSite();
    const timestamp = now();
    const source = input.source === "subapi" ? "subapi" : "cpa";
    const models = normalizeModelList(input.models);
    const importContents = [input.content, ...(Array.isArray(input.contents) ? input.contents : [])].filter((content) => typeof content === "string" && content.trim());
    const parsedAccounts = importContents.flatMap((content) => parseTemporaryAccountImport(content, models));
    if (parsedAccounts.length === 0) throw new Error("没有解析到可用账号密钥");
    const seen = new Set<string>(
      this.db.temporaryAccountGroups.flatMap((group) => group.accounts.map((account) => hashSecret(account.secret)))
    );
    const accounts: TemporaryAccount[] = [];
    let skipped = 0;
    for (const account of parsedAccounts) {
      const secret = account.secret.trim();
      const hash = hashSecret(secret);
      if (seen.has(hash)) {
        skipped += 1;
        continue;
      }
      seen.add(hash);
      accounts.push({
        id: `temp-account-${randomUUID()}`,
        label: account.label || `账号 ${accounts.length + 1}`,
        prefix: secret.slice(0, 12),
        secret,
        accountType: account.accountType,
        accountId: account.accountId,
        email: account.email,
        refreshToken: account.refreshToken,
        idToken: account.idToken,
        sessionToken: account.sessionToken,
        enabled: true,
        models: account.models.length > 0 ? account.models : models,
        availability: "unknown",
        quotaStages: account.quotaStages || [],
        importedAt: timestamp
      });
    }
    if (accounts.length === 0) throw new Error("导入内容里没有新的可用账号");
    const group: TemporaryAccountGroup = {
      id: `temp-account-group-${randomUUID()}`,
      name: input.name?.trim() || `${source.toUpperCase()} 临时账号`,
      source,
      siteId: site.id,
      enabled: true,
      accounts,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.temporaryAccountGroups.unshift(group);
    this.syncOpenAiModelsFromTemporaryAccounts();
    this.persist();
    return { site, group, imported: accounts.length, skipped };
  }

  updateTemporaryAccountGroup(id: string, input: Partial<TemporaryAccountGroup>) {
    const group = this.db.temporaryAccountGroups.find((item) => item.id === id);
    if (!group) throw new Error("临时账号组不存在");
    if (typeof input.name === "string" && input.name.trim()) group.name = input.name.trim();
    if (typeof input.enabled === "boolean") group.enabled = input.enabled;
    group.updatedAt = now();
    this.persist();
    return group;
  }

  deleteTemporaryAccountGroup(id: string) {
    this.db.temporaryAccountGroups = this.db.temporaryAccountGroups.filter((group) => group.id !== id);
    this.syncOpenAiModelsFromTemporaryAccounts();
    this.persist();
  }

  private orderedTemporaryAccountPool(pool: TemporaryAccount[]) {
    if (pool.length === 0) return pool;
    const strategy = this.db.settings.temporaryAccountStrategy;
    if (strategy === "random") {
      const shuffled = [...pool];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
      }
      return shuffled;
    }
    if (strategy === "sequential") {
      const start = this.temporaryAccountIndex % pool.length;
      this.temporaryAccountIndex = (this.temporaryAccountIndex + 1) % pool.length;
      return [...pool.slice(start), ...pool.slice(0, start)];
    }
    return pool;
  }

  resolveTemporaryOpenAiAccounts(model: string) {
    const allEnabledAccounts = this.db.temporaryAccountGroups
      .filter((group) => group.enabled)
      .flatMap((group) => group.accounts.filter((account) => account.enabled));
    const candidates = allEnabledAccounts.filter((account) => account.models.length === 0 || account.models.includes(model));
    const pool = candidates.length > 0 ? candidates : allEnabledAccounts;
    const usable = pool.filter(temporaryAccountCanBeUsed);
    if (usable.length === 0) return [];
    const available = usable.filter((account) => account.availability === "available");
    const unchecked = usable.filter((account) => account.availability !== "available");
    return [...this.orderedTemporaryAccountPool(available), ...this.orderedTemporaryAccountPool(unchecked)];
  }

  resolveTemporaryOpenAiAccount(model: string) {
    return this.resolveTemporaryOpenAiAccounts(model)[0];
  }

  temporaryAccountCheckTargets(groupId?: string) {
    return this.db.temporaryAccountGroups
      .filter((group) => !groupId || group.id === groupId)
      .flatMap((group) => group.accounts.map((account) => ({ group, account })));
  }

  updateTemporaryAccountCheckResult(
    accountId: string,
    input: {
      availability?: TemporaryAccountAvailability;
      quotaStages?: TemporaryAccountQuotaStage[];
      lastQuotaCheckedAt?: string;
      lastCheckStatusCode?: number;
      lastCheckError?: string;
      secret?: string;
      refreshToken?: string;
      idToken?: string;
      accountId?: string;
      email?: string;
    }
  ) {
    for (const group of this.db.temporaryAccountGroups) {
      const account = group.accounts.find((item) => item.id === accountId);
      if (!account) continue;
      if (input.availability) account.availability = input.availability;
      if (input.quotaStages) account.quotaStages = input.quotaStages;
      if (input.lastQuotaCheckedAt) account.lastQuotaCheckedAt = input.lastQuotaCheckedAt;
      if (typeof input.lastCheckStatusCode === "number") account.lastCheckStatusCode = input.lastCheckStatusCode;
      account.lastCheckError = input.lastCheckError;
      if (typeof input.secret === "string" && input.secret.trim()) {
        account.secret = input.secret.trim();
        account.prefix = account.secret.slice(0, 12);
      }
      if (typeof input.refreshToken === "string" && input.refreshToken.trim()) account.refreshToken = input.refreshToken.trim();
      if (typeof input.idToken === "string" && input.idToken.trim()) account.idToken = input.idToken.trim();
      if (typeof input.accountId === "string" && input.accountId.trim()) account.accountId = input.accountId.trim();
      if (typeof input.email === "string" && input.email.trim()) account.email = input.email.trim();
      group.updatedAt = now();
      this.persist();
      return account;
    }
    return undefined;
  }

  deleteRequestLog(id: string) {
    this.requestLogs = this.requestLogs.filter((log) => log.id !== id);
    this.rewriteRequestLogFile();
  }

  clearRequestLogs() {
    this.requestLogs = [];
    this.rewriteRequestLogFile();
  }

  upsertSite(input: Partial<Site>) {
    const timestamp = now();
    const addresses = (input.addresses || []).map((address) => this.normalizeAddress(address));
    if (!input.name?.trim()) {
      throw new Error("站点名称不能为空");
    }
    if (addresses.length === 0) {
      throw new Error("至少需要一个地址");
    }

    if (input.id) {
      const current = this.db.sites.find((site) => site.id === input.id);
      if (!current) throw new Error("站点不存在");
      Object.assign(current, {
        name: input.name.trim(),
        siteType: normalizeSiteType(input.siteType),
        addresses,
        updatedAt: timestamp
      });
      this.persist();
      return current;
    }

    const created: Site = {
      id: `site-${randomUUID()}`,
      name: input.name.trim(),
      siteType: normalizeSiteType(input.siteType),
      addresses,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.sites.unshift(created);
    this.persist();
    return created;
  }

  deleteSite(id: string) {
    this.db.sites = this.db.sites.filter((site) => site.id !== id);
    this.db.providerApiKeyGroups = this.db.providerApiKeyGroups.filter((group) => group.siteId !== id);
    this.db.temporaryAccountGroups = this.db.temporaryAccountGroups.filter((group) => group.siteId !== id);
    this.db.routes = this.db.routes.filter((route) => route.type !== "switch" || route.siteId !== id);
    this.refreshGroupRouteMembers();
    this.persist();
  }

  createApiKey(name: string): ApiKeyCreated {
    if (!name.trim()) throw new Error("密钥名称不能为空");
    const timestamp = now();
    const plainTextKey = `sk-samapi-${randomBytes(24).toString("base64url")}`;
    const created: ApiKeyCreated = {
      id: `key-${randomUUID()}`,
      name: name.trim(),
      prefix: plainTextKey.slice(0, 18),
      keyHash: hashSecret(plainTextKey),
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      plainTextKey
    };
    this.db.apiKeys.unshift(created);
    this.persist();
    return created;
  }

  updateApiKey(id: string, input: Partial<ApiKeyRecord>) {
    const current = this.db.apiKeys.find((key) => key.id === id);
    if (!current) throw new Error("密钥不存在");
    if (typeof input.name === "string") current.name = input.name.trim();
    if (typeof input.enabled === "boolean") current.enabled = input.enabled;
    current.updatedAt = now();
    this.persist();
    return current;
  }

  deleteApiKey(id: string) {
    this.db.apiKeys = this.db.apiKeys.filter((key) => key.id !== id);
    this.persist();
  }

  upsertProviderApiKeyGroup(input: ProviderApiKeyGroupInput) {
    const timestamp = now();
    if (!input.siteId) throw new Error("请选择供应商");

    const site = this.db.sites.find((item) => item.id === input.siteId);
    if (!site) throw new Error("供应商不存在");
    const groupName = input.groupName?.trim() || site.name;

    if (input.id) {
      const current = this.db.providerApiKeyGroups.find((group) => group.id === input.id);
      if (!current) throw new Error("API Key 分组不存在");
      const previousSiteId = current.siteId;
      const apiKeys = (input.apiKeys || []).map((key, index) => this.normalizeProviderApiKeyEntry(key, index, current.apiKeys));
      if (apiKeys.length === 0) throw new Error("至少需要一个 API Key");
      Object.assign(current, {
        siteId: input.siteId,
        groupName,
        apiKeys,
        updatedAt: timestamp
      });
      if (previousSiteId !== input.siteId) this.syncSiteModelsFromProviderKeys(previousSiteId);
      this.syncSiteModelsFromProviderKeys(input.siteId);
      this.refreshGroupRouteMembers();
      this.persist();
      return this.toProviderApiKeyGroupView(current);
    }

    const apiKeys = (input.apiKeys || []).map((key, index) => this.normalizeProviderApiKeyEntry(key, index));
    if (apiKeys.length === 0) throw new Error("至少需要一个 API Key");

    const created: ProviderApiKeyGroup = {
      id: `provider-key-group-${randomUUID()}`,
      siteId: input.siteId,
      groupName,
      apiKeys,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.providerApiKeyGroups.unshift(created);
    this.syncSiteModelsFromProviderKeys(input.siteId);
    this.refreshGroupRouteMembers();
    this.persist();
    return this.toProviderApiKeyGroupView(created);
  }

  deleteProviderApiKeyGroup(id: string) {
    const current = this.db.providerApiKeyGroups.find((group) => group.id === id);
    this.db.providerApiKeyGroups = this.db.providerApiKeyGroups.filter((group) => group.id !== id);
    if (current) this.syncSiteModelsFromProviderKeys(current.siteId);
    this.refreshGroupRouteMembers();
    this.persist();
  }

  updateProviderApiKeyModels(groupId: string, apiKeyId: string, models: string[], checkedAt = now()) {
    const group = this.db.providerApiKeyGroups.find((item) => item.id === groupId);
    if (!group) throw new Error("API Key 分组不存在");
    const apiKey = group.apiKeys.find((item) => item.id === apiKeyId);
    if (!apiKey) throw new Error("API Key 不存在");
    apiKey.models = Array.from(new Set(models.map((model) => String(model).trim()).filter(Boolean))).sort();
    apiKey.lastCheckedAt = checkedAt;
    group.updatedAt = now();
    this.syncSiteModelsFromProviderKeys(group.siteId);
    this.refreshGroupRouteMembers();
    this.persist();
    return this.toProviderApiKeyGroupView(group);
  }

  resolveProviderApiKey(siteId: string, model: string) {
    const candidates = this.db.providerApiKeyGroups
      .filter((group) => group.siteId === siteId)
      .flatMap((group) => group.apiKeys)
      .filter((apiKey) => apiKey.enabled);
    return (
      candidates.find((apiKey) => apiKey.models.includes(model)) ||
      candidates.find((apiKey) => apiKey.models.length === 0)
    );
  }

  verifyApiKey(secret?: string) {
    if (this.db.apiKeys.length === 0) return true;
    if (!secret) return false;
    const keyHash = hashSecret(secret.replace(/^Bearer\s+/i, "").trim());
    const found = this.db.apiKeys.find((key) => key.enabled && key.keyHash === keyHash);
    if (!found) return false;
    found.lastUsedAt = now();
    this.persist();
    return true;
  }

  upsertHeaderTemplate(input: Partial<HeaderTemplate>) {
    const timestamp = now();
    if (!input.name?.trim()) throw new Error("模版名称不能为空");

    if (input.id) {
      const current = this.db.headerTemplates.find((template) => template.id === input.id);
      if (!current) throw new Error("Header 模版不存在");
      Object.assign(current, {
        name: input.name.trim(),
        headersText: input.headersText || "",
        updatedAt: timestamp
      });
      this.persist();
      return current;
    }

    const created: HeaderTemplate = {
      id: `header-${randomUUID()}`,
      name: input.name.trim(),
      headersText: input.headersText || "",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.headerTemplates.unshift(created);
    this.persist();
    return created;
  }

  deleteHeaderTemplate(id: string) {
    this.db.headerTemplates = this.db.headerTemplates.filter((template) => template.id !== id);
    this.db.routes = this.db.routes.map((route) => {
      if ((route.type === "switch" || route.type === "group") && route.headerTemplateId === id) {
        return { ...route, headerTemplateId: undefined, updatedAt: now() };
      }
      return route;
    });
    this.persist();
  }

  upsertRoute(input: Partial<RouteRecord>) {
    const current = input.id ? this.db.routes.find((route) => route.id === input.id) : undefined;
    const routeType = input.type || current?.type || "switch";
    return routeType === "group"
      ? this.upsertGroupRoute(input as Partial<GroupRoute>)
      : this.upsertSwitchRoute(input as Partial<SwitchRoute>);
  }

  upsertSwitchRoute(input: Partial<SwitchRoute>) {
    const timestamp = now();
    if (!input.name?.trim()) throw new Error("路由名称不能为空");
    if (!input.siteId) throw new Error("请选择供应商");
    if (!input.model?.trim()) throw new Error("请选择模型");

    const site = this.db.sites.find((item) => item.id === input.siteId);
    if (!site) throw new Error("供应商不可用");

    const routeShape = {
      name: input.name.trim(),
      type: "switch" as const,
      siteId: input.siteId,
      addressId: undefined,
      model: input.model.trim(),
      endpoint: input.endpoint || "messages",
      headerTemplateId: input.headerTemplateId || undefined,
      enabled: input.enabled ?? true,
      updatedAt: timestamp
    };

    if (input.id) {
      const index = this.db.routes.findIndex((route) => route.id === input.id);
      if (index < 0) throw new Error("路由不存在");
      const current = this.db.routes[index];
      if (current.type === "switch") {
        Object.assign(current, routeShape);
      } else {
        this.db.routes[index] = {
          id: current.id,
          createdAt: current.createdAt,
          ...routeShape
        };
      }
      this.persist();
      return this.db.routes[index] as SwitchRoute;
    }

    const created: SwitchRoute = {
      id: `route-${randomUUID()}`,
      createdAt: timestamp,
      ...routeShape
    };
    this.db.routes.unshift(created);
    this.persist();
    return created;
  }

  upsertGroupRoute(input: Partial<GroupRoute>) {
    const timestamp = now();
    if (!input.name?.trim()) throw new Error("路由名称不能为空");
    const strategy = normalizeGroupStrategy(input.strategy);
    const current = input.id ? this.db.routes.find((route) => route.id === input.id) : undefined;
    const currentGroup = current?.type === "group" ? current : undefined;
    const matchRule = normalizeMatchRule(input.matchRule ?? currentGroup?.matchRule ?? input.modelGroupId ?? input.name);
    const members = this.normalizeGroupRouteMembers(
      input.members ?? currentGroup?.members ?? [],
      matchRule,
      input.modelGroupId ?? currentGroup?.modelGroupId
    );
    if (members.length === 0) throw new Error("请至少选择一个组内模型，或填写能匹配到模型的规则");

    const routeShape = {
      name: input.name.trim(),
      type: "group" as const,
      strategy,
      modelGroupId: input.modelGroupId?.trim() || undefined,
      matchRule,
      members,
      endpoint: input.endpoint || "messages",
      headerTemplateId: input.headerTemplateId || undefined,
      enabled: input.enabled ?? true,
      updatedAt: timestamp
    };

    if (input.id) {
      const index = this.db.routes.findIndex((route) => route.id === input.id);
      if (index < 0) throw new Error("路由不存在");
      const saved = this.db.routes[index];
      if (saved.type === "group") {
        Object.assign(saved, routeShape);
      } else {
        this.db.routes[index] = {
          id: saved.id,
          createdAt: saved.createdAt,
          ...routeShape
        };
      }
      this.persist();
      return this.db.routes[index] as GroupRoute;
    }

    const created: GroupRoute = {
      id: `route-${randomUUID()}`,
      createdAt: timestamp,
      ...routeShape
    };
    this.db.routes.unshift(created);
    this.persist();
    return created;
  }

  deleteRoute(id: string) {
    this.db.routes = this.db.routes.filter((route) => route.id !== id);
    this.persist();
  }

  resolveRoute(routeNameOrId: string) {
    const route = this.db.routes.find((item) => item.id === routeNameOrId || item.name === routeNameOrId);
    if (!route || route.type !== "switch" || !route.enabled) {
      throw new Error("切换型路由不存在或已停用");
    }
    const site = this.db.sites.find((item) => item.id === route.siteId);
    const addresses = site?.addresses.filter((address) => address.enabled) || [];
    if (!site || addresses.length === 0) throw new Error("路由绑定的供应商地址不可用");
    const headerTemplate = route.headerTemplateId
      ? this.db.headerTemplates.find((item) => item.id === route.headerTemplateId)
      : undefined;
    return { route, site, addresses, headerTemplate };
  }

  private normalizeGroupRouteMembers(inputMembers: Array<Partial<GroupRouteMember>> = [], matchRule = "", legacyModelGroupId?: string) {
    const members = new Map<string, GroupRouteMember>();
    const addMember = (input: Partial<GroupRouteMember>) => {
      const siteId = input.siteId?.trim();
      const apiKeyId = input.apiKeyId?.trim();
      const model = input.model?.trim();
      if (!siteId || !apiKeyId || !model) return;
      const group = this.db.providerApiKeyGroups.find((item) => item.siteId === siteId && item.apiKeys.some((apiKey) => apiKey.id === apiKeyId));
      const apiKey = group?.apiKeys.find((item) => item.id === apiKeyId);
      if (!group || !apiKey || !apiKey.models.includes(model)) return;
      const member = { siteId, apiKeyId, model };
      members.set(groupMemberKey(member), member);
    };

    for (const member of inputMembers) addMember(member);

    const addMatchingModels = (rule: string) => {
      if (!rule.trim()) return;
      for (const group of this.db.providerApiKeyGroups) {
        for (const apiKey of group.apiKeys) {
          for (const model of apiKey.models) {
            if (smartModelMatches(model, rule)) addMember({ siteId: group.siteId, apiKeyId: apiKey.id, model });
          }
        }
      }
    };

    addMatchingModels(matchRule);
    if (members.size === 0 && legacyModelGroupId) addMatchingModels(legacyModelGroupId);
    return Array.from(members.values());
  }

  private refreshGroupRouteMembers() {
    this.db.routes = this.db.routes.map((route) => {
      if (route.type !== "group") return route;
      const matchRule = normalizeMatchRule(route.matchRule || route.modelGroupId || route.name);
      const members = this.normalizeGroupRouteMembers(route.members || [], matchRule, route.modelGroupId);
      const oldKeys = (route.members || []).map(groupMemberKey).sort().join("\n");
      const newKeys = members.map(groupMemberKey).sort().join("\n");
      if (matchRule === route.matchRule && oldKeys === newKeys) return route;
      return {
        ...route,
        matchRule,
        members,
        updatedAt: now()
      };
    });
  }

  private normalizeAddress(address: Partial<SiteAddress>): SiteAddress {
    if (!address.label?.trim()) throw new Error("地址名称不能为空");
    if (!address.baseUrl?.trim()) throw new Error("地址 URL 不能为空");
    const models = Array.isArray(address.models)
      ? address.models.map((model) => String(model).trim()).filter(Boolean)
      : [];
    return {
      id: address.id || `addr-${randomUUID()}`,
      label: address.label.trim(),
      baseUrl: normalizeBaseUrl(address.baseUrl),
      enabled: address.enabled ?? true,
      models
    };
  }

  private load(): AppDatabase {
    if (!existsSync(this.dbPath)) {
      const empty = createEmptyDatabase();
      this.persistDatabase(empty);
      this.persistTemporaryAccounts(empty.temporaryAccountGroups);
      return empty;
    }
    const parsed = JSON.parse(readFileSync(this.dbPath, "utf8")) as Partial<AppDatabase>;
    const settings = normalizeSettings(parsed.settings);
    const legacyRequestLogs = (parsed as Partial<AppDatabase> & { requestLogs?: RequestLog[] }).requestLogs || [];
    this.requestLogs = this.loadRequestLogs(settings.maxRequestLogs, legacyRequestLogs);
    if (!existsSync(this.logsPath) && legacyRequestLogs.length > 0) {
      this.rewriteRequestLogFile();
    }
    const legacyTemporaryAccountGroups = parsed.temporaryAccountGroups || [];
    const db: AppDatabase = {
      sites: (parsed.sites || []).map((site) => ({ ...site, siteType: normalizeSiteType(site.siteType) })),
      apiKeys: parsed.apiKeys || [],
      providerApiKeyGroups: parsed.providerApiKeyGroups || [],
      temporaryAccountGroups: this.loadTemporaryAccountGroups(legacyTemporaryAccountGroups),
      headerTemplates: parsed.headerTemplates || [],
      routes: (parsed.routes || []) as RouteRecord[],
      settings,
      adminPasswordHash: normalizePasswordHash(parsed.adminPasswordHash)
    };
    if (legacyTemporaryAccountGroups.length > 0) {
      this.persistDatabase(db);
      this.persistTemporaryAccounts(db.temporaryAccountGroups);
    }
    return db;
  }

  private loadTemporaryAccountGroups(fallback: TemporaryAccountGroup[] = []) {
    const source = existsSync(this.temporaryAccountsPath)
      ? JSON.parse(readFileSync(this.temporaryAccountsPath, "utf8")) as TemporaryAccountGroup[]
      : fallback;
    return source.map((group) => ({
      ...group,
      strategy: normalizeGroupStrategy(group.strategy),
      accounts: (group.accounts || []).map((account) => ({
        ...account,
        accountType: account.accountType || (account.accountId ? "codex" : account.secret?.startsWith("sk-") ? "openai-api-key" : undefined),
        models: normalizeModelList(account.models),
        availability: normalizeTemporaryAccountAvailability(account.availability),
        quotaStages: Array.isArray(account.quotaStages) ? account.quotaStages : []
      }))
    }));
  }

  private loadRequestLogs(limit: number, fallback: RequestLog[] = []) {
    if (!existsSync(this.logsPath)) return fallback.slice(0, limit);
    const lines = readFileSync(this.logsPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const logs: RequestLog[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as RequestLog;
        if (parsed.id && parsed.createdAt) logs.push(parsed);
      } catch {
        // Ignore malformed log lines so one bad append does not break startup.
      }
    }
    return logs.reverse().slice(0, limit);
  }

  private rewriteRequestLogFile() {
    const content = this.requestLogs
      .slice()
      .reverse()
      .map((log) => JSON.stringify(log))
      .join("\n");
    writeFileSync(this.logsPath, content ? `${content}\n` : "");
  }

  private persist() {
    this.persistDatabase(this.db);
    this.persistTemporaryAccounts(this.db.temporaryAccountGroups);
  }

  private persistDatabase(db: AppDatabase) {
    const { temporaryAccountGroups, ...database } = db;
    void temporaryAccountGroups;
    const tempPath = `${this.dbPath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(database, null, 2));
    renameSync(tempPath, this.dbPath);
  }

  private persistTemporaryAccounts(groups: TemporaryAccountGroup[]) {
    const tempPath = `${this.temporaryAccountsPath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(groups, null, 2));
    renameSync(tempPath, this.temporaryAccountsPath);
  }

  private normalizeProviderApiKeyEntry(input: Partial<ProviderApiKeyEntry>, index: number, existingKeys: ProviderApiKeyEntry[] = []): ProviderApiKeyEntry {
    const existing = input.id ? existingKeys.find((key) => key.id === input.id) : undefined;
    const secret = input.secret?.trim() || existing?.secret;
    if (!secret) throw new Error(`第 ${index + 1} 个 API Key 不能为空`);
    const models = Array.isArray(input.models)
      ? Array.from(new Set(input.models.map((model) => String(model).trim()).filter(Boolean))).sort()
      : [];
    return {
      id: input.id || `provider-key-${randomUUID()}`,
      label: input.label?.trim() || `Key ${index + 1}`,
      prefix: secret.slice(0, 10),
      secret,
      enabled: input.enabled ?? true,
      models,
      lastCheckedAt: input.lastCheckedAt
    };
  }

  private toProviderApiKeyGroupView(group: ProviderApiKeyGroup) {
    const site = this.db.sites.find((item) => item.id === group.siteId);
    return {
      ...group,
      groupName: group.groupName || site?.name || "API Key 分组",
      apiKeys: group.apiKeys.map((apiKey) => ({ ...apiKey }))
    };
  }

  private syncOpenAiModelsFromTemporaryAccounts() {
    const site = this.officialOpenAiSite();
    if (!site) return false;
    const importedModels = this.db.temporaryAccountGroups
      .filter((group) => group.siteId === site.id)
      .flatMap((group) => group.accounts.flatMap((account) => account.models));
    const models = Array.from(new Set([...OPENAI_DEFAULT_MODELS, ...importedModels].filter(Boolean))).sort();
    let changed = false;
    site.addresses = site.addresses.map((address) => {
      if (JSON.stringify(address.models) === JSON.stringify(models)) return address;
      changed = true;
      return { ...address, models };
    });
    if (changed) site.updatedAt = now();
    return changed;
  }

  private syncSiteModelsFromProviderKeys(siteId: string) {
    const site = this.db.sites.find((item) => item.id === siteId);
    if (!site) return;
    const models = Array.from(
      new Set(
        this.db.providerApiKeyGroups
          .filter((group) => group.siteId === siteId)
          .flatMap((group) => group.apiKeys.filter((key) => key.enabled).flatMap((key) => key.models))
          .filter(Boolean)
      )
    ).sort();
    site.addresses = site.addresses.map((address) => ({ ...address, models }));
    site.updatedAt = now();
  }
}

export function parseHeaderTemplate(headersText = "") {
  const headers: Record<string, string> = {};
  for (const rawLine of headersText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
      return process.env[name] || "";
    });
    if (key) headers[key] = value;
  }
  return headers;
}
