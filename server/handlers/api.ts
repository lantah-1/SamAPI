import http from "node:http";
import { URL } from "node:url";
import type { JsonStore } from "../store.js";
import { isRecord } from "../util/text.js";
import { notFound, readJson, routeParam, sendJson } from "../http.js";
import { ModelDiscoveryOptionsError } from "../model-discovery.js";
import type {
  ProviderModelSyncResult,
  RouteProxyConfig,
  TemporaryAccountCheckResult,
  TemporaryAccountProviderType
} from "../../shared/types.js";

function temporaryAccountCheckProxyFromBody(body: unknown): RouteProxyConfig {
  if (!isRecord(body)) return { mode: "system" };
  const proxy = isRecord(body.proxy) ? body.proxy : isRecord(body.checkProxy) ? body.checkProxy : undefined;
  if (!proxy) return { mode: "system" };
  const mode = proxy.mode;
  if (mode === "direct" || mode === "system") return { mode };
  if (mode === "custom") {
    const url = typeof proxy.url === "string" ? proxy.url.trim() : "";
    if (!url) throw new Error("自定义代理地址不能为空");
    return { mode, url };
  }
  return { mode: "system" };
}

function temporaryAccountProviderTypeFromBody(body: unknown): TemporaryAccountProviderType {
  if (!isRecord(body)) return "gpt";
  return body.providerType === "grok" ? "grok" : "gpt";
}


interface ApiHandlerDeps {
  store: JsonStore;
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
  discoverProviderModels: (siteId: string, apiKey: string, apiKeyName: string, request: http.IncomingMessage, kind?: string) => Promise<unknown>;
  syncAllProviderModels: (request: http.IncomingMessage) => Promise<ProviderModelSyncResult>;
}

export function createApiHandler(deps: ApiHandlerDeps) {
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
    discoverProviderModels,
    syncAllProviderModels
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

      if (parts[1] === "auth" && method === "POST" && parts[2] === "password") {
        const body = await readJson(request);
        const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
        const nextPassword = typeof body.nextPassword === "string" ? body.nextPassword : "";
        if (!verifyAdminPassword(currentPassword)) return sendJson(response, 401, { error: "当前管理密码不正确" });
        store.updateAdminPasswordHash(nextPassword);
        return sendJson(response, 200, { authenticated: false }, { "Set-Cookie": clearAdminSessionCookie() });
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
        if (method === "POST" && parts[2] === "sync-models") return sendJson(response, 200, await syncAllProviderModels(request));
        if (method === "GET") return sendJson(response, 200, store.listProviderApiKeyGroups());
        if (method === "POST") return sendJson(response, 201, store.upsertProviderApiKeyGroup(await readJson(request)));
        if (method === "DELETE") {
          store.deleteProviderApiKeyGroup(routeParam(parts, 2));
          return sendJson(response, 200, { ok: true });
        }
      }

      if (parts[1] === "temporary-accounts") {
        if (method === "GET") return sendJson(response, 200, store.getDb().temporaryAccountGroups);
        if (method === "POST" && parts[2] === "import") {
          const body = await readJson(request);
          const imported = store.importTemporaryAccounts(body);
          const checkProxy = temporaryAccountCheckProxyFromBody(body);
          const checkResult = ["gpt", "grok"].includes(imported.group.providerType || "")
            ? await checkTemporaryAccountIds(imported.accountIds, checkProxy, imported.group.providerType)
            : undefined;
          const updatedGroup = store.getDb().temporaryAccountGroups.find((group) => group.id === imported.group.id) || imported.group;
          return sendJson(response, 201, { ...imported, group: updatedGroup, checkResult });
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
          if (method === "PATCH") return sendJson(response, 200, store.updateTemporaryAccount(accountId, await readJson(request)));
          if (method === "DELETE") {
            store.deleteTemporaryAccount(accountId);
            return sendJson(response, 200, { ok: true });
          }
        }
        if (method === "PATCH") return sendJson(response, 200, store.updateTemporaryAccountGroup(routeParam(parts, 2), await readJson(request)));
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
