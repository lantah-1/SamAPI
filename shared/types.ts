export type EndpointKind = "messages" | "chat/completions" | "responses";

export type RouteType = "switch" | "group";

export type SiteType = "newapi" | "unknown";

export type GroupRouteStrategy = "stable-first" | "sequential" | "random";

export type RouteProxyMode = "direct" | "system" | "custom";

export interface RouteProxyConfig {
  mode: RouteProxyMode;
  url?: string;
}

export type AppThemeId = "fresh" | "salt" | "citrus" | "rose" | "midnight";

export type TemporaryAccountImportSource = "cpa" | "subapi";

export type TemporaryAccountProviderType = "gpt" | "grok" | "claude" | "gemini";

export type TemporaryAccountAvailability = "unknown" | "available" | "unavailable";

export interface SiteAddress {
  id: string;
  label: string;
  baseUrl: string;
  enabled: boolean;
  models: string[];
}

export interface Site {
  id: string;
  name: string;
  siteType: SiteType;
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

export type ProviderApiKeyKind = "api-key" | "chatgpt-official";

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
  apiKeys?: ProviderApiKeyEntryInput[];
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
  accountType?: "codex" | "openai-api-key";
  providerType?: TemporaryAccountProviderType;
  accountId?: string;
  email?: string;
  refreshToken?: string;
  idToken?: string;
  sessionToken?: string;
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
  total?: number | string;
  used?: number | string;
  unit?: string;
  resetAt?: string;
}

export interface TemporaryAccountGroup {
  id: string;
  name: string;
  source: TemporaryAccountImportSource;
  providerType?: TemporaryAccountProviderType;
  siteId: string;
  strategy?: GroupRouteStrategy;
  enabled: boolean;
  accounts: TemporaryAccount[];
  createdAt: string;
  updatedAt: string;
}

export interface TemporaryAccountImportInput {
  name?: string;
  source?: TemporaryAccountImportSource;
  providerType?: TemporaryAccountProviderType;
  content: string;
  contents?: string[];
  models?: string[];
}

export interface TemporaryAccountImportResult {
  site: Site;
  group: TemporaryAccountGroup;
  imported: number;
  skipped: number;
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
  proxy?: RouteProxyConfig;
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
  endpoint: EndpointKind;
  headerTemplateId?: string;
  proxy?: RouteProxyConfig;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type RouteRecord = SwitchRoute | GroupRoute;

export type RequestLogStatus = "pending" | "success" | "failed";

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

export interface RequestLogUpstreamAttempt {
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

export interface RequestLog {
  id: string;
  createdAt: string;
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
  status: RequestLogStatus;
  statusCode: number;
  durationMs: number;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  upstreamUrl?: string;
  upstreamContentType?: string;
  responsePreview?: string;
  errorMessage?: string;
  downstream?: RequestLogDownstream;
  routeTarget?: RequestLogRouteTarget;
  upstreamAttempts?: RequestLogUpstreamAttempt[];
  proxy?: RequestLogProxy;
  summary?: string;
}

export interface RequestLogSummary {
  id: string;
  createdAt: string;
  status: RequestLogStatus;
  statusCode: number;
  durationMs: number;
  downstream: RequestLogDownstream;
  routeName: string;
  routeId?: string;
  routeTarget: RequestLogRouteTarget;
  providerName: string;
  providerId?: string;
  model: string;
  headerTemplateId?: string;
  headerTemplateName?: string;
  upstreamUrl?: string;
  proxy?: RequestLogProxy;
  errorMessage?: string;
  summary?: string;
}

export interface RequestLogPage {
  items: RequestLogSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface AppSettings {
  maxRequestLogs: number;
  themeId: AppThemeId;
  adminSessionTtlMinutes: number;
  temporaryAccountStrategy: GroupRouteStrategy;
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
  settings: AppSettings;
  adminPasswordHash?: string;
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
