export type EndpointKind = "messages" | "chat/completions" | "responses";

export type RouteType = "switch" | "group";

export type SiteType = "newapi" | "unknown";

export type GroupRouteStrategy = "stable-first" | "sequential" | "random" | "priority" | "specified";

export type RouteProxyMode = "direct" | "system" | "custom";

export interface RouteProxyConfig {
  mode: RouteProxyMode;
  url?: string;
}

export type AppThemeId = "fresh" | "salt" | "citrus" | "rose" | "midnight";

export type TemporaryAccountImportSource = "cpa" | "subapi";

export type TemporaryAccountImportMode = "auto" | "subapi" | "sub2api-k12" | "cpa" | "auth-json" | "zip";

export type TemporaryAccountProviderType = "gpt" | "grok" | "claude" | "gemini" | "deepseek";

export type TemporaryAccountAvailability = "unknown" | "available" | "unavailable";

export type GrokOAuthFormat = "cpa-oauth" | "grok2api-oauth";

export interface SiteAddress {
  id: string;
  label: string;
  baseUrl: string;
  enabled: boolean;
  models: string[];
  proxy?: RouteProxyConfig;
}

export interface Site {
  id: string;
  name: string;
  siteType: SiteType;
  enabled: boolean;
  addresses: SiteAddress[];
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  keyHash: string;
  plainTextKey?: string;
  enabled: boolean;
  models: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export interface ApiKeyCreated extends ApiKeyRecord {
  plainTextKey: string;
}

export type ProviderApiKeyKind = "api-key" | "chatgpt-official" | "grok-official" | "account-pool";

export type ProviderModelManageMode = "auto" | "manual";

export type ProviderModelSyncStatus = "success" | "failed" | "partial";

export interface ProviderApiKeyEntry {
  id: string;
  label: string;
  prefix: string;
  secret: string;
  kind?: ProviderApiKeyKind;
  enabled: boolean;
  models: string[];
  lastCheckedAt?: string;
}

export interface ProviderApiKeyEntryView extends ProviderApiKeyEntry {}

export interface ProviderApiKeyEntryInput {
  id?: string;
  label?: string;
  secret?: string;
  kind?: ProviderApiKeyKind;
  enabled?: boolean;
  models?: string[];
  lastCheckedAt?: string;
}

export interface ProviderApiKeyGroup {
  id: string;
  siteId: string;
  groupName: string;
  modelManageMode: ProviderModelManageMode;
  lastModelSyncAt?: string;
  lastModelSyncStatus?: ProviderModelSyncStatus;
  lastModelSyncMessage?: string;
  apiKeys: ProviderApiKeyEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface ProviderApiKeyGroupView extends Omit<ProviderApiKeyGroup, "apiKeys"> {
  apiKeys: ProviderApiKeyEntryView[];
}

export interface ProviderApiKeyGroupInput {
  id?: string;
  siteId?: string;
  groupName?: string;
  modelManageMode?: ProviderModelManageMode;
  apiKeys?: ProviderApiKeyEntryInput[];
}

export interface ProviderModelSyncOptions {
  mode?: ProviderModelManageMode | "all";
  groupIds?: string[];
}

export interface ProviderModelSyncItemResult {
  groupId: string;
  apiKeyId: string;
  siteId: string;
  siteName: string;
  apiKeyLabel: string;
  status: RequestLogStatus;
  modelCount: number;
  models?: string[];
  errorMessage?: string;
}

export interface ProviderModelSyncResult {
  total: number;
  success: number;
  failed: number;
  results: ProviderModelSyncItemResult[];
}

export interface ProviderModelGroupOption {
  groupName: string;
  models: string[];
}

export interface ProviderModelDiscoverResult {
  siteId: string;
  siteName: string;
  addressId: string;
  addressLabel: string;
  models: string[];
  modelGroups?: ProviderModelGroupOption[];
}

export interface TemporaryAccount {
  id: string;
  label: string;
  prefix: string;
  secret: string;
  accountType?: "codex" | "openai-api-key" | "api-key";
  providerType?: TemporaryAccountProviderType;
  accountId?: string;
  email?: string;
  refreshToken?: string;
  idToken?: string;
  sessionToken?: string;
  /** Sub2API OpenAI Agent Identity (base64 PKCS#8 Ed25519 key). */
  agentRuntimeId?: string;
  agentPrivateKey?: string;
  agentTaskId?: string;
  chatgptUserId?: string;
  chatgptAccountIsFedramp?: boolean;
  grokOAuthFormat?: GrokOAuthFormat;
  oauthClientId?: string;
  oauthTokenEndpoint?: string;
  upstreamBaseUrl?: string;
  tokenExpiresAt?: string;
  grokUsingApi?: boolean;
  enabled: boolean;
  models: string[];
  availability?: TemporaryAccountAvailability;
  quotaStages: TemporaryAccountQuotaStage[];
  importedAt: string;
  lastQuotaCheckedAt?: string;
  lastCheckStatusCode?: number;
  lastCheckError?: string;
}

export interface TemporaryAccountQuotaStage {
  label: string;
  remaining?: number | string;
  unlimited?: boolean;
  total?: number | string;
  used?: number | string;
  unit?: string;
  resetAt?: string;
  /** 可用重置卡的到期时间；卡 ID 不会暴露给前端。 */
  resetCreditExpiresAt?: string[];
}

export interface TemporaryAccountGroup {
  id: string;
  name: string;
  source: TemporaryAccountImportSource;
  providerType?: TemporaryAccountProviderType;
  siteId: string;
  strategy?: GroupRouteStrategy;
  preferredAccountId?: string;
  enabled: boolean;
  accounts: TemporaryAccount[];
  createdAt: string;
  updatedAt: string;
}

export interface TemporaryAccountImportInput {
  name?: string;
  source?: TemporaryAccountImportSource;
  mode?: TemporaryAccountImportMode;
  providerType?: TemporaryAccountProviderType;
  content: string;
  contents?: string[];
  fileNames?: string[];
  models?: string[];
  checkProxy?: RouteProxyConfig;
}

export interface TemporaryAccountImportResult {
  site: Site;
  group: TemporaryAccountGroup;
  imported: number;
  skipped: number;
  unrecognizedFiles?: string[];
  accountIds?: string[];
  checkResult?: TemporaryAccountCheckResult;
}

export interface TemporaryAccountCheckItemResult {
  groupId: string;
  accountId: string;
  label: string;
  availability: TemporaryAccountAvailability;
  status: RequestLogStatus;
  statusCode?: number;
  quotaStages: TemporaryAccountQuotaStage[];
  errorMessage?: string;
  checkedAt: string;
}

export interface TemporaryAccountCheckResult {
  total: number;
  available: number;
  unavailable: number;
  unknown: number;
  results: TemporaryAccountCheckItemResult[];
}

export interface TemporaryAccountCheckOptions {
  providerType?: TemporaryAccountProviderType;
  proxy?: RouteProxyConfig;
}

export interface HeaderTemplate {
  id: string;
  name: string;
  headersText: string;
  createdAt: string;
  updatedAt: string;
}

export interface SwitchRoute {
  id: string;
  name: string;
  type: "switch";
  siteId: string;
  addressId?: string;
  model: string;
  endpoint: EndpointKind;
  headerTemplateId?: string;
  /** Optional managed account pin used by a direct model mapping. */
  temporaryAccountId?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GroupRouteMember {
  siteId: string;
  apiKeyId: string;
  model: string;
}

export interface GroupRoute {
  id: string;
  name: string;
  type: "group";
  strategy: GroupRouteStrategy;
  modelGroupId?: string;
  matchRule: string;
  members: GroupRouteMember[];
  specifiedMember?: GroupRouteMember;
  endpoint: EndpointKind;
  headerTemplateId?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type RouteRecord = SwitchRoute | GroupRoute;

export interface RouteDisplayGroup {
  id: string;
  name: string;
  routeIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type RequestLogStatus = "pending" | "success" | "failed" | "cancelled";

export interface RequestLogDownstream {
  model?: string;
  endpoint?: string;
  userAgent?: string;
  path?: string;
  method?: string;
}

export interface RequestLogRouteTarget {
  routeName?: string;
  model?: string;
  endpoint?: string;
  providerName?: string;
  userAgent?: string;
}

export interface RequestLogProxy {
  mode: RouteProxyMode;
  url?: string;
  source?: "route" | "system" | "env";
  retried?: boolean;
}

export interface RequestLogUpstreamRequest {
  addressLabel?: string;
  upstreamUrl: string;
  method: string;
  model: string;
  endpoint?: string;
  userAgent?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  status: RequestLogStatus;
  statusCode: number;
  durationMs: number;
  contentType?: string;
  responsePreview?: string;
  errorMessage?: string;
}

export type RequestLogStage = "receiving-request" | "preparing-upstream" | "waiting-upstream" | "receiving-upstream" | "waiting-retry" | "forwarding-response";

export interface RequestLogAccount {
  id: string;
  label: string;
}

export interface RequestLogUserAgent {
  /** Absent when no User-Agent header was set and the HTTP runtime supplies its default. */
  value?: string;
  source: "template" | "downstream" | "codex" | "grok" | "default";
  template?: Pick<HeaderTemplate, "id" | "name">;
}

/** Transient context accepted by the logger; only the compact RequestLog is persisted. */
export interface RequestLogInput {
  id: string;
  createdAt: string;
  /** A failed/retried upstream attempt belonging to this downstream request. */
  parentRequestId?: string;
  routeName: string;
  routeId?: string;
  method: string;
  path: string;
  endpoint?: EndpointKind;
  providerName: string;
  providerId?: string;
  addressLabel?: string;
  model: string;
  userAgent: string;
  clientIp: string;
  clientDevice?: string;
  apiKeyId?: string;
  apiKeyName?: string;
  status: RequestLogStatus;
  stage?: RequestLogStage;
  statusCode: number;
  durationMs: number;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  upstreamUrl?: string;
  /** Snapshot of the selected upstream account; null clears an earlier attempt's account. */
  upstreamAccount?: RequestLogAccount | null;
  upstreamUserAgent?: RequestLogUserAgent;
  upstreamContentType?: string;
  /** First event that released the response prelude; helps explain failures after streaming began. */
  streamStartedWith?: string;
  responsePreview?: string;
  errorMessage?: string;
  downstream?: RequestLogDownstream;
  routeTarget?: RequestLogRouteTarget;
  upstreamRequest?: RequestLogUpstreamRequest;
  proxy?: RequestLogProxy;
  summary?: string;
}

export interface RequestLogUpstream {
  provider: string;
  model: string;
  url: string;
  account?: RequestLogAccount;
  userAgent?: RequestLogUserAgent;
}

export interface RequestLogResult {
  status: RequestLogStatus;
  /** Observed stage of a pending request; absent on completed and legacy logs. */
  stage?: RequestLogStage;
  statusCode: number;
  body: string;
  streamStartedWith?: string;
}

export type RequestLogPhase = "running" | "waiting-tools" | "returned" | "failed" | "cancelled";

export interface RequestLogAttempt {
  id: string;
  createdAt: string;
  updatedAt: string;
  upstream?: RequestLogUpstream;
  result: RequestLogResult;
}

export interface RequestLogCall {
  id: string;
  createdAt: string;
  updatedAt: string;
  result: RequestLogResult;
  attempts: RequestLogAttempt[];
}

export interface RequestLogTool {
  id: string;
  requestId: string;
  resultRequestId?: string;
  callId?: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: RequestLogStatus;
  result: string;
}

export interface RequestLog {
  id: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  /** Model-list requests are independent operations, not user conversation turns. */
  kind?: "models";
  /** Masked headers from the first downstream request, stored once for the whole turn. */
  requestHeaders: Record<string, string>;
  /** Only this turn's user input, resolved from the shared message record. */
  msg: string[];
  upstream?: RequestLogUpstream;
  result: RequestLogResult;
  /** A completed call/attempt in calls to retain above the pending result. */
  previousResultId?: string;
  phase: RequestLogPhase;
  calls: RequestLogCall[];
  tools: RequestLogTool[];
}

export interface RequestLogSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  kind?: RequestLog["kind"];
  msg: string;
  messageCount: number;
  upstream?: RequestLogUpstream;
  result: RequestLogResult;
  phase: RequestLogPhase;
  requestCount: number;
  attemptCount: number;
  toolCount: number;
}

export interface RequestLogPage {
  items: RequestLogSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface UpstreamRetryCodeCount {
  statusCode: number;
  count: number;
}

export type UpstreamRetryDelay =
  | { mode: "immediate" }
  | { mode: "fixed"; seconds: number }
  | { mode: "random"; minSeconds: number; maxSeconds: number };

export type ModelRuleMatch = "exact" | "contains" | "prefix";

export type ModelRuleCondition = {
  source: "header";
  header: string;
  match: ModelRuleMatch;
  value: string;
} | {
  source: "project";
  match: ModelRuleMatch;
  value: string;
};

export interface DownstreamModelRule {
  id: string;
  name: string;
  enabled: boolean;
  model: string;
  /** 兼容已有路由映射；新映射直接选择供应商和模型。 */
  targetRouteId?: string;
  targetSiteId?: string;
  targetModel?: string;
  /** Direct mappings can apply a different upstream request-header template. */
  headerTemplateId?: string;
  /** Direct mappings to the official OpenAI site may pin one GPT account. */
  temporaryAccountId?: string;
  /** 空列表表示仅按下游模型名匹配，不限制客户端或项目。 */
  conditions: ModelRuleCondition[];
}

export interface AppSettings {
  maxRequestLogs: number;
  requestTimeoutSeconds: number;
  themeId: AppThemeId;
  adminSessionTtlMinutes: number;
  temporaryAccountStrategy: GroupRouteStrategy;
  /** 上游返回对应错误码时的重试次数配置；仅配置过的错误码会重试，0 表示禁用。 */
  upstreamRetryCodeCounts: UpstreamRetryCodeCount[];
  /** 每次错误码重试前的等待规则；首次请求及耗尽重试后的目标切换不等待。 */
  upstreamRetryDelay: UpstreamRetryDelay;
  /** 按顺序匹配下游模型及全部条件，只应用第一条命中的规则。 */
  downstreamModelRules: DownstreamModelRule[];
}

export interface AuthSession {
  authenticated: boolean;
  expiresAt?: string;
}

export interface AppDatabase {
  sites: Site[];
  apiKeys: ApiKeyRecord[];
  providerApiKeyGroups: ProviderApiKeyGroup[];
  temporaryAccountGroups: TemporaryAccountGroup[];
  headerTemplates: HeaderTemplate[];
  routes: RouteRecord[];
  routeDisplayGroups: RouteDisplayGroup[];
  settings: AppSettings;
  adminPasswordHash?: string;
}

export interface AppBackupData extends Omit<AppDatabase, "adminPasswordHash"> {}

export interface AppBackup {
  format: "samapi-backup";
  version: 1;
  accountPolicyVersion?: 1 | 2;
  exportedAt: string;
  data: AppBackupData;
}

export interface AppBackupImportResult {
  ok: true;
  importedAt: string;
  counts: {
    sites: number;
    apiKeys: number;
    providerApiKeyGroups: number;
    temporaryAccounts: number;
    headerTemplates: number;
    routes: number;
  };
}

export interface AppSnapshot extends Omit<AppDatabase, "providerApiKeyGroups" | "adminPasswordHash"> {
  providerApiKeyGroups: ProviderApiKeyGroupView[];
  requestLogs: RequestLogSummary[];
  dbPath: string;
  dataDir: string;
  endpoints: EndpointKind[];
  security: {
    adminPasswordCustomized: boolean;
  };
}

export interface AppBootstrap {
  dbPath: string;
  dataDir: string;
  endpoints: EndpointKind[];
  security: {
    adminPasswordCustomized: boolean;
  };
}
