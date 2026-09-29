import type { JsonStore } from "./store.js";
import { shouldMarkTemporaryAccountUnavailable } from "./account-check.js";
import type {
  AppDatabase,
  DownstreamModelRule,
  EndpointKind,
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

/** Direct mappings reuse route execution without creating or modifying a saved route. */
export function modelRuleTargetRoute(db: AppDatabase, rule: DownstreamModelRule, endpoint: EndpointKind = "chat/completions"): RouteRecord | undefined {
  if (rule.targetRouteId) return db.routes.find((route) => route.id === rule.targetRouteId);
  if (!rule.targetSiteId || !rule.targetModel) return undefined;
  const site = db.sites.find((site) => site.id === rule.targetSiteId);
  return {
    id: `model-rule:${rule.id}`, name: rule.name, type: "switch", enabled: rule.enabled,
    siteId: rule.targetSiteId, model: rule.targetModel, endpoint, headerTemplateId: rule.headerTemplateId, temporaryAccountId: rule.temporaryAccountId,
    createdAt: site?.createdAt || new Date(0).toISOString(),
    updatedAt: site?.updatedAt || new Date(0).toISOString()
  };
}

/** Compare live forwarding settings without advancing random or sequential account selection. */
export function proxyRouteConfigurationKey(store: JsonStore, routeOrId: string | RouteRecord) {
  const db = store.getDb();
  const route = typeof routeOrId === "string" ? db.routes.find((route) => route.id === routeOrId) : routeOrId;
  if (!route) return "";
  const { name, createdAt, updatedAt, ...routeConfig } = route;
  const siteIds = new Set(route.type === "switch" ? [route.siteId] : (route.members || []).map((member) => member.siteId));
  return JSON.stringify({
    route: routeConfig,
    sites: db.sites.filter((site) => siteIds.has(site.id)).map((site) => ({
      id: site.id, name: site.name, siteType: site.siteType, enabled: site.enabled,
      addresses: site.addresses.map(({ id, baseUrl, enabled, proxy }) => ({ id, baseUrl, enabled, proxy }))
    })),
    keys: db.providerApiKeyGroups.filter((group) => siteIds.has(group.siteId)).map((group) => ({
      siteId: group.siteId,
      keys: group.apiKeys.map(({ id, secret, enabled, kind, models }) => ({ id, secret, enabled, kind, models }))
    })),
    accounts: db.temporaryAccountGroups.filter((group) => siteIds.has(group.siteId)).map((group) => ({
      id: group.id, enabled: group.enabled, strategy: group.strategy, preferredAccountId: group.preferredAccountId,
      // Quota checks and automatic OAuth refreshes must not reset an in-flight retry budget.
      accounts: group.accounts.map((account) => ({
        id: account.id, enabled: account.enabled, models: account.models, accountType: account.accountType,
        providerType: account.providerType, upstreamBaseUrl: account.upstreamBaseUrl, grokOAuthFormat: account.grokOAuthFormat,
        secret: account.accountType === "api-key" || account.accountType === "openai-api-key" ? account.secret : undefined
      }))
    })),
    headerTemplate: db.headerTemplates.find((template) => template.id === route.headerTemplateId)?.headersText,
    accountStrategy: db.settings.temporaryAccountStrategy
  });
}






export function createRouting(store: JsonStore) {
  const routeRuntimeState = new Map<string, { stableCandidateKey?: string }>();

  function markTemporaryAccountAttempt(candidate: ProxyExecutionCandidate, statusCode: number, errorMessage?: string, errorBody?: string) {
    const account = candidate.temporaryAccount || candidate.temporaryApiKeyAccount;
    if (!account) return;
    if (statusCode === 499 || /客户端已(?:中止|断开)|\b(?:this|the) operation was aborted\b/i.test(errorMessage || "")) return;
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
    if (!shouldMarkTemporaryAccountUnavailable(statusCode, errorMessage, errorBody)) return;
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
    return `${candidate.site.id}::${candidate.providerApiKey?.id || candidate.temporaryAccount?.id || candidate.temporaryApiKeyAccount?.id || ""}::${candidate.model}`;
  }

  function candidateLogKey(candidate: ProxyExecutionCandidate) {
    return `${candidate.site.id}::${candidate.model}`;
  }

  function preferredStableCandidateKey(route: GroupRoute, candidates: ProxyExecutionCandidate[]) {
    const respectAccountPolicy = (key: string) => {
      const previous = candidates.find((candidate) => candidateKey(candidate) === key || candidateLogKey(candidate) === key);
      if (previous?.temporaryAccount || previous?.temporaryApiKeyAccount) {
        const current = candidates.find((candidate) => candidate.site.id === previous.site.id && candidate.model === previous.model);
        if (current) return candidateKey(current);
      }
      return key;
    };
    const runtimeKey = routeRuntimeState.get(route.id)?.stableCandidateKey;
    if (runtimeKey && candidates.some((candidate) => candidateKey(candidate) === runtimeKey)) return respectAccountPolicy(runtimeKey);

    const savedKey = store.getRouteLastSuccess(route.id);
    return savedKey && candidates.some((candidate) => candidateKey(candidate) === savedKey || candidateLogKey(candidate) === savedKey)
      ? respectAccountPolicy(savedKey) : undefined;
  }

  function orderedGroupCandidates(route: GroupRoute, candidates: ProxyExecutionCandidate[]) {
    if (route.strategy === "priority" || route.strategy === "specified") return candidates;
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
    store.setRouteLastSuccess(route.id, candidateKey(candidate));
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

  function resolveProxyExecution(routeNameOrId: string | RouteRecord) {
    const db = store.getDb();
    const route = typeof routeNameOrId === "string"
      ? db.routes.find((item) => item.id === routeNameOrId || item.name === routeNameOrId)
      : routeNameOrId;
    if (!route || !route.enabled) throw new Error("路由不存在或已停用");

    if (route.type === "switch") {
      const site = db.sites.find((item) => item.id === route.siteId);
      const addresses = site ? enabledSiteAddresses(site) : [];
      if (!site || addresses.length === 0) throw new Error("路由绑定的供应商地址不可用");
      const officialProviderApiKey = store.resolveProviderApiKey(site.id, route.model);
      const useChatGptOfficial = officialProviderApiKey?.kind === "chatgpt-official";
      const useGrokOfficial = officialProviderApiKey?.kind === "grok-official";
      const managedProvider = store.accountProviderForSite(site.id);
      const temporaryAccounts = useChatGptOfficial || store.isOfficialOpenAiSite(site.id)
        ? store.resolveTemporaryOpenAiAccounts(route.model)
        : useGrokOfficial
          ? store.resolveTemporaryProviderAccounts("grok", route.model)
        : managedProvider
          ? store.resolveTemporaryProviderAccounts(managedProvider, route.model)
        : resolveTemporaryProviderAccountsForRoute(site, route.model);
      const selectedTemporaryAccounts = route.temporaryAccountId
        ? temporaryAccounts.filter((account) => account.id === route.temporaryAccountId)
        : temporaryAccounts;
      if (selectedTemporaryAccounts.length > 0) {
        const candidates: ProxyExecutionCandidate[] = selectedTemporaryAccounts.map((temporaryAccount, index) => {
          const temporaryAccountIsCodex = isCodexTemporaryAccount(temporaryAccount);
          const temporaryAccountIsGrok = temporaryAccount.providerType === "grok";
          return {
            site,
            addresses,
            model: route.model,
            providerApiKey: temporaryAccountIsCodex || temporaryAccountIsGrok ? undefined : temporaryAccount,
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
          providerApiKey: useChatGptOfficial || useGrokOfficial || officialProviderApiKey?.kind === "account-pool" ? undefined : officialProviderApiKey,
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
    const selectedMembers =
      route.strategy === "specified"
        ? (() => {
            if (!route.specifiedMember) throw new Error(`分组路由 ${route.name} 未配置指定模型`);
            const specifiedKey = routeMemberKey(route.specifiedMember);
            const matched = members.filter((member) => routeMemberKey(member) === specifiedKey);
            if (matched.length === 0) throw new Error(`分组路由 ${route.name} 指定模型不可用`);
            return matched;
          })()
        : members;
    for (const member of selectedMembers) {
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
            providerApiKey: temporaryAccountIsCodex ? undefined : temporaryAccount,
            temporaryAccount: temporaryAccountIsCodex ? temporaryAccount : undefined,
            temporaryApiKeyAccount: temporaryAccountIsCodex ? undefined : temporaryAccount,
            headerTemplate,
            index: candidates.length
          });
        }
        continue;
      }
      if (apiKey.kind === "account-pool") {
        const provider = store.accountProviderForSite(site.id);
        if (!provider) continue;
        for (const account of store.resolveTemporaryProviderAccounts(provider, member.model)) {
          candidates.push({ site, addresses, model: member.model, providerApiKey: account, temporaryApiKeyAccount: account, headerTemplate, index: candidates.length });
        }
        continue;
      }
      const grokTemporaryAccounts =
        temporaryAccountProviderTypeForSite(site) === "grok"
          ? store.resolveTemporaryProviderAccounts("grok", member.model)
          : [];
      if (grokTemporaryAccounts.length > 0) {
        for (const temporaryAccount of grokTemporaryAccounts) {
          candidates.push({
            site,
            addresses,
            model: member.model,
            providerApiKey: undefined,
            temporaryApiKeyAccount: temporaryAccount,
            headerTemplate,
            index: candidates.length
          });
        }
        continue;
      }
      if (apiKey.kind === "grok-official") continue;
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
