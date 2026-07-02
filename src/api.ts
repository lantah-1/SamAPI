import type {
  ApiKeyCreated,
  ApiKeyRecord,
  AppSettings,
  AppSnapshot,
  HeaderTemplate,
  ProviderApiKeyGroupInput,
  ProviderApiKeyGroupView,
  Site,
  SwitchRoute
} from "../shared/types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {})
    }
  });
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
    throw new Error(payload.error || fallbackMessage);
  }
  if (text && !isJson && path.startsWith("/api/")) {
    throw new Error("API 返回了非 JSON 内容，请确认后端服务已启动且 Vite 代理生效");
  }
  return payload as T;
}

export const api = {
  snapshot: () => request<AppSnapshot>("/api/snapshot"),
  saveSite: (site: Partial<Site>) =>
    request<Site>(site.id ? `/api/sites/${site.id}` : "/api/sites", {
      method: site.id ? "PATCH" : "POST",
      body: JSON.stringify(site)
    }),
  deleteSite: (id: string) => request<{ ok: true }>(`/api/sites/${id}`, { method: "DELETE" }),
  createKey: (name: string) =>
    request<ApiKeyCreated>("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name })
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
  deleteProviderKeyGroup: (id: string) => request<{ ok: true }>(`/api/provider-key-groups/${id}`, { method: "DELETE" }),
  discoverProviderModels: (siteId: string, apiKey: string, apiKeyName: string) =>
    request<{ siteId: string; siteName: string; addressId: string; addressLabel: string; models: string[] }>("/api/provider-key-groups/discover-models", {
      method: "POST",
      body: JSON.stringify({ siteId, apiKey, apiKeyName })
    }),
  saveHeader: (template: Partial<HeaderTemplate>) =>
    request<HeaderTemplate>(template.id ? `/api/headers/${template.id}` : "/api/headers", {
      method: template.id ? "PATCH" : "POST",
      body: JSON.stringify(template)
    }),
  deleteHeader: (id: string) => request<{ ok: true }>(`/api/headers/${id}`, { method: "DELETE" }),
  saveRoute: (route: Partial<SwitchRoute>) =>
    request<SwitchRoute>(route.id ? `/api/routes/${route.id}` : "/api/routes", {
      method: route.id ? "PATCH" : "POST",
      body: JSON.stringify(route)
    }),
  deleteRoute: (id: string) => request<{ ok: true }>(`/api/routes/${id}`, { method: "DELETE" }),
  deleteLog: (id: string) => request<{ ok: true }>(`/api/logs/${id}`, { method: "DELETE" }),
  clearLogs: () => request<{ ok: true }>("/api/logs/clear", { method: "DELETE" }),
  updateSettings: (settings: Partial<AppSettings>) =>
    request<AppSettings>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(settings)
    })
};
