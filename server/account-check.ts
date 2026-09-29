import type { JsonStore } from "./store.js";
import { extractUpstreamError, isRecord, mapWithConcurrency } from "./util/text.js";
import { accountProviders } from "../shared/accounts.js";
import { accountProvider, redactAccountError } from "./accounts.js";
import { isNetworkError, upstreamNetworkErrorMessage } from "./proxy.js";
import {
  TEMPORARY_ACCOUNT_CHECK_CONCURRENCY,
  fetchTemporaryAccountCheckText
} from "./providers/constants.js";
import { agentIdentityAuthorization, ensureOpenAiAgentIdentityTask, isOpenAiAgentIdentityAccount, isOpenAiAgentIdentityTaskInvalid } from "./providers/openai-agent-identity.js";
import {
  codexUsageCheckResult,
  earliestCodexResetCredit,
  fetchCodexResetCredits,
  fetchCodexUsage,
  refreshCodexTemporaryAccountToken,
  resetCodexTemporaryAccount
} from "./providers/codex.js";
import {
  fetchGrokOAuthResponses,
  grokOAuthAccessTokenNeedsRefresh,
  isGrokOAuthTemporaryAccount,
  refreshGrokOAuthTemporaryAccountToken,
  xaiQuotaStagesFromHeaders
} from "./providers/grok.js";
import type {
  RouteProxyConfig,
  TemporaryAccount,
  TemporaryAccountCheckItemResult,
  TemporaryAccountCheckResult,
  TemporaryAccountProviderType
} from "../shared/types.js";

const quotaExhaustionCodes = new Set([
  "insufficient_quota", "quota_exceeded", "quota_exhausted", "usage_limit_reached", "usage_limit_exceeded",
  "insufficient_balance", "insufficient_credits", "credit_balance_too_low", "billing_hard_limit_reached"
]);
const quotaExhaustionMessages = [
  /\b(?:insufficient|exhausted|depleted)\s+(?:quota|credits?|(?:credit\s+)?balance)\b/,
  /\b(?:quota|credits?|(?:credit\s+)?balance)\s+(?:(?:is|are|has been|have been)\s+)?(?:exhausted|depleted|insufficient|used up)\b/,
  /\b(?:exceeded|exhausted|used up)\s+(?:(?:your|the|current|available|account)\s+){0,3}(?:quota|credits?)\b/,
  /\b(?:hit|reached|exceeded)\s+(?:(?:your|the|current)\s+){0,3}usage limit\b/,
  /\b(?:quota|usage limit)\s+(?:(?:is|has been)\s+)?(?:reached|exceeded)\b/,
  /\bcredit balance\s+(?:is\s+)?too low\b/,
  /\b(?:not enough|no remaining)\s+credits?\b/,
  /(?:额度|配额|余额|点数|积分)(?:已(?:经)?)?(?:耗尽|用尽|用完|不足)/
];

/** Request failures only retire an account when the upstream explicitly reports exhausted quota. */
export function shouldMarkTemporaryAccountUnavailable(statusCode: number, errorMessage = "", errorBody?: string) {
  if (statusCode < 400) return false;
  // HTTP 401/403 and transient 429s do not establish quota exhaustion. Keep structured
  // error codes available even when the display message only says to try again later.
  try {
    const payload: unknown = JSON.parse(errorBody ?? errorMessage);
    const error = isRecord(payload) ? (isRecord(payload.error) ? payload.error : payload) : undefined;
    if (error && [error.code, error.type].some((code) => typeof code === "string" && quotaExhaustionCodes.has(code.toLowerCase()))) return true;
  } catch {
    // Plain-text failures can still explicitly report an exhausted quota or balance.
  }
  const normalized = errorMessage.trim().toLowerCase();
  return quotaExhaustionCodes.has(normalized) || quotaExhaustionMessages.some((pattern) => pattern.test(normalized));
}

function isTemporaryAccountAuthFailure(errorMessage = "") {
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes("invalid_grant") ||
    normalized.includes("refresh_token 已失效") ||
    normalized.includes("授权已失效") ||
    normalized.includes("unauthorized") ||
    /刷新 (?:grok oauth|codex) token 失败/.test(normalized) &&
      (normalized.includes("401") || normalized.includes("403") || normalized.includes("400"))
  );
}

export function createAccountCheck(store: JsonStore) {
  function siteProxyForTemporaryAccountGroup(groupId: string): RouteProxyConfig {
    const db = store.getDb();
    const group = db.temporaryAccountGroups.find((item) => item.id === groupId);
    const site = group ? db.sites.find((item) => item.id === group.siteId) : undefined;
    const address = site?.enabled === false ? undefined : site?.addresses.find((item) => item.enabled);
    return address?.proxy || { mode: "direct" };
  }

  function grokConfiguredModels(account: TemporaryAccount) {
    const upstreamModels = Array.from(
      new Set(
        store.getDb().providerApiKeyGroups
          .filter((group) => store.isOfficialGrokSite(group.siteId))
          .flatMap((group) => group.apiKeys.filter((apiKey) => apiKey.enabled).flatMap((apiKey) => apiKey.models))
          .filter(Boolean)
      )
    ).sort();
    if (upstreamModels.length > 0) return upstreamModels;
    return Array.from(new Set(account.models.filter(Boolean))).sort();
  }

  async function checkCodexTemporaryAccount(account: TemporaryAccount, checkedAt: string, proxyConfig?: RouteProxyConfig) {
    let tokenPatch:
      | {
          secret: string;
          refreshToken?: string;
          idToken?: string;
          accountId?: string;
          email?: string;
          tokenExpiresAt?: string;
        }
      | undefined;
    let activeAccount = account;
    const agentIdentity = isOpenAiAgentIdentityAccount(account);
    if (agentIdentity) {
      activeAccount = await ensureOpenAiAgentIdentityTask({
        account,
        proxy: proxyConfig,
        getCurrent: () => store.temporaryAccountCheckTarget(account.id)?.account,
        persist: (agentTaskId) => { store.updateTemporaryAccountCheckResult(account.id, { agentTaskId }); }
      });
    }
    const fetchUsage = () => agentIdentity
      ? fetchCodexUsage(activeAccount, agentIdentityAuthorization(activeAccount), proxyConfig, true)
      : fetchCodexUsage(activeAccount, activeAccount.secret, proxyConfig);
    let attempt = await fetchUsage();
    if (agentIdentity && isOpenAiAgentIdentityTaskInvalid(attempt.response.status, attempt.text)) {
      activeAccount = await ensureOpenAiAgentIdentityTask({
        account: activeAccount,
        proxy: proxyConfig,
        expectedTaskId: activeAccount.agentTaskId,
        getCurrent: () => store.temporaryAccountCheckTarget(account.id)?.account,
        persist: (agentTaskId) => { store.updateTemporaryAccountCheckResult(account.id, { agentTaskId }); }
      });
      attempt = await fetchUsage();
    }
    if (!agentIdentity && [401, 403].includes(attempt.response.status) && account.refreshToken) {
      const refreshedTokenPatch = await refreshCodexTemporaryAccountToken(account, proxyConfig);
      if (refreshedTokenPatch) {
        tokenPatch = refreshedTokenPatch;
        const refreshedAccount = { ...account, ...tokenPatch };
        activeAccount = refreshedAccount;
        attempt = await fetchCodexUsage(refreshedAccount, tokenPatch.secret, proxyConfig);
      }
    }

    if (!attempt.response.ok) {
      const errorMessage = extractUpstreamError(attempt.text) || `HTTP ${attempt.response.status}`;
      return {
        patch: {
          ...tokenPatch,
          availability: "unavailable" as const,
          quotaStages: account.quotaStages,
          lastQuotaCheckedAt: checkedAt,
          lastCheckStatusCode: attempt.response.status,
          lastCheckError: errorMessage
        },
        result: {
          availability: "unavailable" as const,
          status: "failed" as const,
          statusCode: attempt.response.status,
          quotaStages: account.quotaStages,
          errorMessage,
          checkedAt
        }
      };
    }

    let payload: unknown = {};
    try {
      payload = attempt.text ? JSON.parse(attempt.text) : {};
    } catch {
      const errorMessage = "Codex usage 返回内容不是合法 JSON";
      return {
        patch: {
          ...tokenPatch,
          availability: "unavailable" as const,
          quotaStages: account.quotaStages,
          lastQuotaCheckedAt: checkedAt,
          lastCheckStatusCode: attempt.response.status,
          lastCheckError: errorMessage
        },
        result: {
          availability: "unavailable" as const,
          status: "failed" as const,
          statusCode: attempt.response.status,
          quotaStages: account.quotaStages,
          errorMessage,
          checkedAt
        }
      };
    }

    let resetCreditDetails;
    try {
      resetCreditDetails = agentIdentity
        ? await fetchCodexResetCredits(activeAccount, agentIdentityAuthorization(activeAccount), proxyConfig, true)
        : await fetchCodexResetCredits(activeAccount, activeAccount.secret, proxyConfig);
    } catch {
      // Usage data remains useful if the optional reset-credit detail endpoint is unavailable.
    }
    const parsed = codexUsageCheckResult(payload, resetCreditDetails);
    const errorMessage = parsed.availability === "available" ? undefined : "Codex 额度已耗尽或当前不允许请求";
    return {
      patch: {
        ...tokenPatch,
        availability: parsed.availability,
        quotaStages: parsed.stages,
        lastQuotaCheckedAt: checkedAt,
        lastCheckStatusCode: attempt.response.status,
        lastCheckError: errorMessage
      },
      result: {
        availability: parsed.availability,
        status: parsed.availability === "available" ? "success" as const : "failed" as const,
        statusCode: attempt.response.status,
        quotaStages: parsed.stages,
        errorMessage,
        checkedAt
      }
    };
  }

  async function checkOpenAiApiKeyTemporaryAccount(account: TemporaryAccount, checkedAt: string, proxyConfig?: RouteProxyConfig) {
    const provider = accountProvider(account.providerType || "gpt");
    const group = store.temporaryAccountCheckTarget(account.id)?.group;
    const site = store.getDb().sites.find((item) => item.id === group?.siteId);
    const address = site?.addresses.find((item) => item.enabled);
    let base = (address?.baseUrl || accountProviders[provider].baseUrl).replace(/\/$/, "");
    if (provider === "gemini") base = base.replace(/\/openai$/, "");
    const headers: Record<string, string> = provider === "claude" ? { "x-api-key": account.secret, "anthropic-version": "2023-06-01" }
      : provider === "gemini" ? { "x-goog-api-key": account.secret } : { Authorization: `Bearer ${account.secret}` };
    headers.Accept = "application/json";
    const models: string[] = [];
    const pages = new Set<string>();
    let cursor = "";
    let statusCode = 200;
    for (let page = 0; page < 100; page++) {
      const url = new URL(`${base}/models`);
      if (cursor) url.searchParams.set(provider === "gemini" ? "pageToken" : "after_id", cursor);
      const { response, text } = await fetchTemporaryAccountCheckText(url, { headers }, proxyConfig);
      statusCode = response.status;
      if (!response.ok) {
        const errorMessage = redactAccountError(extractUpstreamError(text) || `HTTP ${response.status}`, account)!;
        const availability = response.status >= 500 ? "unknown" as const : "unavailable" as const;
        return { patch: { availability, quotaStages: account.quotaStages, lastQuotaCheckedAt: checkedAt, lastCheckStatusCode: response.status, lastCheckError: errorMessage }, result: { availability, status: "failed" as const, statusCode: response.status, quotaStages: account.quotaStages, errorMessage, checkedAt } };
      }
      const body: unknown = JSON.parse(text);
      if (!isRecord(body) || (!Array.isArray(body.data) && !Array.isArray(body.models))) throw new Error("模型列表返回格式无效");
      for (const model of (Array.isArray(body.data) ? body.data : body.models) as unknown[]) {
        if (!isRecord(model)) continue;
        const id = typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name.replace(/^models\//, "") : "";
        if (id) models.push(id);
      }
      const next = provider === "gemini" ? body.nextPageToken : body.has_more ? body.last_id : undefined;
      if (body.has_more && !next) throw new Error("模型列表分页缺少游标");
      if (!next) break;
      if (typeof next !== "string" || pages.has(next) || page === 99) throw new Error("模型列表分页异常");
      cursor = next; pages.add(next);
    }
    return {
      patch: {
        availability: "available" as const,
        models: [...new Set(models)].sort(),
        quotaStages: account.quotaStages,
        lastQuotaCheckedAt: checkedAt,
        lastCheckStatusCode: statusCode,
        lastCheckError: undefined
      },
      result: {
        availability: "available" as const,
        status: "success" as const,
        statusCode,
        quotaStages: account.quotaStages,
        checkedAt
      }
    };
  }

  async function checkGrokOAuthTemporaryAccount(account: TemporaryAccount, checkedAt: string, proxyConfig?: RouteProxyConfig) {
    let tokenPatch:
      | {
          secret: string;
          refreshToken?: string;
          idToken?: string;
          email?: string;
          tokenExpiresAt?: string;
        }
      | undefined;
    const model = grokConfiguredModels(account)[0] || "";
    let activeAccount = account;
    if (grokOAuthAccessTokenNeedsRefresh(account) && account.refreshToken) {
      const refreshedTokenPatch = await refreshGrokOAuthTemporaryAccountToken(account, proxyConfig);
      if (refreshedTokenPatch) {
        tokenPatch = refreshedTokenPatch;
        activeAccount = { ...account, ...tokenPatch };
      }
    }
    let attempt = await fetchGrokOAuthResponses(activeAccount, model, activeAccount.secret, proxyConfig);
    if (attempt.response.status === 401 && account.refreshToken) {
      const refreshedTokenPatch = await refreshGrokOAuthTemporaryAccountToken(activeAccount, proxyConfig);
      if (refreshedTokenPatch) {
        tokenPatch = refreshedTokenPatch;
        const refreshedAccount = { ...activeAccount, ...tokenPatch };
        attempt = await fetchGrokOAuthResponses(refreshedAccount, model, tokenPatch.secret, proxyConfig);
      }
    }

    const quotaStages = xaiQuotaStagesFromHeaders(attempt.response.headers);
    if (!attempt.response.ok) {
      const errorMessage = extractUpstreamError(attempt.text) || `HTTP ${attempt.response.status}`;
      const availability = attempt.response.status === 429 ? "unavailable" as const : "unavailable" as const;
      return {
        patch: {
          ...tokenPatch,
          availability,
          quotaStages: quotaStages.length > 0 ? quotaStages : account.quotaStages,
          lastQuotaCheckedAt: checkedAt,
          lastCheckStatusCode: attempt.response.status,
          lastCheckError: errorMessage
        },
        result: {
          availability,
          status: "failed" as const,
          statusCode: attempt.response.status,
          quotaStages: quotaStages.length > 0 ? quotaStages : account.quotaStages,
          errorMessage,
          checkedAt
        }
      };
    }

    return {
      patch: {
        ...tokenPatch,
        availability: "available" as const,
        quotaStages,
        lastQuotaCheckedAt: checkedAt,
        lastCheckStatusCode: attempt.response.status,
        lastCheckError: undefined
      },
      result: {
        availability: "available" as const,
        status: "success" as const,
        statusCode: attempt.response.status,
        quotaStages,
        checkedAt
      }
    };
  }

  async function checkGrokTemporaryAccount(account: TemporaryAccount, checkedAt: string, proxyConfig?: RouteProxyConfig) {
    if (!isGrokOAuthTemporaryAccount(account)) throw new Error("仅支持 CPA 或 grok2api 的 Grok OAuth 账号");
    return checkGrokOAuthTemporaryAccount(account, checkedAt, proxyConfig);
  }

  async function checkTemporaryAccount(groupId: string, account: TemporaryAccount, proxyConfig?: RouteProxyConfig): Promise<TemporaryAccountCheckItemResult> {
    // Editing or deleting an account during a check must not apply an old credential's result.
    account = { ...account };
    const checkedAt = new Date().toISOString();
    const accountProxy = proxyConfig || siteProxyForTemporaryAccountGroup(groupId);
    const changedWhileChecking = (): TemporaryAccountCheckItemResult | undefined => {
      const current = store.temporaryAccountCheckTarget(account.id)?.account;
      if (current && current.secret === account.secret && current.refreshToken === account.refreshToken && current.agentPrivateKey === account.agentPrivateKey) return undefined;
      return { groupId, accountId: account.id, label: current?.label || account.label, availability: current?.availability || "unknown", status: "cancelled", quotaStages: current?.quotaStages || [], errorMessage: "账号在检查期间发生变更，已忽略旧检查结果", checkedAt: current?.lastQuotaCheckedAt || checkedAt };
    };
    try {
      const providerType = account.providerType || "gpt";
      const accountIsCodex = providerType === "gpt" && (account.accountType === "codex" || Boolean(account.accountId));
      const check = providerType === "grok"
        ? await checkGrokTemporaryAccount(account, checkedAt, accountProxy)
        : accountIsCodex
          ? await checkCodexTemporaryAccount(account, checkedAt, accountProxy)
          : await checkOpenAiApiKeyTemporaryAccount(account, checkedAt, accountProxy);
      const changed = changedWhileChecking();
      if (changed) return changed;
      const safeError = redactAccountError(redactAccountError(check.result.errorMessage, account), { ...account, ...check.patch });
      const updated = store.updateTemporaryAccountCheckResult(account.id, { ...check.patch, lastCheckError: safeError });
      return {
        groupId,
        accountId: account.id,
        label: account.label,
        availability: check.result.availability,
        status: check.result.status,
        statusCode: check.result.statusCode,
        quotaStages: updated?.quotaStages || check.result.quotaStages,
        errorMessage: safeError,
        checkedAt
      };
    } catch (error) {
      const changed = changedWhileChecking();
      if (changed) return changed;
      const rawMessage = error instanceof Error ? error.message : String(error);
      const errorMessage = redactAccountError(upstreamNetworkErrorMessage(error, "账号检查请求上游失败"), account)!;
      const authFailure = isTemporaryAccountAuthFailure(rawMessage);
      // Network/proxy blips stay "unknown" for every provider so a flaky local proxy
      // (especially under concurrent batch checks) doesn't permanently retire the account.
      // Auth failures (invalid_grant / 401 / 403) are real unavailability and should be marked as such.
      const availability = authFailure ? "unavailable" as const : isNetworkError(error) || /超时|代理|fetch failed|network/i.test(rawMessage)
        ? "unknown" as const
        : "unavailable" as const;
      const statusCode = authFailure ? 401 : 599;
      const updated = store.updateTemporaryAccountCheckResult(account.id, {
        availability,
        quotaStages: account.quotaStages,
        lastQuotaCheckedAt: checkedAt,
        lastCheckStatusCode: statusCode,
        lastCheckError: errorMessage
      });
      return {
        groupId,
        accountId: account.id,
        label: account.label,
        availability,
        status: "failed",
        statusCode,
        quotaStages: updated?.quotaStages || account.quotaStages,
        errorMessage,
        checkedAt
      };
    }
  }

  function temporaryAccountCheckResult(results: TemporaryAccountCheckItemResult[]): TemporaryAccountCheckResult {
    return {
      total: results.length,
      available: results.filter((item) => item.availability === "available").length,
      unavailable: results.filter((item) => item.availability === "unavailable").length,
      unknown: results.filter((item) => item.availability === "unknown").length,
      results
    };
  }

  async function checkTemporaryAccounts(groupId?: string, proxyConfig?: RouteProxyConfig, providerType: TemporaryAccountProviderType = "gpt"): Promise<TemporaryAccountCheckResult> {
    const targets = store.temporaryAccountCheckTargets(groupId, providerType);
    if (groupId && targets.length === 0) throw new Error("临时账号组不存在");
    const results = await mapWithConcurrency(targets, TEMPORARY_ACCOUNT_CHECK_CONCURRENCY, ({ group, account }) =>
      checkTemporaryAccount(group.id, account, proxyConfig)
    );
    return temporaryAccountCheckResult(results);
  }

  async function checkTemporaryAccountIds(accountIds: string[], proxyConfig?: RouteProxyConfig, providerType?: TemporaryAccountProviderType): Promise<TemporaryAccountCheckResult> {
    const targets = accountIds.map((accountId) => store.temporaryAccountCheckTarget(accountId, providerType));
    if (targets.some((target) => !target)) throw new Error("临时账号不存在或不支持刷新");
    const validTargets = targets.filter((target): target is NonNullable<typeof target> => Boolean(target));
    const results = await mapWithConcurrency(validTargets, TEMPORARY_ACCOUNT_CHECK_CONCURRENCY, ({ group, account }) =>
      checkTemporaryAccount(group.id, account, proxyConfig)
    );
    return temporaryAccountCheckResult(results);
  }

  async function checkSingleTemporaryAccount(accountId: string, proxyConfig?: RouteProxyConfig): Promise<TemporaryAccountCheckResult> {
    return checkTemporaryAccountIds([accountId], proxyConfig);
  }

  async function resetSingleTemporaryAccount(accountId: string, proxyConfig?: RouteProxyConfig): Promise<TemporaryAccountCheckResult> {
    const target = store.temporaryAccountCheckTarget(accountId, "gpt");
    if (!target) throw new Error("临时账号不存在或不是 GPT 账号");
    const { group, account } = target;
    const isCodex = account.accountType === "codex" || Boolean(account.accountId);
    if (!isCodex) throw new Error("只有 ChatGPT/Codex OAuth 账号支持重置额度");

    let activeAccount = account;
    const agentIdentity = isOpenAiAgentIdentityAccount(account);
    if (agentIdentity) {
      activeAccount = await ensureOpenAiAgentIdentityTask({
        account,
        proxy: proxyConfig || siteProxyForTemporaryAccountGroup(group.id),
        getCurrent: () => store.temporaryAccountCheckTarget(account.id)?.account,
        persist: (agentTaskId) => { store.updateTemporaryAccountCheckResult(account.id, { agentTaskId }); }
      });
    }
    const accountProxy = proxyConfig || siteProxyForTemporaryAccountGroup(group.id);
    const resetWithEarliestCredit = async (candidate: TemporaryAccount, accessToken: string, authorizationIsComplete = false) => {
      const details = await fetchCodexResetCredits(candidate, accessToken, accountProxy, authorizationIsComplete, true);
      const credit = earliestCodexResetCredit(details);
      if (!credit) throw new Error("未获取到未过期的 Codex 重置卡详情，未执行额度重置");
      await resetCodexTemporaryAccount(candidate, accessToken, accountProxy, authorizationIsComplete, credit.id);
    };
    if (agentIdentity) {
      await resetWithEarliestCredit(activeAccount, agentIdentityAuthorization(activeAccount), true);
    } else {
      try {
        await resetWithEarliestCredit(activeAccount, activeAccount.secret);
      } catch (error) {
        if (![401, 403].some((status) => String(error).includes(`HTTP ${status}`)) || !account.refreshToken) throw error;
        const refreshed = await refreshCodexTemporaryAccountToken(account, accountProxy);
        if (!refreshed) throw error;
        activeAccount = { ...activeAccount, ...refreshed };
        store.updateTemporaryAccountCheckResult(account.id, refreshed);
        await resetWithEarliestCredit(activeAccount, activeAccount.secret);
      }
    }
    return checkTemporaryAccount(group.id, activeAccount, accountProxy).then((item) => ({
      total: 1,
      available: item.availability === "available" ? 1 : 0,
      unavailable: item.availability === "unavailable" ? 1 : 0,
      unknown: item.availability === "unknown" ? 1 : 0,
      results: [item]
    }));
  }

  return {
    checkTemporaryAccounts,
    checkTemporaryAccountIds,
    checkSingleTemporaryAccount,
    resetSingleTemporaryAccount
  };
}
