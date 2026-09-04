import type { JsonStore } from "./store.js";
import { extractUpstreamError, mapWithConcurrency } from "./util/text.js";
import { isNetworkError, upstreamNetworkErrorMessage } from "./proxy.js";
import {
  OPENAI_MODELS_URL,
  TEMPORARY_ACCOUNT_CHECK_CONCURRENCY,
  fetchTemporaryAccountCheckText
} from "./providers/constants.js";
import { agentIdentityAuthorization, ensureOpenAiAgentIdentityTask, isOpenAiAgentIdentityAccount, isOpenAiAgentIdentityTaskInvalid } from "./providers/openai-agent-identity.js";
import {
  codexUsageCheckResult,
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

export function shouldMarkTemporaryAccountUnavailable(statusCode: number, errorMessage = "") {
  if ([401, 403, 429].includes(statusCode)) return true;
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes("html") ||
    normalized.includes("chatgpt") ||
    normalized.includes("unauthorized") ||
    normalized.includes("insufficient_quota") ||
    normalized.includes("usage_limit") ||
    normalized.includes("rate_limit") ||
    normalized.includes("quota") ||
    normalized.includes("额度")
  );
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

    const parsed = codexUsageCheckResult(payload);
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
    const { response, text } = await fetchTemporaryAccountCheckText(OPENAI_MODELS_URL, {
      headers: {
        Authorization: `Bearer ${account.secret}`,
        Accept: "application/json"
      }
    }, proxyConfig);
    if (!response.ok) {
      const errorMessage = extractUpstreamError(text) || `HTTP ${response.status}`;
      return {
        patch: {
          availability: "unavailable" as const,
          quotaStages: account.quotaStages,
          lastQuotaCheckedAt: checkedAt,
          lastCheckStatusCode: response.status,
          lastCheckError: errorMessage
        },
        result: {
          availability: "unavailable" as const,
          status: "failed" as const,
          statusCode: response.status,
          quotaStages: account.quotaStages,
          errorMessage,
          checkedAt
        }
      };
    }
    return {
      patch: {
        availability: "available" as const,
        quotaStages: account.quotaStages,
        lastQuotaCheckedAt: checkedAt,
        lastCheckStatusCode: response.status,
        lastCheckError: undefined
      },
      result: {
        availability: "available" as const,
        status: "success" as const,
        statusCode: response.status,
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
    const checkedAt = new Date().toISOString();
    const accountProxy = proxyConfig || siteProxyForTemporaryAccountGroup(groupId);
    try {
      const accountIsCodex = account.accountType === "codex" || Boolean(account.accountId);
      const providerType = account.providerType || "gpt";
      const check = providerType === "grok"
        ? await checkGrokTemporaryAccount(account, checkedAt, accountProxy)
        : accountIsCodex
          ? await checkCodexTemporaryAccount(account, checkedAt, accountProxy)
          : await checkOpenAiApiKeyTemporaryAccount(account, checkedAt, accountProxy);
      const updated = store.updateTemporaryAccountCheckResult(account.id, check.patch);
      return {
        groupId,
        accountId: account.id,
        label: account.label,
        availability: check.result.availability,
        status: check.result.status,
        statusCode: check.result.statusCode,
        quotaStages: updated?.quotaStages || check.result.quotaStages,
        errorMessage: check.result.errorMessage,
        checkedAt
      };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const errorMessage = upstreamNetworkErrorMessage(error, "账号检查请求上游失败");
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
    if (agentIdentity) {
      await resetCodexTemporaryAccount(activeAccount, agentIdentityAuthorization(activeAccount), accountProxy, true);
    } else {
      try {
        await resetCodexTemporaryAccount(activeAccount, activeAccount.secret, accountProxy);
      } catch (error) {
        if (![401, 403].some((status) => String(error).includes(`HTTP ${status}`)) || !account.refreshToken) throw error;
        const refreshed = await refreshCodexTemporaryAccountToken(account, accountProxy);
        if (!refreshed) throw error;
        activeAccount = { ...activeAccount, ...refreshed };
        await resetCodexTemporaryAccount(activeAccount, activeAccount.secret, accountProxy);
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
