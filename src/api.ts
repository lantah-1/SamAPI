import type { ModelPrice, ModelPriceInput, ModelPriceSyncReport, UsageEstimationResult, UsageFilters, UsageReport } from "../shared/usage";
import type { AccountProvider, ManagedAccount, ManagedAccountInput, ManagedAccountPatch, ManagedAccountsSnapshot } from "../shared/accounts";
import type {
  ApiKeyCreated,
  ApiKeyRecord,
  AppBackup,
  AppBackupImportResult,
  AppBootstrap,
  AppSettings,
  AuthSession,
  HeaderTemplate,
  ProviderApiKeyGroupInput,
  ProviderApiKeyGroupView,
  ProviderModelDiscoverResult,
  ProviderModelManageMode,
  ProviderModelSyncOptions,
  ProviderModelSyncResult,
  RequestLog,
  RequestLogPage,
  RouteDisplayGroup,
  RouteRecord,
  Site,
  TemporaryAccountCheckResult,
  TemporaryAccountGroup,
  TemporaryAccountImportInput,
  TemporaryAccountImportResult,
} from "../shared/types";

export class ApiError extends Error {
  readonly status: number;
  readonly payload?: unknown;

  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export function isUnauthorizedError(error: unknown) {
  return error instanceof ApiError && error.status === 401;
}

// 运行时从当前页面路径推导挂载前缀，无需 build 时烤入。
// SamAPI 无客户端路由，URL 始终停在挂载点(如 /samapi/ 或 /samapi/index.html)，
// 取其所在目录即为前缀。根路径部署时目录为 "/"，前缀为空。
function detectBasePrefix(): string {
  if (typeof window === "undefined") return "";
  // pathname 形如 "/samapi/" 或 "/samapi/index.html" 或 "/"
  const pathname = window.location.pathname;
  // 取最后一个 "/" 之前的目录部分
  const dir = pathname.slice(0, pathname.lastIndexOf("/") + 1);
  // 去掉末尾斜杠，"/samapi/" → "/samapi"，"/" → ""
  return dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

const BASE_PREFIX = detectBasePrefix();

function withBase(path: string): string {
  if (!path.startsWith("/")) return path;
  return `${BASE_PREFIX}${path}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(withBase(path), {
      ...init,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers || {})
      }
    });
  } catch (error) {
    const message = error instanceof Error && error.message.trim() ? error.message.trim() : "fetch failed";
    throw new Error(`API 请求失败：${message}。请确认 dev:api 正在运行且 Vite 代理可访问后端服务`);
  }
  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const text = await response.text();
  let payload: { error?: string } = {};
  if (text && isJson) {
    payload = JSON.parse(text) as { error?: string };
  }
  const fallbackMessage =
    response.status === 500 && path.startsWith("/api/")
      ? "API 服务不可用或未启动，请确认 dev:api 正在运行"
      : `Request failed: ${response.status}`;
  if (!response.ok) {
    throw new ApiError(payload.error || fallbackMessage, response.status, payload);
  }
  if (text && !isJson && path.startsWith("/api/")) {
    throw new Error("API 返回了非 JSON 内容，请确认后端服务已启动且 Vite 代理生效");
  }
  return payload as T;
}

export const api = {
  managedAccounts: () => request<ManagedAccountsSnapshot>("/api/accounts"),
  createManagedAccount: (body: ManagedAccountInput) => request<ManagedAccount>("/api/accounts", { method: "POST", body: JSON.stringify(body) }),
  updateManagedAccount: (id: string, body: ManagedAccountPatch) => request<ManagedAccount>(`/api/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteManagedAccount: (id: string) => request<{ ok: true }>(`/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  deleteManagedAccounts: (ids: string[]) => request<{ ok: true }>("/api/accounts/batch", { method: "DELETE", body: JSON.stringify({ ids }) }),
  managedAccountPolicy: (provider: AccountProvider, strategy: string) => request<ManagedAccountsSnapshot>(`/api/accounts/providers/${provider}`, { method: "PATCH", body: JSON.stringify({ strategy }) }),
  checkManagedAccount: (id: string) => request<TemporaryAccountCheckResult>(`/api/accounts/${encodeURIComponent(id)}/check`, { method: "POST" }),
  resetManagedAccount: (id: string) => request<TemporaryAccountCheckResult>(`/api/accounts/${encodeURIComponent(id)}/reset`, { method: "POST" }),
  importManagedAccounts: (body: TemporaryAccountImportInput) => request<TemporaryAccountImportResult>("/api/accounts/import", { method: "POST", body: JSON.stringify(body) }),
  temporaryAccountGroups: () => request<TemporaryAccountGroup[]>("/api/temporary-accounts"),
  startAccountOAuth: () => request<{ state: string; authorizationUrl: string; redirectUri: string }>("/api/accounts/oauth/start", { method: "POST" }),
  accountOAuthStatus: (state: string) => request<{ state: string; status: "pending" | "success" | "error"; error?: string; accountId?: string }>(`/api/accounts/oauth/status?state=${encodeURIComponent(state)}`),
  usage: (filters: UsageFilters = {}) => request<UsageReport>(`/api/usage?${usageQuery(filters)}`),
  estimateMissingUsage: (filters: UsageFilters = {}) => request<UsageEstimationResult>(`/api/usage/estimate-missing?${usageQuery(filters)}`, { method: "POST" }),
  modelPrices: () => request<ModelPrice[]>("/api/usage/prices"),
  modelPriceSync: () => request<ModelPriceSyncReport>("/api/usage/prices/sync"),
  syncModelPrices: () => request<ModelPriceSyncReport>("/api/usage/prices/sync", { method: "POST" }),
  saveModelPrice: (price: ModelPriceInput) => request<ModelPrice>("/api/usage/prices", { method: "POST", body: JSON.stringify(price) }),
  deleteModelPrice: (id: string) => request<{ ok: true }>(`/api/usage/prices/${encodeURIComponent(id)}`, { method: "DELETE" }),
  priceUnpricedUsage: () => request<{ updated: number }>("/api/usage/price-unpriced", { method: "POST" }),
  authSession: () => request<AuthSession>("/api/auth/session"),
  login: (password: string) =>
    request<AuthSession>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password })
    }),
  logout: () =>
    request<AuthSession>("/api/auth/logout", {
      method: "POST"
    }),
  updateAdminPassword: (currentPassword: string, nextPassword: string) =>
    request<AuthSession>("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, nextPassword })
  }),
  bootstrap: () => request<AppBootstrap>("/api/bootstrap"),
  listSettings: () => request<AppSettings>("/api/settings"),
  exportBackup: () => request<AppBackup>("/api/backup"),
  importBackup: (backup: AppBackup) =>
    request<AppBackupImportResult>("/api/backup", {
      method: "POST",
      body: JSON.stringify(backup)
    }),
  listSites: () => request<Site[]>("/api/sites"),
  saveSite: (site: Partial<Site>) =>
    request<Site>(site.id ? `/api/sites/${site.id}` : "/api/sites", {
      method: site.id ? "PATCH" : "POST",
      body: JSON.stringify(site)
    }),
  deleteSite: (id: string) => request<{ ok: true }>(`/api/sites/${id}`, { method: "DELETE" }),
  listKeys: () => request<ApiKeyRecord[]>("/api/keys"),
  createKey: (name: string, models: string[] = []) =>
    request<ApiKeyCreated>("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name, models })
    }),
  updateKey: (id: string, body: Partial<ApiKeyRecord>) =>
    request<ApiKeyRecord>(`/api/keys/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body)
    }),
  deleteKey: (id: string) => request<{ ok: true }>(`/api/keys/${id}`, { method: "DELETE" }),
  saveProviderKeyGroup: (group: ProviderApiKeyGroupInput) =>
    request<ProviderApiKeyGroupView>("/api/provider-key-groups", {
      method: "POST",
      body: JSON.stringify(group)
    }),
  listProviderKeyGroups: () => request<ProviderApiKeyGroupView[]>("/api/provider-key-groups"),
  deleteProviderKeyGroup: (id: string) => request<{ ok: true }>(`/api/provider-key-groups/${id}`, { method: "DELETE" }),
  updateProviderModelManageMode: (id: string, modelManageMode: ProviderModelManageMode) =>
    request<ProviderApiKeyGroupView>(`/api/provider-key-groups/${id}/model-manage-mode`, {
      method: "PATCH",
      body: JSON.stringify({ modelManageMode })
    }),
  discoverProviderModels: (siteId: string, apiKey: string, apiKeyName: string, kind?: string) =>
    request<ProviderModelDiscoverResult>("/api/provider-key-groups/discover-models", {
      method: "POST",
      body: JSON.stringify({ siteId, apiKey, apiKeyName, kind })
    }),
  syncProviderModels: (options: ProviderModelSyncOptions = {}) =>
    request<ProviderModelSyncResult>("/api/provider-key-groups/sync-models", {
      method: "POST",
      body: JSON.stringify(options)
    }),
  listHeaders: () => request<HeaderTemplate[]>("/api/headers"),
  saveHeader: (template: Partial<HeaderTemplate>) =>
    request<HeaderTemplate>(template.id ? `/api/headers/${template.id}` : "/api/headers", {
      method: template.id ? "PATCH" : "POST",
      body: JSON.stringify(template)
    }),
  deleteHeader: (id: string) => request<{ ok: true }>(`/api/headers/${id}`, { method: "DELETE" }),
  listRoutes: () => request<RouteRecord[]>("/api/routes"),
  saveRoute: (route: Partial<RouteRecord>) =>
    request<RouteRecord>(route.id ? `/api/routes/${route.id}` : "/api/routes", {
      method: route.id ? "PATCH" : "POST",
      body: JSON.stringify(route)
    }),
  deleteRoute: (id: string) => request<{ ok: true }>(`/api/routes/${id}`, { method: "DELETE" }),
  listRouteDisplayGroups: () => request<RouteDisplayGroup[]>("/api/route-display-groups"),
  saveRouteDisplayGroup: (group: Partial<RouteDisplayGroup>) =>
    request<RouteDisplayGroup>(group.id ? `/api/route-display-groups/${group.id}` : "/api/route-display-groups", {
      method: group.id ? "PATCH" : "POST",
      body: JSON.stringify(group)
    }),
  deleteRouteDisplayGroup: (id: string) => request<{ ok: true }>(`/api/route-display-groups/${id}`, { method: "DELETE" }),
  listLogs: (limit = 3, offset = 0) =>
    request<RequestLogPage>(`/api/logs?limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`),
  listNewLogs: (since: string, limit = 25) =>
    request<RequestLogPage>(`/api/logs?since=${encodeURIComponent(since)}&limit=${encodeURIComponent(String(limit))}`),
  getLog: (id: string) => request<RequestLog>(`/api/logs/${id}`),
  deleteLog: (id: string) => request<{ ok: true }>(`/api/logs/${id}`, { method: "DELETE" }),
  clearLogs: () => request<{ ok: true }>("/api/logs/clear", { method: "DELETE" }),
  updateSettings: (settings: Partial<AppSettings>) =>
    request<AppSettings>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(settings)
    })
};

function usageQuery(filters: UsageFilters) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== "") query.set(key, String(value));
  return query.toString();
}
