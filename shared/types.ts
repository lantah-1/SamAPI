export type EndpointKind = "messages" | "chat/completions" | "responses";

export type RouteType = "switch" | "group";

export type SiteType = "newapi" | "unknown";

export type GroupRouteStrategy = "stable-first" | "sequential" | "random";

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
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export interface ApiKeyCreated extends ApiKeyRecord {
  plainTextKey: string;
}

export interface ProviderApiKeyEntry {
  id: string;
  label: string;
  prefix: string;
  secret: string;
  enabled: boolean;
  models: string[];
  lastCheckedAt?: string;
}

export interface ProviderApiKeyEntryView extends ProviderApiKeyEntry {}

export interface ProviderApiKeyEntryInput {
  id?: string;
  label?: string;
  secret?: string;
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
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type RouteRecord = SwitchRoute | GroupRoute;

export type RequestLogStatus = "success" | "failed";

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
  summary?: string;
}

export interface AppSettings {
  maxRequestLogs: number;
}

export interface AppDatabase {
  sites: Site[];
  apiKeys: ApiKeyRecord[];
  providerApiKeyGroups: ProviderApiKeyGroup[];
  headerTemplates: HeaderTemplate[];
  routes: RouteRecord[];
  settings: AppSettings;
}

export interface AppSnapshot extends Omit<AppDatabase, "providerApiKeyGroups"> {
  providerApiKeyGroups: ProviderApiKeyGroupView[];
  requestLogs: RequestLog[];
  dbPath: string;
  dataDir: string;
  endpoints: EndpointKind[];
}
