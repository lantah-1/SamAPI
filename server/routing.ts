import type { JsonStore } from "./store.js";
import { shouldMarkTemporaryAccountUnavailable } from "./account-check.js";
import { grokBrowserEnvironmentIssueText, grokInvalidCredentialsText, isGrokWebTemporaryAccount } from "./providers/grok.js";
import type {
  GroupRoute,
  HeaderTemplate,
  ProviderApiKeyEntry,
  RouteRecord,
  Site,
  SiteAddress,
  SwitchRoute,
  TemporaryAccount
} from "../shared/types.js";

export interface ProxyExecutionCandidate {
  site: Site;
  addresses: SiteAddress[];
  model: string;
  providerApiKey?: ProviderApiKeyEntry;
  temporaryAccount?: TemporaryAccount;
  temporaryApiKeyAccount?: TemporaryAccount;
  headerTemplate?: HeaderTemplate;
  index: number;
}






export function createRouting(store: JsonStore) {
  const routeRuntimeState = new Map<string, { stableCandidateKey?: string }>();

  function markTemporaryAccountAttempt(candidate: ProxyExecutionCandidate, statusCode: number, errorMessage?: string) {
    const account = candidate.temporaryAccount || candidate.temporaryApiKeyAccount;
    if (!account) return;
    const checkedAt = new Date().toISOString();
    if (statusCode >= 200 && statusCode < 300 && !errorMessage) {
      store.updateTemporaryAccountCheckResult(account.id, {
        availability: "available",
        lastQuotaCheckedAt: checkedAt,
        lastCheckStatusCode: statusCode,
        lastCheckError: undefined
      });
      return;
    }
    if (account.providerType === "grok") {
      const message = errorMessage || `HTTP ${statusCode}`;
      if (statusCode === 401 || grokInvalidCredentialsText(message)) {
        store.updateTemporaryAccountCheckResult(account.id, {
          availability: "unavailable",
          lastQuotaCheckedAt: checkedAt,
          lastCheckStatusCode: statusCode,
          lastCheckError: message
        });
        return;
      }
      if (statusCode === 403 || grokBrowserEnvironmentIssueText(message)) {
        store.updateTemporaryAccountCheckResult(account.id, {
          availability: "unknown",
          lastQuotaCheckedAt: checkedAt,
          lastCheckStatusCode: statusCode,
          lastCheckError: `${message}；账号未判定不可用，请用导出 cf_clearance 的同一出口/防封 Docker 代理重试`
        });
        return;
      }
    }
    if (!shouldMarkTemporaryAccountUnavailable(statusCode, errorMessage)) return;
    store.updateTemporaryAccountCheckResult(account.id, {
      availability: "unavailable",
      lastQuotaCheckedAt: checkedAt,
      lastCheckStatusCode: statusCode,
      lastCheckError: errorMessage || `HTTP ${statusCode}`
    });
  }


  function enabledSiteAddresses(site: Site) {
    if (site.enabled === false) return [];
    return site.addresses.filter((address) => address.enabled);
  }

  function routeHeaderTemplate(route: SwitchRoute | GroupRoute) {
    return route.headerTemplateId ? store.getDb().headerTemplates.find((item) => item.id === route.headerTemplateId) : undefined;
  }

  function candidateKey(candidate: ProxyExecutionCandidate) {
    return `${candidate.site.id}::${candidate.providerApiKey?.id || candidate.temporaryAccount?.id || ""}::${candidate.model}`;
  }

  function candidateLogKey(candidate: ProxyExecutionCandidate) {
    return `${candidate.site.id}::${candidate.model}`;
  }

  function preferredStableCandidateKey(route: GroupRoute, candidates: ProxyExecutionCandidate[]) {
    const runtimeKey = routeRuntimeState.get(route.id)?.stableCandidateKey;
    if (runtimeKey && candidates.some((candidate) => candidateKey(candidate) === runtimeKey)) return runtimeKey;

    const recentSuccess = store
      .listRequestLogs()
      .find((log) => log.routeId === route.id && log.status === "success" && log.providerId && log.model);
    if (!recentSuccess?.providerId || !recentSuccess.model) return undefined;

    return candidates.find((candidate) => candidateLogKey(candidate) === `${recentSuccess.providerId}::${recentSuccess.model}`)
      ? `${recentSuccess.providerId}::${recentSuccess.model}`
      : undefined;
  }

  function orderedGroupCandidates(route: GroupRoute, candidates: ProxyExecutionCandidate[]) {
    if (route.strategy === "priority") return candidates;
    if (route.strategy === "random") {
      const shuffled = [...candidates];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
      }
      return shuffled;
    }
    if (route.strategy === "stable-first") {
      const preferredKey = preferredStableCandidateKey(route, candidates);
      if (!preferredKey) return candidates;
      const preferredIndex = candidates.findIndex(
        (candidate) => candidateKey(candidate) === preferredKey || candidateLogKey(candidate) === preferredKey
      );
      if (preferredIndex <= 0) return candidates;
      const preferred = candidates[preferredIndex];
      return [preferred, ...candidates.filter((_, index) => index !== preferredIndex)];
    }
    return candidates;
  }

  function markCandidateSuccess(route: RouteRecord, candidate: ProxyExecutionCandidate) {
    if (route.type !== "group" || route.strategy !== "stable-first") return;
    routeRuntimeState.set(route.id, {
      stableCandidateKey: candidateKey(candidate)
    });
  }

  function routeMemberKey(member: { siteId: string; apiKeyId: string; model: string }) {
    return `${member.siteId}::${member.apiKeyId}::${member.model}`;
  }

  function temporaryAccountProviderTypeForSite(site: Site) {
    const text = [site.name, ...site.addresses.map((address) => address.baseUrl)].join(" ").toLowerCase();
    if (text.includes("grok") || text.includes("x.ai")) return "grok" as const;
    return undefined;
  }

  function temporaryAccountProviderTypeForModel(model: string) {
    return model.toLowerCase().includes("grok") ? "grok" as const : undefined;
  }

  function resolveTemporaryProviderAccountsForRoute(site: Site, model: string) {
    const providerType = temporaryAccountProviderTypeForSite(site) || temporaryAccountProviderTypeForModel(model);
    if (!providerType) return [];
    return store.resolveTemporaryProviderAccounts(providerType, model);
  }

  function isCodexTemporaryAccount(account: TemporaryAccount) {
    return account.providerType === "gpt" && (account.accountType === "codex" || Boolean(account.accountId));
  }

  function resolveProxyExecution(routeNameOrId: string) {
    const db = store.getDb();
    const route = db.routes.find((item) => item.id === routeNameOrId || item.name === routeNameOrId);
    if (!route || !route.enabled) throw new Error("路由不存在或已停用");

    if (route.type === "switch") {
      const site = db.sites.find((item) => item.id === route.siteId);
      const addresses = site ? enabledSiteAddresses(site) : [];
      if (!site || addresses.length === 0) throw new Error("路由绑定的供应商地址不可用");
      const officialProviderApiKey = store.resolveProviderApiKey(site.id, route.model);
      const useChatGptOfficial = officialProviderApiKey?.kind === "chatgpt-official";
      const temporaryAccounts = useChatGptOfficial || store.isOfficialOpenAiSite(site.id)
        ? store.resolveTemporaryOpenAiAccounts(route.model)
        : resolveTemporaryProviderAccountsForRoute(site, route.model);
      if (temporaryAccounts.length > 0) {
        const candidates: ProxyExecutionCandidate[] = temporaryAccounts.map((temporaryAccount, index) => {
          const temporaryAccountIsCodex = isCodexTemporaryAccount(temporaryAccount);
          return {
            site,
            addresses,
            model: route.model,
            providerApiKey: temporaryAccountIsCodex || isGrokWebTemporaryAccount(temporaryAccount) ? undefined : temporaryAccount,
            temporaryAccount: temporaryAccountIsCodex ? temporaryAccount : undefined,
            temporaryApiKeyAccount: temporaryAccountIsCodex ? undefined : temporaryAccount,
            headerTemplate: routeHeaderTemplate(route),
            index
          };
        });
        return {
          route,
          candidates
        };
      }
      const candidates: ProxyExecutionCandidate[] = [
        {
          site,
          addresses,
          model: route.model,
          providerApiKey: officialProviderApiKey,
          headerTemplate: routeHeaderTemplate(route),
          index: 0
        }
      ];
      return {
        route,
        candidates
      };
    }

    const headerTemplate = routeHeaderTemplate(route);
    const candidates: ProxyExecutionCandidate[] = [];
    const usedMembers = new Set<string>();
    const members =
      route.members?.length > 0
        ? route.members
        : db.providerApiKeyGroups.flatMap((group) =>
            group.apiKeys.flatMap((apiKey) =>
              apiKey.models
                .filter((model) => model === route.modelGroupId)
                .map((model) => ({ siteId: group.siteId, apiKeyId: apiKey.id, model }))
            )
          );
    for (const member of members) {
      const memberKey = routeMemberKey(member);
      if (usedMembers.has(memberKey)) continue;
      usedMembers.add(memberKey);
      const site = db.sites.find((item) => item.id === member.siteId);
      if (!site) continue;
      const addresses = enabledSiteAddresses(site);
      if (addresses.length === 0) continue;
      const group = db.providerApiKeyGroups.find((item) => item.siteId === member.siteId && item.apiKeys.some((apiKey) => apiKey.id === member.apiKeyId));
      const apiKey = group?.apiKeys.find((item) => item.id === member.apiKeyId);
      if (!apiKey?.enabled || !apiKey.models.includes(member.model)) continue;
      if (apiKey.kind === "chatgpt-official") {
        for (const temporaryAccount of store.resolveTemporaryOpenAiAccounts(member.model)) {
          const temporaryAccountIsCodex = isCodexTemporaryAccount(temporaryAccount);
          candidates.push({
            site,
            addresses,
            model: member.model,
            providerApiKey: temporaryAccountIsCodex || isGrokWebTemporaryAccount(temporaryAccount) ? undefined : temporaryAccount,
            temporaryAccount: temporaryAccountIsCodex ? temporaryAccount : undefined,
            temporaryApiKeyAccount: temporaryAccountIsCodex ? undefined : temporaryAccount,
            headerTemplate,
            index: candidates.length
          });
        }
        continue;
      }
      candidates.push({
        site,
        addresses,
        model: member.model,
        providerApiKey: apiKey,
        headerTemplate,
        index: candidates.length
      });
    }
    if (candidates.length === 0) throw new Error(`分组路由 ${route.name} 没有可用模型`);
    return { route, candidates: orderedGroupCandidates(route, candidates) };
  }



  return {
    routeRuntimeState,
    markTemporaryAccountAttempt,
    markCandidateSuccess,
    resolveProxyExecution
  };
}
