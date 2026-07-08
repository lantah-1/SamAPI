import type {
  ApiKeyCreated,
  ApiKeyRecord,
  AppBootstrap,
  AppSettings,
  AuthSession,
  HeaderTemplate,
  ProviderApiKeyGroupInput,
  ProviderApiKeyGroupView,
  ProviderModelDiscoverResult,
  ProviderModelSyncResult,
  RequestLog,
  RequestLogPage,
  RouteRecord,
  Site,
  TemporaryAccountGroup,
  TemporaryAccountCheckOptions,
  TemporaryAccountCheckResult,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
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
  discoverProviderModels: (siteId: string, apiKey: string, apiKeyName: string, kind?: string) =>
    request<ProviderModelDiscoverResult>("/api/provider-key-groups/discover-models", {
      method: "POST",
      body: JSON.stringify({ siteId, apiKey, apiKeyName, kind })
    }),
  syncProviderModels: () => request<ProviderModelSyncResult>("/api/provider-key-groups/sync-models", { method: "POST" }),
  listTemporaryAccountGroups: () => request<TemporaryAccountGroup[]>("/api/temporary-accounts"),
  importTemporaryAccounts: (input: TemporaryAccountImportInput) =>
    request<TemporaryAccountImportResult>("/api/temporary-accounts/import", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  checkTemporaryAccounts: (options?: TemporaryAccountCheckOptions) =>
    request<TemporaryAccountCheckResult>("/api/temporary-accounts/check", {
      method: "POST",
      body: JSON.stringify(options || {})
    }),
  checkTemporaryAccount: (id: string, options?: TemporaryAccountCheckOptions) =>
    request<TemporaryAccountCheckResult>(`/api/temporary-accounts/accounts/${id}/check`, {
      method: "POST",
      body: JSON.stringify(options || {})
    }),
  updateTemporaryAccount: (id: string, body: Partial<TemporaryAccountGroup["accounts"][number]>) =>
    request<TemporaryAccountGroup["accounts"][number]>(`/api/temporary-accounts/accounts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body)
    }),
  deleteTemporaryAccount: (id: string) => request<{ ok: true }>(`/api/temporary-accounts/accounts/${id}`, { method: "DELETE" }),
  deleteTemporaryAccounts: (ids: string[]) =>
    request<{ ok: true }>("/api/temporary-accounts/batch", {
      method: "DELETE",
      body: JSON.stringify({ ids })
    }),
  updateTemporaryAccountGroup: (id: string, input: Partial<TemporaryAccountGroup>) =>
    request<TemporaryAccountGroup>(`/api/temporary-accounts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  deleteTemporaryAccountGroup: (id: string) => request<{ ok: true }>(`/api/temporary-accounts/${id}`, { method: "DELETE" }),
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
