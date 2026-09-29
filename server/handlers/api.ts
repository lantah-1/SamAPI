import http from "node:http";
import { URL } from "node:url";
import type { JsonStore } from "../store.js";
import { isRecord } from "../util/text.js";
import { notFound, readJson, routeParam, sendJson } from "../http.js";
import { ModelDiscoveryOptionsError } from "../model-discovery.js";
import type { ModelPriceInput, UsageFilters } from "../../shared/usage.js";
import { createModelPriceSync, type ModelPriceSync } from "../model-price-sync.js";
import type { ManagedAccountInput } from "../../shared/accounts.js";
import { accountProvider, temporaryAccountGroupView, temporaryAccountView } from "../accounts.js";
import type {
  ProviderModelSyncOptions,
  ProviderModelSyncResult,
  RouteProxyConfig,
  TemporaryAccountCheckResult,
  TemporaryAccountProviderType
} from "../../shared/types.js";

function temporaryAccountCheckProxyFromBody(body: unknown): RouteProxyConfig | undefined {
  if (!isRecord(body)) return undefined;
  const proxy = isRecord(body.proxy) ? body.proxy : isRecord(body.checkProxy) ? body.checkProxy : undefined;
  if (!proxy) return undefined;
  const mode = proxy.mode;
  if (mode === "direct" || mode === "system") return { mode };
  if (mode === "custom") {
    const url = typeof proxy.url === "string" ? proxy.url.trim() : "";
    if (!url) throw new Error("自定义代理地址不能为空");
    return { mode, url };
  }
  return undefined;
}

function temporaryAccountProviderTypeFromBody(body: unknown): TemporaryAccountProviderType {
  if (!isRecord(body)) return "gpt";
  return body.providerType === "grok" ? "grok" : "gpt";
}


interface ApiHandlerDeps {
  store: JsonStore;
  modelPriceSync?: ModelPriceSync;
  hasAdminSession: (request: http.IncomingMessage) => boolean;
  renewAdminSession: (response: http.ServerResponse) => { expiresAt: string };
  verifyAdminPassword: (password: string) => boolean;
  createAdminSession: () => { token: string; expiresAt: string };
  adminSessionCookie: (token: string) => string;
  clearAdminSessionCookie: () => string;
  requireAdminSession: (request: http.IncomingMessage, response: http.ServerResponse, url: URL) => boolean;
  checkTemporaryAccounts: (groupId?: string, proxyConfig?: RouteProxyConfig, providerType?: TemporaryAccountProviderType) => Promise<TemporaryAccountCheckResult>;
  checkTemporaryAccountIds: (accountIds: string[], proxyConfig?: RouteProxyConfig, providerType?: TemporaryAccountProviderType) => Promise<TemporaryAccountCheckResult>;
  checkSingleTemporaryAccount: (accountId: string, proxyConfig?: RouteProxyConfig) => Promise<TemporaryAccountCheckResult>;
  resetSingleTemporaryAccount: (accountId: string, proxyConfig?: RouteProxyConfig) => Promise<TemporaryAccountCheckResult>;
  discoverProviderModels: (siteId: string, apiKey: string, apiKeyName: string, request: http.IncomingMessage, kind?: string) => Promise<unknown>;
  syncAllProviderModels: (request: http.IncomingMessage, options?: ProviderModelSyncOptions) => Promise<ProviderModelSyncResult>;
  startCodexOAuth: () => Promise<{ state: string; authorizationUrl: string; redirectUri: string }>;
  codexOAuthStatus: (state: string) => { state: string; status: "pending" | "success" | "error"; error?: string; accountId?: string } | undefined;
}

export function createApiHandler(deps: ApiHandlerDeps) {
  const modelPriceSync = deps.modelPriceSync || createModelPriceSync(deps.store);
  const {
    store,
    hasAdminSession,
    renewAdminSession,
    verifyAdminPassword,
    createAdminSession,
    adminSessionCookie,
    clearAdminSessionCookie,
    requireAdminSession,
    checkTemporaryAccounts,
    checkTemporaryAccountIds,
    checkSingleTemporaryAccount,
    resetSingleTemporaryAccount,
    discoverProviderModels,
    syncAllProviderModels,
    startCodexOAuth,
    codexOAuthStatus
  } = deps;

  async function handleApi(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
    const parts = url.pathname.split("/").filter(Boolean);
    const method = request.method || "GET";

    if (method === "OPTIONS") {
      sendJson(response, 204, {});
      return;
    }

    try {
      if (method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { ok: true, dataDir: store.dataDir, dbPath: store.dbPath, temporaryAccountsPath: store.temporaryAccountsPath });
        return;
      }

      if (parts[1] === "auth") {
        if (method === "GET" && parts[2] === "session") {
          if (!hasAdminSession(request)) {
            sendJson(response, 200, { authenticated: false });
            return;
          }
          const session = renewAdminSession(response);
          sendJson(response, 200, { authenticated: true, expiresAt: session.expiresAt });
          return;
        }
        if (method === "POST" && parts[2] === "login") {
          const body = await readJson(request);
          const password = typeof body.password === "string" ? body.password : "";
          if (!verifyAdminPassword(password)) {
            sendJson(response, 401, { error: "管理密码不正确" });
            return;
          }
          const session = createAdminSession();
          sendJson(
            response,
            200,
            { authenticated: true, expiresAt: session.expiresAt },
            { "Set-Cookie": adminSessionCookie(session.token) }
          );
          return;
        }
        if (method === "POST" && parts[2] === "logout") {
          sendJson(response, 200, { authenticated: false }, { "Set-Cookie": clearAdminSessionCookie() });
          return;
        }
      }

      if (!requireAdminSession(request, response, url)) return;

      if (method === "GET" && url.pathname === "/api/bootstrap") {
        sendJson(response, 200, {
          dbPath: store.sqlitePath,
          dataDir: store.dataDir,
          endpoints: ["messages", "chat/completions", "responses"],
          security: {
            adminPasswordCustomized: Boolean(store.getDb().adminPasswordHash)
          }
        });
        return;
      }

      if (parts[1] === "settings") {
        if (method === "GET") return sendJson(response, 200, store.getDb().settings);
        if (method === "PATCH") return sendJson(response, 200, store.updateSettings(await readJson(request)));
      }

      if (parts[1] === "backup") {
        if (method === "GET") return sendJson(response, 200, store.exportBackup(), { "Cache-Control": "no-store" });
        if (method === "POST") return sendJson(response, 200, store.importBackup(await readJson(request)));
      }

      if (parts[1] === "auth" && method === "POST" && parts[2] === "password") {
        const body = await readJson(request);
        const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
        const nextPassword = typeof body.nextPassword === "string" ? body.nextPassword : "";
        if (!verifyAdminPassword(currentPassword)) return sendJson(response, 400, { error: "当前管理密码不正确" });
        store.updateAdminPasswordHash(nextPassword);
        return sendJson(response, 200, { authenticated: false }, { "Set-Cookie": clearAdminSessionCookie() });
      }

      if (parts[1] === "usage") {
        const filters: UsageFilters = {
          apiKeyId: url.searchParams.get("apiKeyId") || undefined,
          from: url.searchParams.get("from") || undefined,
          to: url.searchParams.get("to") || undefined,
          timezoneOffsetMinutes: Number(url.searchParams.get("timezoneOffsetMinutes") || 0)
        };
        if (parts[2] === "prices") {
          if (parts[3] === "sync" && !parts[4]) {
            if (method === "GET") return sendJson(response, 200, modelPriceSync.status(), { "Cache-Control": "no-store" });
            if (method === "POST") return sendJson(response, 200, await modelPriceSync.sync(), { "Cache-Control": "no-store" });
            return notFound(response);
          }
          if (method === "GET" && !parts[3]) return sendJson(response, 200, store.listModelPrices());
          if (method === "POST" && !parts[3]) return sendJson(response, 200, store.saveModelPrice(await readJson(request) as unknown as ModelPriceInput));
          if (method === "DELETE" && parts[3]) { store.deleteModelPrice(routeParam(parts, 3)); return sendJson(response, 200, { ok: true }); }
        }
        if (method === "POST" && parts[2] === "price-unpriced") return sendJson(response, 200, { updated: store.priceUnpricedUsage() });
        if (method === "POST" && parts[2] === "estimate-missing" && !parts[3]) return sendJson(response, 200, store.estimateMissingUsage(filters));
        if (method === "GET" && !parts[2]) return sendJson(response, 200, store.usageReport(filters), { "Cache-Control": "no-store" });
        return notFound(response);
      }

      if (parts[1] === "logs") {
        if (method === "GET" && parts[2]) {
          const log = store.getRequestLog(routeParam(parts, 2));
          if (!log) return sendJson(response, 404, { error: "日志不存在" });
          return sendJson(response, 200, log);
        }
        if (method === "GET") {
          const requestedLimit = Number(url.searchParams.get("limit") || "");
          const requestedOffset = Number(url.searchParams.get("offset") || "");
          const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(100, Math.floor(requestedLimit)) : 5;
          const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? Math.floor(requestedOffset) : 0;
          const since = url.searchParams.get("since") || "";
          const items = since ? store.listNewRequestLogs(since, limit) : store.listRequestLogs(limit, offset);
          return sendJson(response, 200, {
            items,
            total: store.requestLogCount(),
            limit,
            offset: since ? 0 : offset
          });
        }
        if (method === "DELETE" && parts[2] === "clear") {
          store.clearRequestLogs();
          return sendJson(response, 200, { ok: true });
        }
        if (method === "DELETE") {
          store.deleteRequestLog(routeParam(parts, 2));
          return sendJson(response, 200, { ok: true });
        }
      }

      if (parts[1] === "sites") {
        if (method === "GET") return sendJson(response, 200, store.getDb().sites);
        if (method === "POST") return sendJson(response, 201, store.upsertSite(await readJson(request)));
        if (method === "PATCH") return sendJson(response, 200, store.upsertSite({ ...(await readJson(request)), id: routeParam(parts, 2) }));
        if (method === "DELETE") {
          store.deleteSite(routeParam(parts, 2));
          return sendJson(response, 200, { ok: true });
        }
      }

      if (parts[1] === "keys") {
        if (method === "GET") return sendJson(response, 200, store.getDb().apiKeys);
        if (method === "POST") {
          const body = await readJson(request) as { name?: unknown; models?: unknown };
          return sendJson(response, 201, store.createApiKey(String(body.name || ""), Array.isArray(body.models) ? body.models.map(String) : []));
        }
        if (method === "PATCH") return sendJson(response, 200, store.updateApiKey(routeParam(parts, 2), await readJson(request)));
        if (method === "DELETE") {
          store.deleteApiKey(routeParam(parts, 2));
          return sendJson(response, 200, { ok: true });
        }
      }

      if (parts[1] === "provider-key-groups") {
        if (method === "POST" && parts[2] === "discover-models") {
          const body = await readJson(request);
          return sendJson(
            response,
            200,
            await discoverProviderModels(String(body.siteId || ""), String(body.apiKey || ""), String(body.apiKeyName || ""), request, String(body.kind || "api-key"))
          );
        }
        if (method === "POST" && parts[2] === "sync-models") {
          const body = await readJson(request).catch(() => ({}));
          const mode =
            body && typeof body === "object" && "mode" in body
              ? body.mode === "auto" || body.mode === "manual" || body.mode === "all"
                ? body.mode
                : "all"
              : "all";
          const groupIds =
            body && typeof body === "object" && Array.isArray((body as { groupIds?: unknown }).groupIds)
              ? (body as { groupIds: unknown[] }).groupIds.map(String)
              : undefined;
          return sendJson(response, 200, await syncAllProviderModels(request, { mode, groupIds }));
        }
        if (method === "PATCH" && parts[3] === "model-manage-mode") {
          const body = await readJson(request);
          const modelManageMode = body.modelManageMode === "auto" ? "auto" : "manual";
          return sendJson(response, 200, store.updateProviderApiKeyGroupModelManageMode(routeParam(parts, 2), modelManageMode));
        }
        if (method === "GET") return sendJson(response, 200, store.listProviderApiKeyGroups());
        if (method === "POST") return sendJson(response, 201, store.upsertProviderApiKeyGroup(await readJson(request)));
        if (method === "DELETE") {
          store.deleteProviderApiKeyGroup(routeParam(parts, 2));
          return sendJson(response, 200, { ok: true });
        }
      }

      if (parts[1] === "accounts") {
        if (method === "GET" && !parts[2]) return sendJson(response, 200, store.managedAccounts(), { "Cache-Control": "no-store" });
        if (method === "POST" && !parts[2]) return sendJson(response, 201, store.createManagedAccount(await readJson(request) as unknown as ManagedAccountInput));
        if (parts[2] === "oauth") {
          if (method === "POST" && parts[3] === "start") return sendJson(response, 201, await startCodexOAuth());
          if (method === "GET" && parts[3] === "status") {
            const state = url.searchParams.get("state") || "";
            const status = state ? codexOAuthStatus(state) : undefined;
            return status ? sendJson(response, 200, status) : sendJson(response, 404, { error: "登录会话不存在或已过期" });
          }
        }
        if (method === "POST" && parts[2] === "import") {
          const body = await readJson(request);
          const provider = accountProvider(body.providerType ?? "gpt");
          if (provider !== "gpt" && provider !== "grok") throw new Error("该供应商请通过 API Key 添加账号");
          const result = store.importTemporaryAccounts({ ...body, providerType: provider });
          return sendJson(response, 201, { ...result, group: temporaryAccountGroupView(result.group) });
        }
        if (method === "POST" && parts[2] === "check") {
          const body = await readJson(request);
          return sendJson(response, 200, await checkTemporaryAccounts(undefined, undefined, accountProvider(body.provider)));
        }
        if (parts[2] === "providers") {
          const provider = accountProvider(parts[3]);
          if (method === "PATCH" && !parts[4]) return sendJson(response, 200, store.setManagedAccountPolicy(provider, await readJson(request)));
          if (method === "POST" && parts[4] === "route") return sendJson(response, 201, store.createManagedAccountRoute(provider, await readJson(request)));
        }
        if (method === "DELETE" && parts[2] === "batch") {
          const body = await readJson(request);
          const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String) : [];
          if (ids.some((id) => !store.temporaryAccountCheckTarget(id))) throw new Error("账号不存在");
          store.deleteTemporaryAccounts(ids);
          return sendJson(response, 200, { ok: true });
        }
        if (parts[2] && !["providers", "oauth"].includes(parts[2])) {
          const id = routeParam(parts, 2);
          const target = store.temporaryAccountCheckTarget(id);
          if (!target) return sendJson(response, 404, { error: "账号不存在" });
          if (method === "PATCH" && !parts[3]) return sendJson(response, 200, store.updateManagedAccount(id, await readJson(request)));
          if (method === "DELETE" && !parts[3]) { store.deleteTemporaryAccount(id); return sendJson(response, 200, { ok: true }); }
          if (method === "POST" && parts[3] === "prefer") return sendJson(response, 200, store.setManagedAccountPolicy(target.group.providerType || "gpt", { preferredAccountId: id }));
          if (method === "POST" && parts[3] === "check") return sendJson(response, 200, await checkSingleTemporaryAccount(id));
          if (method === "POST" && parts[3] === "reset") return sendJson(response, 200, await resetSingleTemporaryAccount(id));
        }
        return notFound(response);
      }

      if (parts[1] === "temporary-accounts") {
        if (method === "POST" && parts[2] === "oauth" && parts[3] === "start") {
          return sendJson(response, 201, await startCodexOAuth());
        }
        if (method === "GET" && parts[2] === "oauth" && parts[3] === "status") {
          const state = url.searchParams.get("state") || "";
          if (!state) return sendJson(response, 400, { error: "缺少 OAuth state" });
          const status = codexOAuthStatus(state);
          return status ? sendJson(response, 200, status) : sendJson(response, 404, { error: "OAuth session 不存在或已过期" });
        }
        if (method === "GET") return sendJson(response, 200, store.getDb().temporaryAccountGroups.map(temporaryAccountGroupView));
        if (method === "POST" && parts[2] === "import") {
          const body = await readJson(request);
          const imported = store.importTemporaryAccounts(body);
          // Availability checks run client-side after the list previews imported accounts.
          const group = store.getDb().temporaryAccountGroups.find((item) => item.id === imported.group.id) || imported.group;
          return sendJson(response, 201, { ...imported, group: temporaryAccountGroupView(group) });
        }
        if (method === "POST" && parts[2] === "check") {
          const body = await readJson(request);
          return sendJson(response, 200, await checkTemporaryAccounts(undefined, temporaryAccountCheckProxyFromBody(body), temporaryAccountProviderTypeFromBody(body)));
        }
        if (method === "DELETE" && parts[2] === "batch") {
          const body = await readJson(request);
          store.deleteTemporaryAccounts(Array.isArray(body.ids) ? body.ids.map(String) : []);
          return sendJson(response, 200, { ok: true });
        }
        if (parts[2] === "accounts") {
          const accountId = routeParam(parts, 3);
          if (method === "POST" && parts[4] === "check") {
            const body = await readJson(request);
            return sendJson(response, 200, await checkSingleTemporaryAccount(accountId, temporaryAccountCheckProxyFromBody(body)));
          }
          if (method === "POST" && parts[4] === "reset") {
            const body = await readJson(request);
            return sendJson(response, 200, await resetSingleTemporaryAccount(accountId, temporaryAccountCheckProxyFromBody(body)));
          }
          if (method === "PATCH") return sendJson(response, 200, temporaryAccountView(store.updateTemporaryAccount(accountId, await readJson(request))));
          if (method === "DELETE") {
            store.deleteTemporaryAccount(accountId);
            return sendJson(response, 200, { ok: true });
          }
        }
        if (method === "PATCH") return sendJson(response, 200, temporaryAccountGroupView(store.updateTemporaryAccountGroup(routeParam(parts, 2), await readJson(request))));
        if (method === "DELETE") {
          store.deleteTemporaryAccountGroup(routeParam(parts, 2));
          return sendJson(response, 200, { ok: true });
        }
      }

      if (parts[1] === "headers") {
        if (method === "GET") return sendJson(response, 200, store.getDb().headerTemplates);
        if (method === "POST") return sendJson(response, 201, store.upsertHeaderTemplate(await readJson(request)));
        if (method === "PATCH") return sendJson(response, 200, store.upsertHeaderTemplate({ ...(await readJson(request)), id: routeParam(parts, 2) }));
        if (method === "DELETE") {
          store.deleteHeaderTemplate(routeParam(parts, 2));
          return sendJson(response, 200, { ok: true });
        }
      }

      if (parts[1] === "route-display-groups") {
        if (method === "GET") return sendJson(response, 200, store.getDb().routeDisplayGroups);
        if (method === "POST") return sendJson(response, 201, store.upsertRouteDisplayGroup(await readJson(request)));
        if (method === "PATCH") return sendJson(response, 200, store.upsertRouteDisplayGroup({ ...(await readJson(request)), id: routeParam(parts, 2) }));
        if (method === "DELETE") {
          store.deleteRouteDisplayGroup(routeParam(parts, 2));
          return sendJson(response, 200, { ok: true });
        }
      }

      if (parts[1] === "routes") {
        if (method === "GET") return sendJson(response, 200, store.getDb().routes);
        if (method === "POST") return sendJson(response, 201, store.upsertRoute(await readJson(request)));
        if (method === "PATCH") return sendJson(response, 200, store.upsertRoute({ ...(await readJson(request)), id: routeParam(parts, 2) }));
        if (method === "DELETE") {
          store.deleteRoute(routeParam(parts, 2));
          return sendJson(response, 200, { ok: true });
        }
      }

      notFound(response);
    } catch (error) {
      if (error instanceof ModelDiscoveryOptionsError) {
        sendJson(response, 400, { error: error.message, modelGroups: error.modelGroups });
        return;
      }
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Bad request" });
    }
  }


  return { handleApi };
}
