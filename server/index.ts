import http from "node:http";
import { URL } from "node:url";
import { createAuth } from "./auth.js";
import { createAccountCheck } from "./account-check.js";
import { createRouting } from "./routing.js";
import { createModelDiscovery } from "./model-discovery.js";
import { startProviderModelSyncScheduler } from "./model-sync-scheduler.js";
import { createApiHandler } from "./handlers/api.js";
import { createProxyHandler } from "./handlers/proxy.js";
import { ADMIN_PASSWORD_IS_DEFAULT, HOST, PORT, WEB_DIR } from "./config.js";
import { handleStatic, notFound, sendCorsPreflight } from "./http.js";
import { isSupportedProxyPath } from "./proxy-path.js";
import { JsonStore } from "./store.js";

const store = new JsonStore();
const {
  adminSessionCookie,
  clearAdminSessionCookie,
  createAdminSession,
  hasAdminSession,
  renewAdminSession,
  requireAdminSession,
  verifyAdminPassword
} = createAuth(store);
const { checkTemporaryAccounts, checkTemporaryAccountIds, checkSingleTemporaryAccount } = createAccountCheck(store);
const { markTemporaryAccountAttempt, markCandidateSuccess, resolveProxyExecution } = createRouting(store);
const { discoverProviderModels, syncAllProviderModels } = createModelDiscovery(store);
const { handleApi } = createApiHandler({
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
});
const { handleProxy, handleUnsupportedProxyPath } = createProxyHandler({
  store,
  markTemporaryAccountAttempt,
  markCandidateSuccess,
  resolveProxyExecution
});

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method === "OPTIONS") {
    sendCorsPreflight(request, response);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url);
    return;
  }
  if (isSupportedProxyPath(url.pathname)) {
    await handleProxy(request, response, url);
    return;
  }
  if (url.pathname.startsWith("/proxy/")) {
    await handleUnsupportedProxyPath(request, response, url);
    return;
  }
  if (handleStatic(request, response, url)) return;
  notFound(response);
});

server.listen(PORT, HOST, () => {
  console.log(`SamAPI API is running at http://${HOST}:${PORT}`);
  console.log(`Local access: http://127.0.0.1:${PORT}`);
  console.log(`Database: ${store.dbPath}`);
  console.log(`Web UI: ${WEB_DIR}`);
  console.log("Fetch proxy: per-route");
  startProviderModelSyncScheduler({ syncAllProviderModels });
  if (ADMIN_PASSWORD_IS_DEFAULT && !store.getAdminPasswordHash()) {
    console.warn("Admin password is using the local default: samapi-admin. Set SAMAPI_ADMIN_PASSWORD before exposing SamAPI publicly.");
  }
});
