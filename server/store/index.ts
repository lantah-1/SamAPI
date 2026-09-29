import { randomBytes, randomUUID } from "node:crypto";
import DatabaseConstructor, { type Database as SqliteDatabase } from "better-sqlite3";
import { validateModelRuleTargets } from "../../shared/model-rules.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  ApiKeyCreated,
  ApiKeyRecord,
  AppBackup,
  AppBackupImportResult,
  AppDatabase,
  AppSettings,
  GroupRoute,
  GroupRouteMember,
  HeaderTemplate,
  ProviderApiKeyEntry,
  ProviderApiKeyGroup,
  ProviderApiKeyGroupInput,
  ProviderApiKeyKind,
  ProviderModelManageMode,
  ProviderModelSyncStatus,
  RequestLogInput,
  RouteDisplayGroup,
  RouteProxyConfig,
  RouteRecord,
  Site,
  SiteAddress,
  SwitchRoute,
  TemporaryAccount,
  TemporaryAccountAvailability,
  TemporaryAccountGroup,
  TemporaryAccountImportInput,
  TemporaryAccountImportSource,
  TemporaryAccountProviderType,
  TemporaryAccountQuotaStage
} from "../../shared/types.js";
import {
  CHATGPT_OFFICIAL_PROVIDER_KEY_ID,
  CHATGPT_OFFICIAL_PROVIDER_KEY_LABEL,
  GROK_BASE_URL,
  GROK_OFFICIAL_PROVIDER_KEY_ID,
  GROK_OFFICIAL_PROVIDER_KEY_LABEL,
  OPENAI_BASE_URL,
  TEMPORARY_ACCOUNT_PROVIDER_LABELS,
  createEmptyDatabase,
  groupMemberKey,
  hashSecret,
  normalizeBaseUrl,
  normalizeGroupRouteMember,
  normalizeGroupStrategy,
  normalizeMatchRule,
  normalizeModelList,
  normalizePasswordHash,
  normalizeProviderModelManageMode,
  normalizeProviderModelSyncStatus,
  normalizeRouteProxy,
  normalizeSettings,
  normalizeSiteType,
  normalizeTemporaryAccountAvailability,
  normalizeTemporaryAccountProviderType,
  now,
  parseTemporaryAccountImport,
  smartModelMatches,
  temporaryAccountCanBeUsed
} from "./helpers.js";
import { RequestLogStore } from "./request-logs.js";
import type { LogResponseTool } from "../log-context.js";
import { UsageStore } from "./usage.js";
import type { ModelPriceInput, ModelPriceSyncState, OfficialModelPrice, UsageFilters, UsageRecordInput } from "../../shared/usage.js";
import { accountProviders, type AccountProvider, type ManagedAccountInput, type ManagedAccountPatch, type ManagedAccountsSnapshot } from "../../shared/accounts.js";
import { accountProvider, managedAccountView } from "../accounts.js";

function normalizedTemporaryAccountLabel(
  account: Pick<TemporaryAccount, "label" | "email" | "accountId" | "agentRuntimeId">,
  index: number
) {
  const current = account.label?.trim() || "";
  if (current && !/^(?:账号|账户|account)\s*\d+$/i.test(current)) return current;
  const email = account.email?.trim();
  if (email) return email;
  const accountId = account.accountId?.trim();
  if (accountId) return `账号 ${accountId.slice(0, 8)}`;
  const runtimeId = account.agentRuntimeId?.trim();
  if (runtimeId) return `Agent ${runtimeId.slice(0, 8)}`;
  return `账号 ${index + 1}`;
}

export class JsonStore {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly logsPath: string;
  readonly temporaryAccountsPath: string;
  readonly sqlitePath: string;
  private readonly sqlite: SqliteDatabase;
  private db: AppDatabase;
  private readonly requestLogStore: RequestLogStore;
  private readonly usageStore: UsageStore;
  private readonly temporaryAccountIndexes = new Map<string, number>();

  constructor(dataDir = process.env.SAMAPI_DATA_DIR || path.resolve(process.cwd(), "data")) {
    this.dataDir = path.resolve(dataDir);
    this.dbPath = path.join(this.dataDir, "samapi.json");
    this.logsPath = path.join(this.dataDir, "request-logs.jsonl");
    this.temporaryAccountsPath = path.join(this.dataDir, "temporary-accounts.json");
    this.sqlitePath = path.join(this.dataDir, "samapi.sqlite");
    mkdirSync(this.dataDir, { recursive: true });
    this.sqlite = new DatabaseConstructor(this.sqlitePath);
    this.initializeSqlite();
    this.usageStore = new UsageStore(this.sqlite);
    this.requestLogStore = new RequestLogStore(this.sqlite, (log) => {
      if (log.status !== "success" || !log.routeId || !log.providerId || !log.model) return;
      this.sqlite.prepare(`INSERT INTO route_last_success (route_id, candidate_key, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(route_id) DO UPDATE SET candidate_key = excluded.candidate_key, updated_at = excluded.updated_at
        WHERE excluded.updated_at >= route_last_success.updated_at`).run(log.routeId, `${log.providerId}::${log.model}`, log.createdAt);
    });
    this.db = this.load();
    this.requestLogStore.migrate(this.db.settings.maxRequestLogs);
    this.usageStore.recoverInterruptedRecords();
    const migratedRouteProxies = this.migrateRouteProxiesToAddresses();
    this.ensureOfficialChatGptProviderKeyGroup();
    this.ensureOfficialGrokSite();
    this.ensureOfficialGrokProviderKeyGroup();
    const mergedTemporaryAccounts = this.mergeTemporaryAccountTypeGroups();
    const migratedAccountPolicies = this.migrateManagedAccountPolicies();
    const migratedGrokModels = this.migrateOfficialGrokAddressModelsToProviderKey();
    const removedUnsupportedGrokAccounts = this.removeUnsupportedGrokAccounts();
    this.refreshGroupRouteMembers();
    if (migratedRouteProxies || mergedTemporaryAccounts || migratedGrokModels || removedUnsupportedGrokAccounts || migratedAccountPolicies) this.persist();
    let managedAccountsSynced = false;
    for (const group of this.db.temporaryAccountGroups) {
      if (group.providerType && group.providerType !== "gpt" && group.providerType !== "grok") { this.syncManagedAccountModels(accountProvider(group.providerType)); managedAccountsSynced = true; }
    }
    if (managedAccountsSynced) this.persist();
  }

  getDb() {
    return this.db;
  }

  close() {
    if (this.sqlite.open) this.sqlite.close();
  }

  recordUsage(record: UsageRecordInput) { this.usageStore.record(record); }
  usageReport(filters: UsageFilters = {}) { return this.usageStore.report(filters, this.db.apiKeys); }
  estimateMissingUsage(filters: UsageFilters = {}) { return this.usageStore.estimateMissingRecords(filters); }
  listModelPrices() { return this.usageStore.listPrices(); }
  saveModelPrice(price: ModelPriceInput) { return this.usageStore.savePrice(price); }
  deleteModelPrice(id: string) { this.usageStore.deletePrice(id); }
  priceUnpricedUsage() { return this.usageStore.priceUnpricedRecords(); }
  modelPriceSyncStates() { return this.usageStore.priceSyncStates(); }
  saveModelPriceSyncState(state: ModelPriceSyncState) { this.usageStore.savePriceSyncState(state); }
  saveOfficialModelPrices(prices: OfficialModelPrice[], state: ModelPriceSyncState) { this.usageStore.saveOfficialPrices(prices, state); }

  managedAccounts(): ManagedAccountsSnapshot {
    return { providers: (Object.keys(accountProviders) as AccountProvider[]).map((provider) => {
      const group = this.db.temporaryAccountGroups.find((item) => (item.providerType || "gpt") === provider);
      const models = [...new Set(this.db.providerApiKeyGroups.filter((item) => item.siteId === group?.siteId).flatMap((item) => item.apiKeys.flatMap((key) => key.models)))].sort();
      return { provider, siteId: group?.siteId, strategy: group?.strategy || this.db.settings.temporaryAccountStrategy, preferredAccountId: group?.preferredAccountId, models, accounts: group?.accounts.map((account) => managedAccountView(account, group)) || [] };
    }) };
  }

  accountProviderForSite(siteId: string): AccountProvider | undefined {
    const group = this.db.temporaryAccountGroups.find((item) => item.siteId === siteId && item.providerType !== "grok");
    return group ? accountProvider(group.providerType || "gpt") : undefined;
  }

  private ensureAccountSite(provider: AccountProvider) {
    if (provider === "gpt") return this.ensureOfficialOpenAiSite();
    const group = this.db.temporaryAccountGroups.find((item) => item.providerType === provider);
    const assigned = this.db.sites.find((item) => item.id === group?.siteId);
    if (assigned && !this.isOfficialOpenAiSite(assigned.id)) return assigned;
    const definition = accountProviders[provider];
    const hostname = new URL(definition.baseUrl).hostname;
    const existing = this.db.sites.find((site) => site.addresses.some((address) => { try { return new URL(address.baseUrl).hostname === hostname; } catch { return false; } }));
    return existing || this.upsertSite({ name: definition.label, addresses: [{ id: `addr-${randomUUID()}`, label: "官方 API", baseUrl: definition.baseUrl, models: [], enabled: true, proxy: { mode: "direct" } }] });
  }

  private migrateManagedAccountPolicies() {
    const previous = this.sqlite.prepare("SELECT value FROM meta WHERE key = 'managed_account_policy_format'").get() as { value: string } | undefined;
    if (previous?.value === "2") return false;
    // Older group.strategy values were unused; the global strategy controlled all pools.
    // Preserve that behavior until the administrator explicitly selects a per-provider policy.
    let changed = false;
    for (const group of this.db.temporaryAccountGroups) {
      if ((group.providerType === "grok" || !previous && !group.preferredAccountId) && group.strategy !== undefined) { group.strategy = undefined; changed = true; }
    }
    this.sqlite.transaction(() => {
      if (!previous) this.sqlite.prepare("UPDATE temporary_account_groups SET strategy = NULL WHERE preferred_account_id IS NULL").run();
      this.sqlite.prepare("UPDATE temporary_account_groups SET strategy = NULL WHERE provider_type = 'grok'").run();
      this.sqlite.prepare("INSERT INTO meta (key, value) VALUES ('managed_account_policy_format', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    })();
    return changed;
  }

  createManagedAccount(input: ManagedAccountInput) {
    const provider = accountProvider(input.provider);
    if (provider === "grok") throw new Error("Grok 账号请通过 OAuth JSON 导入");
    const label = typeof input.label === "string" ? input.label.trim() : "";
    const secret = typeof input.secret === "string" ? input.secret.trim() : "";
    if (!label || label.length > 200) throw new Error("账号名称不能为空且最多 200 字符");
    if (!secret || secret.length > 4096 || /\s/.test(secret)) throw new Error("API Key 无效");
    if (input.models !== undefined && (!Array.isArray(input.models) || input.models.some((model) => typeof model !== "string"))) throw new Error("模型列表无效");
    if (this.db.temporaryAccountGroups.some((group) => (group.providerType || "gpt") === provider && group.accounts.some((account) => account.secret === secret))) throw new Error("该供应商已存在使用相同凭据的账号");
    const site = this.ensureAccountSite(provider);
    const group = this.ensureTemporaryAccountTypeGroup(provider, site.id, "subapi");
    const account: TemporaryAccount = { id: `account-${randomUUID()}`, label, prefix: secret.slice(0, 12), secret, providerType: provider, accountType: "api-key", enabled: true, models: normalizeModelList(input.models), availability: "unknown", quotaStages: [], importedAt: now() };
    group.accounts.push(account); group.enabled = true; group.updatedAt = now();
    if (!group.preferredAccountId && group.accounts.length === 1) { group.preferredAccountId = account.id; group.strategy = "priority"; }
    this.syncManagedAccountModels(provider);
    this.persist();
    return managedAccountView(account, group);
  }

  updateManagedAccount(id: string, input: ManagedAccountPatch) {
    const target = this.temporaryAccountCheckTarget(id);
    if (!target) throw new Error("账号不存在");
    const { account, group } = target;
    if (input.label !== undefined && (typeof input.label !== "string" || !input.label.trim() || input.label.length > 200)) throw new Error("账号名称无效");
    if (input.models !== undefined && (!Array.isArray(input.models) || input.models.some((model) => typeof model !== "string"))) throw new Error("模型列表无效");
    if (input.secret !== undefined && typeof input.secret !== "string") throw new Error("API Key 无效");
    const secret = input.secret?.trim();
    if (secret) {
      if (managedAccountView(account, group).kind !== "api-key") throw new Error("登录账号请重新授权，不能替换为 API Key");
      if (secret.length > 4096 || /\s/.test(secret)) throw new Error("API Key 无效");
      if (group.accounts.some((item) => item.id !== id && item.secret === secret)) throw new Error("此凭据已被其他账号使用");
    }
    if (input.label !== undefined) account.label = input.label.trim();
    if (input.models !== undefined) account.models = normalizeModelList(input.models);
    if (typeof input.enabled === "boolean") account.enabled = input.enabled;
    if (secret) { account.secret = secret; account.prefix = secret.slice(0, 12); account.availability = "unknown"; account.lastCheckError = undefined; account.quotaStages = []; }
    group.updatedAt = now();
    this.syncManagedAccountModels(accountProvider(group.providerType || "gpt"));
    this.persist();
    return managedAccountView(account, group);
  }

  setManagedAccountPolicy(providerInput: unknown, input: { strategy?: string; preferredAccountId?: string }) {
    const provider = accountProvider(providerInput);
    const group = this.db.temporaryAccountGroups.find((item) => (item.providerType || "gpt") === provider);
    if (!group) throw new Error("请先添加该供应商的账号");
    if (input.strategy && !["priority", "stable-first", "sequential", "random"].includes(input.strategy)) throw new Error("账号调度策略无效");
    if (input.preferredAccountId) {
      const account = group.accounts.find((item) => item.id === input.preferredAccountId);
      if (!account || !account.enabled || account.availability === "unavailable") throw new Error("默认账号必须已启用且未失效");
      group.preferredAccountId = account.id; group.strategy = "priority";
    } else if (input.strategy) {
      group.strategy = input.strategy as TemporaryAccountGroup["strategy"];
      if (input.strategy === "sequential" || input.strategy === "random") group.preferredAccountId = undefined;
    }
    group.updatedAt = now(); this.persist();
    return this.managedAccounts();
  }

  createManagedAccountRoute(providerInput: unknown, input: { name?: string; model?: string }) {
    const provider = accountProvider(providerInput);
    const group = this.db.temporaryAccountGroups.find((item) => (item.providerType || "gpt") === provider);
    if (!group || !group.accounts.some((account) => account.enabled)) throw new Error("请先添加并启用账号");
    if (!input.model || !this.resolveTemporaryProviderAccounts(provider, input.model).length) throw new Error("没有支持该模型的可用账号");
    return this.upsertRoute({ type: "switch", name: input.name?.trim() || `${provider}-${input.model}`, siteId: group.siteId, model: input.model, endpoint: accountProviders[provider].endpoint, enabled: true });
  }

  private syncManagedAccountModels(provider: AccountProvider) {
    // Grok keeps its existing official account pool and model-management source.
    if (provider === "grok") return;
    const accountGroup = this.db.temporaryAccountGroups.find((group) => (group.providerType || "gpt") === provider);
    if (!accountGroup) return;
    const assignedSite = this.db.sites.find((site) => site.id === accountGroup.siteId);
    const site = provider === "gpt" ? this.ensureOfficialOpenAiSite() : assignedSite && !this.isOfficialOpenAiSite(assignedSite.id) ? assignedSite : this.ensureAccountSite(provider);
    accountGroup.siteId = site.id;
    let group = this.db.providerApiKeyGroups.find((item) => item.siteId === site.id && item.apiKeys.some((key) => key.kind === (provider === "gpt" ? "chatgpt-official" : "account-pool")));
    if (!group) {
      if (provider === "gpt") { this.ensureOfficialChatGptProviderKeyGroup(); group = this.db.providerApiKeyGroups.find((item) => item.siteId === site.id && item.apiKeys.some((key) => key.kind === "chatgpt-official")); }
      else {
        const timestamp = now();
        group = { id: `provider-key-group-accounts-${provider}`, siteId: site.id, groupName: `${accountProviders[provider].label} 账号`, modelManageMode: "manual", apiKeys: [{ id: `provider-key-accounts-${provider}`, label: `${accountProviders[provider].label} 账号池`, prefix: "account-pool", secret: "", kind: "account-pool", enabled: true, models: [] }], createdAt: timestamp, updatedAt: timestamp };
        this.db.providerApiKeyGroups.push(group);
      }
    }
    const key = group?.apiKeys.find((item) => item.kind === (provider === "gpt" ? "chatgpt-official" : "account-pool"));
    if (key) {
      const models = accountGroup.accounts.filter((account) => account.enabled).flatMap((account) => account.models);
      key.models = [...new Set([...(provider === "gpt" ? key.models : []), ...models])].sort();
      this.syncSiteModelsFromProviderKeys(site.id); this.refreshGroupRouteMembers();
    }
  }

  exportBackup(): AppBackup {
    const { adminPasswordHash: _adminPasswordHash, ...data } = this.db;
    return {
      format: "samapi-backup",
      version: 1,
      accountPolicyVersion: 2,
      exportedAt: now(),
      data: structuredClone(data)
    };
  }

  importBackup(input: unknown): AppBackupImportResult {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("备份文件内容无效");
    const backup = input as Partial<AppBackup>;
    if (backup.format !== "samapi-backup") throw new Error("不是 SamAPI 备份文件");
    if (backup.version !== 1) throw new Error(`不支持的备份版本：${String(backup.version ?? "未知")}`);
    if (!backup.data || typeof backup.data !== "object" || Array.isArray(backup.data)) throw new Error("备份文件缺少配置数据");

    const data = backup.data as Partial<AppDatabase>;
    const collectionNames = [
      "sites",
      "apiKeys",
      "providerApiKeyGroups",
      "temporaryAccountGroups",
      "headerTemplates",
      "routes",
      "routeDisplayGroups"
    ] as const;
    for (const name of collectionNames) {
      if (!Array.isArray(data[name])) throw new Error(`备份文件中的 ${name} 数据无效`);
    }

    const next: AppDatabase = {
      sites: structuredClone(data.sites!),
      apiKeys: structuredClone(data.apiKeys!),
      providerApiKeyGroups: structuredClone(data.providerApiKeyGroups!).map((group) => this.normalizeProviderApiKeyGroup(group)),
      temporaryAccountGroups: structuredClone(data.temporaryAccountGroups!),
      headerTemplates: structuredClone(data.headerTemplates!),
      routes: structuredClone(data.routes!),
      routeDisplayGroups: structuredClone(data.routeDisplayGroups!),
      settings: normalizeSettings(data.settings),
      adminPasswordHash: this.db.adminPasswordHash
    };

    for (const site of next.sites) {
      if (!site?.id || !site.name?.trim() || !Array.isArray(site.addresses)) throw new Error("备份文件包含无效的供应商数据");
      site.siteType = normalizeSiteType(site.siteType);
      site.enabled = site.enabled !== false;
      site.addresses = site.addresses.map((address) => this.normalizeAddress(address));
    }
    for (const key of next.apiKeys) {
      if (!key?.id || !key.name || !key.keyHash) throw new Error("备份文件包含无效的下游 API Key");
      key.models = normalizeModelList(key.models);
      key.enabled = key.enabled !== false;
    }
    for (const group of next.providerApiKeyGroups) {
      if (!group?.id || !group.siteId || !Array.isArray(group.apiKeys)) throw new Error("备份文件包含无效的上游密钥分组");
      group.apiKeys = group.apiKeys.map((key, index) => this.normalizeProviderApiKeyEntry(key, index));
    }
    for (const group of next.temporaryAccountGroups) {
      if (!group?.id || !group.siteId || !Array.isArray(group.accounts)) throw new Error("备份文件包含无效的临时账号分组");
      group.providerType = normalizeTemporaryAccountProviderType(group.providerType || group.name);
      group.strategy = group.strategy === undefined ? undefined : normalizeGroupStrategy(group.strategy);
      if (group.providerType === "grok" ? backup.accountPolicyVersion !== 2 : !backup.accountPolicyVersion && !group.preferredAccountId) group.strategy = undefined;
      group.enabled = group.enabled !== false;
      for (const account of group.accounts) {
        if (!account?.id || typeof account.secret !== "string") throw new Error("备份文件包含无效的临时账号");
        account.models = normalizeModelList(account.models);
        account.enabled = account.enabled !== false;
        account.availability = normalizeTemporaryAccountAvailability(account.availability);
        account.quotaStages = Array.isArray(account.quotaStages) ? account.quotaStages : [];
      }
    }
    for (const template of next.headerTemplates) {
      if (!template?.id || !template.name || typeof template.headersText !== "string") throw new Error("备份文件包含无效的请求头模板");
    }
    for (const route of next.routes) {
      if (!route?.id || !route.name || (route.type !== "switch" && route.type !== "group")) throw new Error("备份文件包含无效的路由");
    }
    validateModelRuleTargets(next.settings.downstreamModelRules, next);
    for (const group of next.routeDisplayGroups) {
      if (!group?.id || !group.name || !Array.isArray(group.routeIds)) throw new Error("备份文件包含无效的路由展示分组");
    }

    this.sqlite.transaction(() => {
      this.replaceSqliteDatabase(next);
      this.requestLogStore.trim(next.settings.maxRequestLogs);
    })();
    this.db = next;

    return {
      ok: true,
      importedAt: now(),
      counts: {
        sites: next.sites.length,
        apiKeys: next.apiKeys.length,
        providerApiKeyGroups: next.providerApiKeyGroups.length,
        temporaryAccounts: next.temporaryAccountGroups.reduce((total, group) => total + group.accounts.length, 0),
        headerTemplates: next.headerTemplates.length,
        routes: next.routes.length
      }
    };
  }

  listProviderApiKeyGroups() {
    return this.db.providerApiKeyGroups.map((group) => this.toProviderApiKeyGroupView(group));
  }

  private mergeTemporaryAccountTypeGroups() {
    const merged = new Map<TemporaryAccountProviderType, TemporaryAccountGroup>();
    let changed = false;
    for (const group of this.db.temporaryAccountGroups) {
      const providerType = normalizeTemporaryAccountProviderType(group.providerType || group.name.toLowerCase());
      const existing = merged.get(providerType);
      if (!existing) {
        const normalizedGroupEnabled = group.enabled !== false;
        const normalizedAccounts = group.accounts.map((account, index) => ({
          ...account,
          label: normalizedTemporaryAccountLabel(account, index),
          providerType,
          enabled: account.enabled !== false
        }));
        const accountsNeedNormalization = group.accounts.some((account, index) =>
          account.label !== normalizedAccounts[index]?.label || account.providerType !== providerType || typeof account.enabled !== "boolean"
        );
        if (group.providerType !== providerType || group.name !== TEMPORARY_ACCOUNT_PROVIDER_LABELS[providerType] || group.enabled !== normalizedGroupEnabled || accountsNeedNormalization) {
          changed = true;
        }
        group.providerType = providerType;
        group.name = TEMPORARY_ACCOUNT_PROVIDER_LABELS[providerType];
        group.enabled = normalizedGroupEnabled;
        group.accounts = normalizedAccounts;
        merged.set(providerType, group);
        continue;
      }
      const existingIds = new Set(existing.accounts.map((account) => account.id));
      const existingSecrets = new Set(existing.accounts.map((account) => hashSecret(account.secret.trim() || account.refreshToken?.trim() || account.id)));
      const incoming = group.accounts
        .filter((account) => !existingIds.has(account.id) && !existingSecrets.has(hashSecret(account.secret.trim() || account.refreshToken?.trim() || account.id)))
        .map((account, index) => ({
          ...account,
          label: normalizedTemporaryAccountLabel(account, existing.accounts.length + index),
          providerType,
          enabled: account.enabled !== false
        }));
      existing.accounts.push(...incoming);
      existing.updatedAt = now();
      changed = true;
    }
    const nextGroups = Array.from(merged.values());
    if (nextGroups.length !== this.db.temporaryAccountGroups.length) changed = true;
    this.db.temporaryAccountGroups = nextGroups;
    return changed;
  }

  private removeUnsupportedGrokAccounts() {
    let changed = false;
    for (const group of this.db.temporaryAccountGroups) {
      if (normalizeTemporaryAccountProviderType(group.providerType || group.name.toLowerCase()) !== "grok") continue;
      const supported = group.accounts.filter((account) => {
        const isOAuth = Boolean(account.grokOAuthFormat || account.refreshToken?.trim() || account.idToken?.trim());
        if (!isOAuth) changed = true;
        return isOAuth;
      });
      for (const account of supported) {
        if (!account.grokOAuthFormat) {
          account.grokOAuthFormat = "cpa-oauth";
          changed = true;
        }
      }
      group.accounts = supported;
    }
    const nonEmptyGroups = this.db.temporaryAccountGroups.filter((group) => group.accounts.length > 0);
    if (nonEmptyGroups.length !== this.db.temporaryAccountGroups.length) changed = true;
    this.db.temporaryAccountGroups = nonEmptyGroups;
    return changed;
  }

  listRequestLogs(limit = this.db.settings.maxRequestLogs, offset = 0) {
    return this.requestLogStore.list(limit, offset);
  }

  listNewRequestLogs(since: string, limit = this.db.settings.maxRequestLogs) {
    return this.requestLogStore.list(limit, 0, since);
  }

  getRequestLog(id: string) {
    return this.requestLogStore.get(id);
  }

  updateRequestLog(id: string, patch: Partial<Omit<RequestLogInput, "id" | "createdAt">>) {
    return this.requestLogStore.update(id, patch);
  }

  requestLogCount() {
    return this.requestLogStore.count();
  }

  recordRequestLog(input: Omit<RequestLogInput, "id" | "createdAt">) {
    return this.requestLogStore.record(input, this.db.settings.maxRequestLogs);
  }

  associateRequestLog(id: string, headers: Record<string, string>, body: unknown, clientScope: string) {
    return this.requestLogStore.associate(id, headers, body, clientScope);
  }

  observeRequestLog(id: string, observationId: string, responseIds: string[], tools: LogResponseTool[]) {
    this.requestLogStore.observe(id, observationId, responseIds, tools);
  }

  getRouteLastSuccess(routeId: string) {
    const row = this.sqlite.prepare("SELECT candidate_key FROM route_last_success WHERE route_id = ?").get(routeId) as { candidate_key: string } | undefined;
    return row?.candidate_key;
  }

  setRouteLastSuccess(routeId: string, candidateKey: string) {
    this.sqlite.prepare(`INSERT INTO route_last_success (route_id, candidate_key, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(route_id) DO UPDATE SET candidate_key = excluded.candidate_key, updated_at = excluded.updated_at`).run(routeId, candidateKey, now());
  }

  updateSettings(input: Partial<AppSettings>) {
    const settings = normalizeSettings({ ...this.db.settings, ...input });
    if (input.downstreamModelRules !== undefined) validateModelRuleTargets(settings.downstreamModelRules, this.db);
    this.db.settings = settings;
    this.requestLogStore.trim(this.db.settings.maxRequestLogs);
    this.persist();
    return this.db.settings;
  }

  getAdminPasswordHash() {
    return this.db.adminPasswordHash;
  }

  updateAdminPasswordHash(password: string) {
    if (password.length < 4 || !password.trim()) throw new Error("新管理密码至少需要 4 个字符");
    this.db.adminPasswordHash = hashSecret(password);
    this.persist();
  }

  ensureOfficialOpenAiSite() {
    const existing = this.officialOpenAiSite();
    if (existing) return existing;
    const timestamp = now();
    const created: Site = {
      id: `site-${randomUUID()}`,
      name: "OpenAI",
      siteType: "unknown",
      enabled: true,
      addresses: [
        {
          id: `addr-${randomUUID()}`,
          label: "官方 API",
          baseUrl: OPENAI_BASE_URL,
          enabled: true,
          models: []
        }
      ],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.sites.unshift(created);
    this.persist();
    return created;
  }

  officialOpenAiSite() {
    return this.db.sites.find((site) =>
      site.addresses.some((address) => {
        try {
          const parsed = new URL(address.baseUrl);
          return parsed.hostname.toLowerCase() === "api.openai.com";
        } catch {
          return false;
        }
      })
    );
  }

  isOfficialOpenAiSite(siteId: string) {
    return this.officialOpenAiSite()?.id === siteId;
  }

  ensureOfficialGrokSite() {
    const existing = this.officialGrokSite();
    if (existing) return existing;
    const timestamp = now();
    const created: Site = {
      id: `site-${randomUUID()}`,
      name: "Grok",
      siteType: "unknown",
      enabled: true,
      addresses: [
        {
          id: `addr-${randomUUID()}`,
          label: "xAI 官方 API",
          baseUrl: GROK_BASE_URL,
          enabled: true,
          models: []
        }
      ],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.sites.unshift(created);
    this.persist();
    return created;
  }

  officialGrokSite() {
    return this.db.sites.find((site) =>
      site.addresses.some((address) => {
        try {
          const parsed = new URL(address.baseUrl);
          return parsed.hostname.toLowerCase() === "api.x.ai";
        } catch {
          return false;
        }
      })
    );
  }

  isOfficialGrokSite(siteId: string) {
    return this.officialGrokSite()?.id === siteId;
  }

  ensureOfficialGrokProviderKeyGroup() {
    const site = this.ensureOfficialGrokSite();
    const existing = this.db.providerApiKeyGroups.find((group) =>
      group.siteId === site.id && group.apiKeys.some((apiKey) => apiKey.kind === "grok-official")
    );
    if (existing) return this.toProviderApiKeyGroupView(existing);
    const timestamp = now();
    const group: ProviderApiKeyGroup = {
      id: "provider-key-group-grok-official",
      siteId: site.id,
      groupName: "Grok",
      modelManageMode: "manual",
      apiKeys: [this.normalizeProviderApiKeyEntry({ kind: "grok-official", label: GROK_OFFICIAL_PROVIDER_KEY_LABEL, enabled: true }, 0)],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.providerApiKeyGroups.unshift(group);
    this.persist();
    return this.toProviderApiKeyGroupView(group);
  }

  private migrateOfficialGrokAddressModelsToProviderKey() {
    const site = this.officialGrokSite();
    if (!site) return false;
    const addressModels = normalizeModelList(site.addresses.flatMap((address) => address.models));
    const group = this.db.providerApiKeyGroups.find((item) =>
      item.siteId === site.id && item.apiKeys.some((apiKey) => apiKey.kind === "grok-official")
    );
    const apiKey = group?.apiKeys.find((item) => item.kind === "grok-official");
    if (!group || !apiKey) return false;
    const otherProviderModels = new Set(
      this.db.providerApiKeyGroups
        .filter((item) => item.siteId === site.id)
        .flatMap((item) => item.apiKeys)
        .filter((item) => item.id !== apiKey.id)
        .flatMap((item) => item.models)
    );
    const legacyModels = addressModels.filter((model) => !otherProviderModels.has(model));
    const nextModels = normalizeModelList([...apiKey.models, ...legacyModels]);
    const modelChanged = apiKey.models.join("\n") !== nextModels.join("\n");
    if (modelChanged) {
      apiKey.models = nextModels;
      group.updatedAt = now();
    }
    const expectedSiteModels = normalizeModelList(
      this.db.providerApiKeyGroups
        .filter((item) => item.siteId === site.id)
        .flatMap((item) => item.apiKeys)
        .filter((item) => item.enabled)
        .flatMap((item) => item.models)
    );
    const siteModelsChanged = site.addresses.some(
      (address) => normalizeModelList(address.models).join("\n") !== expectedSiteModels.join("\n")
    );
    if (!modelChanged && !siteModelsChanged) return false;
    this.syncSiteModelsFromProviderKeys(site.id);
    return true;
  }

  ensureOfficialChatGptProviderKeyGroup() {
    const site = this.ensureOfficialOpenAiSite();
    const existing = this.db.providerApiKeyGroups.find((group) =>
      group.siteId === site.id && group.apiKeys.some((apiKey) => apiKey.kind === "chatgpt-official")
    );
    if (existing) return this.toProviderApiKeyGroupView(existing);
    const timestamp = now();
    const group: ProviderApiKeyGroup = {
      id: `provider-key-group-chatgpt-official`,
      siteId: site.id,
      groupName: "OpenAI",
      modelManageMode: "manual",
      apiKeys: [this.normalizeProviderApiKeyEntry({ kind: "chatgpt-official", label: CHATGPT_OFFICIAL_PROVIDER_KEY_LABEL, enabled: true }, 0)],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.providerApiKeyGroups.unshift(group);
    this.syncSiteModelsFromProviderKeys(site.id);
    this.persist();
    return this.toProviderApiKeyGroupView(group);
  }

  saveCodexOAuthAccount(input: {
    accessToken: string;
    refreshToken: string;
    idToken?: string;
    accountId?: string;
    email?: string;
    tokenExpiresAt?: string;
  }) {
    const timestamp = now();
    const site = this.ensureOfficialOpenAiSite();
    const group = this.ensureTemporaryAccountTypeGroup("gpt", site.id, "subapi", timestamp);
    const existing = group.accounts.find((account) =>
      account.providerType === "gpt" && (
        Boolean(input.accountId && account.accountId === input.accountId) ||
        account.refreshToken === input.refreshToken
      )
    );
    if (existing) {
      existing.label = input.email || existing.label;
      existing.prefix = input.accessToken.slice(0, 12);
      existing.secret = input.accessToken;
      existing.accountType = "codex";
      existing.accountId = input.accountId || existing.accountId;
      existing.email = input.email || existing.email;
      existing.refreshToken = input.refreshToken;
      existing.idToken = input.idToken || existing.idToken;
      existing.tokenExpiresAt = input.tokenExpiresAt;
      existing.enabled = true;
      existing.availability = "unknown";
      existing.lastCheckError = undefined;
      group.enabled = true;
      group.updatedAt = timestamp;
      this.persist();
      return { account: existing, created: false };
    }
    const account: TemporaryAccount = {
      id: `temp-account-${randomUUID()}`,
      label: input.email || input.accountId || "Codex OAuth",
      prefix: input.accessToken.slice(0, 12),
      secret: input.accessToken,
      accountType: "codex",
      providerType: "gpt",
      accountId: input.accountId,
      email: input.email,
      refreshToken: input.refreshToken,
      idToken: input.idToken,
      tokenExpiresAt: input.tokenExpiresAt,
      enabled: true,
      models: [],
      availability: "unknown",
      quotaStages: [],
      importedAt: timestamp
    };
    group.accounts.unshift(account);
    group.enabled = true;
    group.updatedAt = timestamp;
    this.persist();
    return { account, created: true };
  }

  importTemporaryAccounts(input: TemporaryAccountImportInput) {
    const timestamp = now();
    const source = input.mode === "cpa" || input.source === "cpa" ? "cpa" : "subapi";
    const providerType = normalizeTemporaryAccountProviderType(input.providerType);
    const site = providerType === "grok" ? this.ensureOfficialGrokSite() : this.ensureAccountSite(accountProvider(providerType));
    const models = normalizeModelList(input.models);
    const importItems = [
      ...(typeof input.content === "string" && input.content.trim() ? [{ name: "粘贴内容", content: input.content }] : []),
      ...(Array.isArray(input.contents)
        ? input.contents.flatMap((content, index) =>
            typeof content === "string" && content.trim()
              ? [{ name: input.fileNames?.[index] || `文件 ${index + 1}`, content }]
              : []
          )
        : [])
    ];
    const parsedItems = importItems.map((item) => ({
      ...item,
      accounts: parseTemporaryAccountImport(item.content, models, providerType, input.mode || "auto")
    }));
    const parsedAccounts = parsedItems.flatMap((item) => item.accounts);
    const unrecognizedFiles = parsedItems.filter((item) => item.accounts.length === 0).map((item) => item.name);
    if (parsedAccounts.length === 0) {
      const names = unrecognizedFiles.length > 0 ? `：${unrecognizedFiles.slice(0, 5).join("、")}` : "";
      if (input.mode === "sub2api-k12") {
        throw new Error(`没有解析到可用的 Sub2API K12 账号；需要 type 为 sub2api-data，accounts 内包含 platform=openai、type=oauth、plan_type=k12 且有 access_token 的记录${names}`);
      }
      throw new Error(providerType === "grok"
        ? `没有解析到可用的 Grok OAuth 账号；仅支持单账号 CPA / grok2api OAuth JSON，暂不支持 SSO JSON 和 accounts 列表${names}`
        : `没有解析到可用账号密钥${names}`);
    }
    const seen = new Set<string>(
      this.db.temporaryAccountGroups.filter((group) => (group.providerType || "gpt") === providerType).flatMap((group) =>
        group.accounts.map((account) => hashSecret(account.secret.trim() || account.refreshToken?.trim() || (account.accountId?.trim() && account.chatgptUserId?.trim() ? `${account.accountId}:${account.chatgptUserId}` : account.accountId?.trim()) || account.agentRuntimeId?.trim() || account.id))
      )
    );
    const group = this.ensureTemporaryAccountTypeGroup(providerType, site.id, source, timestamp);
    const accounts: TemporaryAccount[] = [];
    let skipped = 0;
    for (const account of parsedAccounts) {
      const secret = account.secret.trim();
      // Agent Identity exports intentionally contain no bearer token; account ID is its stable dedupe key.
      const credentialIdentity = secret || account.refreshToken?.trim() || (account.accountId?.trim() && account.chatgptUserId?.trim() ? `${account.accountId}:${account.chatgptUserId}` : account.accountId?.trim()) || account.agentRuntimeId?.trim() || "";
      if (!credentialIdentity) continue;
      const hash = hashSecret(credentialIdentity);
      if (seen.has(hash)) {
        skipped += 1;
        continue;
      }
      seen.add(hash);
      accounts.push({
        id: `temp-account-${randomUUID()}`,
        label: normalizedTemporaryAccountLabel(account, group.accounts.length + accounts.length),
        prefix: secret ? secret.slice(0, 12) : account.agentRuntimeId ? "agent-identity" : "oauth-refresh",
        secret,
        accountType: providerType === "gpt" ? account.accountType : providerType === "grok" ? undefined : "api-key",
        providerType,
        accountId: account.accountId,
        email: account.email,
        refreshToken: account.refreshToken,
        idToken: account.idToken,
        sessionToken: account.sessionToken,
        agentRuntimeId: account.agentRuntimeId,
        agentPrivateKey: account.agentPrivateKey,
        agentTaskId: account.agentTaskId,
        chatgptUserId: account.chatgptUserId,
        chatgptAccountIsFedramp: account.chatgptAccountIsFedramp,
        grokOAuthFormat: account.grokOAuthFormat,
        oauthClientId: account.oauthClientId,
        oauthTokenEndpoint: account.oauthTokenEndpoint,
        upstreamBaseUrl: account.upstreamBaseUrl,
        tokenExpiresAt: account.tokenExpiresAt,
        grokUsingApi: account.grokUsingApi,
        enabled: true,
        models: account.models.length > 0 ? account.models : models,
        availability: providerType === "gpt" ? "unknown" : account.quotaStages?.length ? "available" : "unknown",
        quotaStages: account.quotaStages || [],
        importedAt: timestamp
      });
    }
    if (accounts.length === 0) throw new Error("导入内容里没有新的可用账号");
    group.accounts.unshift(...accounts);
    group.source = source;
    group.enabled = true;
    group.providerType = providerType;
    group.updatedAt = timestamp;
    if (providerType !== "grok") this.syncManagedAccountModels(accountProvider(providerType));
    this.persist();
    return { site, group, imported: accounts.length, skipped, unrecognizedFiles, accountIds: accounts.map((account) => account.id) };
  }

  private ensureTemporaryAccountTypeGroup(providerType: TemporaryAccountProviderType, siteId: string, source: TemporaryAccountImportSource, timestamp = now()) {
    const existing = this.db.temporaryAccountGroups.find((group) => normalizeTemporaryAccountProviderType(group.providerType || group.name.toLowerCase()) === providerType);
    if (existing) return existing;
    const group: TemporaryAccountGroup = {
      id: `temp-account-group-${providerType}`,
      name: TEMPORARY_ACCOUNT_PROVIDER_LABELS[providerType],
      source,
      providerType,
      siteId,
      enabled: true,
      accounts: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.temporaryAccountGroups.unshift(group);
    return group;
  }

  updateTemporaryAccountGroup(id: string, input: Partial<TemporaryAccountGroup>) {
    const group = this.db.temporaryAccountGroups.find((item) => item.id === id);
    if (!group) throw new Error("临时账号组不存在");
    if (typeof input.name === "string" && input.name.trim()) group.name = input.name.trim();
    group.enabled = true;
    group.updatedAt = now();
    this.persist();
    return group;
  }

  deleteTemporaryAccountGroup(id: string) {
    this.db.temporaryAccountGroups = this.db.temporaryAccountGroups.filter((group) => group.id !== id);
    this.persist();
  }

  private orderedTemporaryAccountPool(pool: TemporaryAccount[], strategy: TemporaryAccountGroup["strategy"], poolKey: string) {
    if (pool.length === 0) return pool;
    if (strategy === "random") {
      const shuffled = [...pool];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
      }
      return shuffled;
    }
    if (strategy === "sequential") {
      const start = (this.temporaryAccountIndexes.get(poolKey) || 0) % pool.length;
      this.temporaryAccountIndexes.set(poolKey, (start + 1) % pool.length);
      return [...pool.slice(start), ...pool.slice(0, start)];
    }
    return pool;
  }

  resolveTemporaryProviderAccounts(providerType: TemporaryAccountProviderType, model: string) {
    const groups = this.db.temporaryAccountGroups.filter((group) => group.enabled !== false && normalizeTemporaryAccountProviderType(group.providerType) === providerType);
    const allEnabledAccounts = groups
      .flatMap((group) => group.accounts.filter((account) => account.enabled !== false));
    const candidates = allEnabledAccounts.filter((account) => account.models.length === 0 || account.models.includes(model));
    const pool = providerType === "grok" && candidates.length === 0 ? allEnabledAccounts : candidates;
    const usable = pool.filter(temporaryAccountCanBeUsed);
    if (usable.length === 0) return [];
    const available = usable.filter((account) => account.availability === "available");
    const unchecked = usable.filter((account) => account.availability !== "available");
    const strategy = groups[0]?.strategy || this.db.settings.temporaryAccountStrategy;
    const ordered = [...this.orderedTemporaryAccountPool(available, strategy, `${providerType}:available`), ...this.orderedTemporaryAccountPool(unchecked, strategy, `${providerType}:unknown`)];
    const preferred = (strategy === "priority" || strategy === "stable-first") ? ordered.find((account) => groups.some((group) => group.preferredAccountId === account.id)) : undefined;
    return preferred ? [preferred, ...ordered.filter((account) => account.id !== preferred.id)] : ordered;
  }

  resolveTemporaryOpenAiAccounts(model: string) {
    return this.resolveTemporaryProviderAccounts("gpt", model);
  }

  resolveTemporaryOpenAiAccount(model: string) {
    return this.resolveTemporaryOpenAiAccounts(model)[0];
  }

  temporaryAccountCheckTargets(groupId?: string, providerType: TemporaryAccountProviderType = "gpt") {
    return this.db.temporaryAccountGroups
      .filter((group) => normalizeTemporaryAccountProviderType(group.providerType) === providerType)
      .filter((group) => !groupId || group.id === groupId)
      .flatMap((group) => group.accounts.map((account) => ({ group, account })));
  }

  temporaryAccountCheckTarget(accountId: string, providerType?: TemporaryAccountProviderType) {
    for (const group of this.db.temporaryAccountGroups) {
      if (providerType && normalizeTemporaryAccountProviderType(group.providerType) !== providerType) continue;
      const account = group.accounts.find((item) => item.id === accountId);
      if (account) return { group, account };
    }
    return undefined;
  }

  updateTemporaryAccount(id: string, input: Partial<TemporaryAccount>) {
    for (const group of this.db.temporaryAccountGroups) {
      const account = group.accounts.find((item) => item.id === id);
      if (!account) continue;
      if (typeof input.enabled === "boolean") account.enabled = input.enabled;
      group.updatedAt = now();
      this.persist();
      return account;
    }
    throw new Error("临时账号不存在");
  }

  deleteTemporaryAccount(id: string) {
    for (const group of this.db.temporaryAccountGroups) {
      const nextAccounts = group.accounts.filter((account) => account.id !== id);
      if (nextAccounts.length === group.accounts.length) continue;
      group.accounts = nextAccounts;
      if (group.preferredAccountId === id) group.preferredAccountId = undefined;
      group.updatedAt = now();
      if (group.providerType !== "grok") this.syncManagedAccountModels(accountProvider(group.providerType || "gpt"));
      this.persist();
      return;
    }
  }

  deleteTemporaryAccounts(ids: string[]) {
    const idSet = new Set(ids);
    if (idSet.size === 0) return;
    let changed = false;
    for (const group of this.db.temporaryAccountGroups) {
      const nextAccounts = group.accounts.filter((account) => !idSet.has(account.id));
      if (nextAccounts.length === group.accounts.length) continue;
      group.accounts = nextAccounts;
      if (group.preferredAccountId && idSet.has(group.preferredAccountId)) group.preferredAccountId = undefined;
      group.updatedAt = now();
      changed = true;
    }
    if (!changed) return;
    for (const group of this.db.temporaryAccountGroups) if (group.providerType !== "grok") this.syncManagedAccountModels(accountProvider(group.providerType || "gpt"));
    this.persist();
  }

  updateTemporaryAccountCheckResult(
    accountId: string,
    input: {
      availability?: TemporaryAccountAvailability;
      quotaStages?: TemporaryAccountQuotaStage[];
      lastQuotaCheckedAt?: string;
      lastCheckStatusCode?: number;
      lastCheckError?: string;
      secret?: string;
      refreshToken?: string;
      idToken?: string;
      accountId?: string;
      email?: string;
      tokenExpiresAt?: string;
      agentTaskId?: string;
      models?: string[];
    }
  ) {
    for (const group of this.db.temporaryAccountGroups) {
      const account = group.accounts.find((item) => item.id === accountId);
      if (!account) continue;
      if (input.availability) account.availability = input.availability;
      if (input.models) account.models = normalizeModelList(input.models);
      if (input.quotaStages) account.quotaStages = input.quotaStages;
      if (input.lastQuotaCheckedAt) account.lastQuotaCheckedAt = input.lastQuotaCheckedAt;
      if (typeof input.lastCheckStatusCode === "number") account.lastCheckStatusCode = input.lastCheckStatusCode;
      account.lastCheckError = input.lastCheckError;
      if (typeof input.secret === "string" && input.secret.trim()) {
        account.secret = input.secret.trim();
        account.prefix = account.secret.slice(0, 12);
      }
      if (typeof input.refreshToken === "string" && input.refreshToken.trim()) account.refreshToken = input.refreshToken.trim();
      if (typeof input.idToken === "string" && input.idToken.trim()) account.idToken = input.idToken.trim();
      if (typeof input.accountId === "string" && input.accountId.trim()) account.accountId = input.accountId.trim();
      if (typeof input.email === "string" && input.email.trim()) account.email = input.email.trim();
      if ("tokenExpiresAt" in input) account.tokenExpiresAt = input.tokenExpiresAt?.trim() || undefined;
      if (typeof input.agentTaskId === "string" && input.agentTaskId.trim()) account.agentTaskId = input.agentTaskId.trim();
      group.updatedAt = now();
      if (input.models && group.providerType !== "grok") { this.syncManagedAccountModels(accountProvider(group.providerType || "gpt")); this.persist(); }
      else this.persistTemporaryAccountCheckResult(group.id, account);
      return account;
    }
    return undefined;
  }

  deleteRequestLog(id: string) {
    this.requestLogStore.delete(id);
  }

  clearRequestLogs() {
    this.requestLogStore.clear();
  }

  upsertSite(input: Partial<Site>) {
    const timestamp = now();
    const current = input.id ? this.db.sites.find((site) => site.id === input.id) : undefined;
    if (input.id && !current) throw new Error("站点不存在");
    const name = input.name ?? current?.name ?? "";
    const siteType = input.siteType ?? current?.siteType;
    const addressesInput = input.addresses ?? current?.addresses ?? [];
    const addresses = addressesInput.map((address) => this.normalizeAddress(address));
    if (!name.trim()) {
      throw new Error("站点名称不能为空");
    }
    if (addresses.length === 0) {
      throw new Error("至少需要一个地址");
    }

    if (current) {
      Object.assign(current, {
        name: name.trim(),
        siteType: normalizeSiteType(siteType),
        enabled: input.enabled ?? current.enabled ?? true,
        addresses,
        updatedAt: timestamp
      });
      this.persist();
      return current;
    }

    const created: Site = {
      id: `site-${randomUUID()}`,
      name: name.trim(),
      siteType: normalizeSiteType(siteType),
      enabled: input.enabled ?? true,
      addresses,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.sites.unshift(created);
    this.persist();
    return created;
  }

  deleteSite(id: string) {
    this.db.sites = this.db.sites.filter((site) => site.id !== id);
    this.db.providerApiKeyGroups = this.db.providerApiKeyGroups.filter((group) => group.siteId !== id);
    this.db.temporaryAccountGroups = this.db.temporaryAccountGroups.filter((group) => group.siteId !== id);
    this.db.routes = this.db.routes.map((route) => {
      if (route.type !== "switch" || route.siteId !== id) return route;
      return {
        ...route,
        siteId: "",
        addressId: undefined,
        updatedAt: now()
      };
    });
    this.refreshGroupRouteMembers();
    this.persist();
  }

  createApiKey(name: string, models: string[] = []): ApiKeyCreated {
    if (!name.trim()) throw new Error("密钥名称不能为空");
    const timestamp = now();
    const plainTextKey = `sk-samapi-${randomBytes(24).toString("base64url")}`;
    const created: ApiKeyCreated = {
      id: `key-${randomUUID()}`,
      name: name.trim(),
      prefix: plainTextKey.slice(0, 18),
      keyHash: hashSecret(plainTextKey),
      enabled: true,
      models: normalizeModelList(models),
      createdAt: timestamp,
      updatedAt: timestamp,
      plainTextKey
    };
    this.db.apiKeys.unshift(created);
    this.persist();
    return created;
  }

  updateApiKey(id: string, input: Partial<ApiKeyRecord>) {
    const current = this.db.apiKeys.find((key) => key.id === id);
    if (!current) throw new Error("密钥不存在");
    if (typeof input.name === "string") current.name = input.name.trim();
    if (typeof input.enabled === "boolean") current.enabled = input.enabled;
    if (Array.isArray(input.models)) current.models = normalizeModelList(input.models);
    current.updatedAt = now();
    this.persistApiKey(current);
    this.persist();
    return current;
  }

  deleteApiKey(id: string) {
    this.db.apiKeys = this.db.apiKeys.filter((key) => key.id !== id);
    this.persist();
  }

  upsertProviderApiKeyGroup(input: ProviderApiKeyGroupInput) {
    const timestamp = now();
    if (!input.siteId) throw new Error("请选择供应商");

    const site = this.db.sites.find((item) => item.id === input.siteId);
    if (!site) throw new Error("供应商不存在");
    const groupName = input.groupName?.trim() || site.name;
    const normalizeInputKey = (key: ProviderApiKeyGroupInput["apiKeys"] extends Array<infer Entry> | undefined ? Entry : never) =>
      this.isOfficialGrokSite(site.id) ? { ...key, kind: "grok-official" as const, secret: "" } : key;

    if (input.id) {
      const current = this.db.providerApiKeyGroups.find((group) => group.id === input.id);
      if (!current) throw new Error("API Key 分组不存在");
      const previousSiteId = current.siteId;
      const apiKeys = (input.apiKeys || []).map((key, index) => this.normalizeProviderApiKeyEntry(normalizeInputKey(key), index, current.apiKeys));
      if (apiKeys.length === 0) throw new Error("至少需要一个 API Key");
      Object.assign(current, {
        siteId: input.siteId,
        groupName,
        modelManageMode: input.modelManageMode ? normalizeProviderModelManageMode(input.modelManageMode) : current.modelManageMode || "manual",
        apiKeys,
        updatedAt: timestamp
      });
      if (previousSiteId !== input.siteId) this.syncSiteModelsFromProviderKeys(previousSiteId);
      this.syncSiteModelsFromProviderKeys(input.siteId);
      this.refreshGroupRouteMembers();
      this.persist();
      return this.toProviderApiKeyGroupView(current);
    }

    const apiKeys = (input.apiKeys || []).map((key, index) => this.normalizeProviderApiKeyEntry(normalizeInputKey(key), index));
    if (apiKeys.length === 0) throw new Error("至少需要一个 API Key");

    const created: ProviderApiKeyGroup = {
      id: `provider-key-group-${randomUUID()}`,
      siteId: input.siteId,
      groupName,
      modelManageMode: normalizeProviderModelManageMode(input.modelManageMode),
      apiKeys,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.providerApiKeyGroups.unshift(created);
    this.syncSiteModelsFromProviderKeys(input.siteId);
    this.refreshGroupRouteMembers();
    this.persist();
    return this.toProviderApiKeyGroupView(created);
  }

  updateProviderApiKeyGroupModelManageMode(id: string, modelManageMode: ProviderModelManageMode) {
    const current = this.db.providerApiKeyGroups.find((group) => group.id === id);
    if (!current) throw new Error("API Key 分组不存在");
    current.modelManageMode = normalizeProviderModelManageMode(modelManageMode);
    current.updatedAt = now();
    this.persist();
    return this.toProviderApiKeyGroupView(current);
  }

  updateProviderApiKeyGroupModelSyncState(
    id: string,
    state: {
      lastModelSyncAt?: string;
      lastModelSyncStatus?: ProviderModelSyncStatus;
      lastModelSyncMessage?: string;
    }
  ) {
    const current = this.db.providerApiKeyGroups.find((group) => group.id === id);
    if (!current) throw new Error("API Key 分组不存在");
    if (state.lastModelSyncAt !== undefined) current.lastModelSyncAt = state.lastModelSyncAt;
    if (state.lastModelSyncStatus !== undefined) current.lastModelSyncStatus = state.lastModelSyncStatus;
    if (state.lastModelSyncMessage !== undefined) current.lastModelSyncMessage = state.lastModelSyncMessage;
    current.updatedAt = now();
    this.persist();
    return this.toProviderApiKeyGroupView(current);
  }

  deleteProviderApiKeyGroup(id: string) {
    const current = this.db.providerApiKeyGroups.find((group) => group.id === id);
    this.db.providerApiKeyGroups = this.db.providerApiKeyGroups.filter((group) => group.id !== id);
    if (current) this.syncSiteModelsFromProviderKeys(current.siteId);
    this.refreshGroupRouteMembers();
    this.persist();
  }

  updateProviderApiKeyModels(groupId: string, apiKeyId: string, models: string[], checkedAt = now()) {
    const group = this.db.providerApiKeyGroups.find((item) => item.id === groupId);
    if (!group) throw new Error("API Key 分组不存在");
    const apiKey = group.apiKeys.find((item) => item.id === apiKeyId);
    if (!apiKey) throw new Error("API Key 不存在");
    apiKey.models = Array.from(new Set(models.map((model) => String(model).trim()).filter(Boolean))).sort();
    apiKey.lastCheckedAt = checkedAt;
    group.updatedAt = now();
    this.syncSiteModelsFromProviderKeys(group.siteId);
    this.refreshGroupRouteMembers();
    this.persist();
    return this.toProviderApiKeyGroupView(group);
  }

  resolveProviderApiKey(siteId: string, model: string) {
    const candidates = this.db.providerApiKeyGroups
      .filter((group) => group.siteId === siteId)
      .flatMap((group) => group.apiKeys)
      .filter((apiKey) => apiKey.enabled);
    return (
      candidates.find((apiKey) => apiKey.models.includes(model)) ||
      candidates.find((apiKey) => apiKey.models.length === 0)
    );
  }

  verifyApiKey(secret?: string) {
    if (this.db.apiKeys.length === 0) return true;
    if (!secret) return false;
    const keyHash = hashSecret(secret.replace(/^Bearer\s+/i, "").trim());
    const found = this.db.apiKeys.find((key) => key.enabled && key.keyHash === keyHash);
    if (!found) return false;
    found.lastUsedAt = now();
    this.persistApiKeyLastUsedAt(found);
    return found;
  }

  upsertHeaderTemplate(input: Partial<HeaderTemplate>) {
    const timestamp = now();
    if (!input.name?.trim()) throw new Error("模版名称不能为空");

    if (input.id) {
      const current = this.db.headerTemplates.find((template) => template.id === input.id);
      if (!current) throw new Error("Header 模版不存在");
      Object.assign(current, {
        name: input.name.trim(),
        headersText: input.headersText || "",
        updatedAt: timestamp
      });
      this.persist();
      return current;
    }

    const created: HeaderTemplate = {
      id: `header-${randomUUID()}`,
      name: input.name.trim(),
      headersText: input.headersText || "",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.headerTemplates.unshift(created);
    this.persist();
    return created;
  }

  deleteHeaderTemplate(id: string) {
    this.db.headerTemplates = this.db.headerTemplates.filter((template) => template.id !== id);
    this.db.routes = this.db.routes.map((route) => {
      if ((route.type === "switch" || route.type === "group") && route.headerTemplateId === id) {
        return { ...route, headerTemplateId: undefined, updatedAt: now() };
      }
      return route;
    });
    this.db.settings.downstreamModelRules = this.db.settings.downstreamModelRules.map((rule) =>
      rule.headerTemplateId === id ? { ...rule, headerTemplateId: undefined } : rule
    );
    this.persist();
  }

  upsertRoute(input: Partial<RouteRecord>) {
    const current = input.id ? this.db.routes.find((route) => route.id === input.id) : undefined;
    const routeType = input.type || current?.type || "switch";
    return routeType === "group"
      ? this.upsertGroupRoute(input as Partial<GroupRoute>)
      : this.upsertSwitchRoute(input as Partial<SwitchRoute>);
  }

  upsertSwitchRoute(input: Partial<SwitchRoute>) {
    const timestamp = now();
    if (!input.name?.trim()) throw new Error("路由名称不能为空");
    if (!input.siteId) throw new Error("请选择供应商");
    if (!input.model?.trim()) throw new Error("请选择模型");

    const site = this.db.sites.find((item) => item.id === input.siteId);
    if (!site) throw new Error("供应商不可用");

    const routeShape = {
      name: input.name.trim(),
      type: "switch" as const,
      siteId: input.siteId,
      addressId: undefined,
      model: input.model.trim(),
      endpoint: input.endpoint || "messages",
      headerTemplateId: input.headerTemplateId || undefined,
      temporaryAccountId: input.temporaryAccountId || undefined,
      enabled: input.enabled ?? true,
      updatedAt: timestamp
    };

    if (input.id) {
      const index = this.db.routes.findIndex((route) => route.id === input.id);
      if (index < 0) throw new Error("路由不存在");
      const current = this.db.routes[index];
      if (current.type === "switch") {
        Object.assign(current, routeShape);
      } else {
        this.db.routes[index] = {
          id: current.id,
          createdAt: current.createdAt,
          ...routeShape
        };
      }
      this.persist();
      return this.db.routes[index] as SwitchRoute;
    }

    const created: SwitchRoute = {
      id: `route-${randomUUID()}`,
      createdAt: timestamp,
      ...routeShape
    };
    this.db.routes.unshift(created);
    this.persist();
    return created;
  }

  upsertGroupRoute(input: Partial<GroupRoute>) {
    const timestamp = now();
    if (!input.name?.trim()) throw new Error("路由名称不能为空");
    const current = input.id ? this.db.routes.find((route) => route.id === input.id) : undefined;
    const currentGroup = current?.type === "group" ? current : undefined;
    const strategy = normalizeGroupStrategy(input.strategy ?? currentGroup?.strategy);
    const matchRule = normalizeMatchRule(input.matchRule ?? currentGroup?.matchRule ?? "");
    const members = this.normalizeGroupRouteMembers(
      input.members ?? currentGroup?.members ?? [],
      matchRule ? input.modelGroupId ?? currentGroup?.modelGroupId : undefined
    );
    if (members.length === 0) throw new Error("请至少选择一个组内模型");
    const specifiedMemberInput =
      input.specifiedMember !== undefined
        ? normalizeGroupRouteMember(input.specifiedMember)
        : currentGroup?.specifiedMember;
    const specifiedMember =
      strategy === "specified"
        ? (() => {
            if (!specifiedMemberInput) throw new Error("请选择指定的供应商模型");
            const memberKey = groupMemberKey(specifiedMemberInput);
            if (!members.some((member) => groupMemberKey(member) === memberKey)) {
              throw new Error("指定模型必须属于组内模型");
            }
            return specifiedMemberInput;
          })()
        : undefined;

    const routeShape = {
      name: input.name.trim(),
      type: "group" as const,
      strategy,
      modelGroupId: input.modelGroupId?.trim() || undefined,
      matchRule,
      members,
      specifiedMember,
      endpoint: input.endpoint || "messages",
      headerTemplateId: input.headerTemplateId || undefined,
      enabled: input.enabled ?? true,
      updatedAt: timestamp
    };

    if (input.id) {
      const index = this.db.routes.findIndex((route) => route.id === input.id);
      if (index < 0) throw new Error("路由不存在");
      const saved = this.db.routes[index];
      if (saved.type === "group") {
        Object.assign(saved, routeShape);
      } else {
        this.db.routes[index] = {
          id: saved.id,
          createdAt: saved.createdAt,
          ...routeShape
        };
      }
      this.persist();
      return this.db.routes[index] as GroupRoute;
    }

    const created: GroupRoute = {
      id: `route-${randomUUID()}`,
      createdAt: timestamp,
      ...routeShape
    };
    this.db.routes.unshift(created);
    this.persist();
    return created;
  }

  deleteRoute(id: string) {
    this.db.routes = this.db.routes.filter((route) => route.id !== id);
    this.pruneRouteDisplayGroups();
    this.persist();
  }

  listRouteDisplayGroups() {
    return this.db.routeDisplayGroups;
  }

  upsertRouteDisplayGroup(input: Partial<RouteDisplayGroup>) {
    const timestamp = now();
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) throw new Error("分组名称不能为空");
    const routeIds = this.normalizeDisplayGroupRouteIds(input.routeIds, input.id);

    if (input.id) {
      const current = this.db.routeDisplayGroups.find((group) => group.id === input.id);
      if (!current) throw new Error("展示分组不存在");
      current.name = name;
      current.routeIds = routeIds;
      current.updatedAt = timestamp;
      this.persist();
      return current;
    }

    const created: RouteDisplayGroup = {
      id: `route-display-group-${randomUUID()}`,
      name,
      routeIds,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.routeDisplayGroups.unshift(created);
    this.persist();
    return created;
  }

  deleteRouteDisplayGroup(id: string) {
    this.db.routeDisplayGroups = this.db.routeDisplayGroups.filter((group) => group.id !== id);
    this.persist();
  }

  private normalizeDisplayGroupRouteIds(routeIds: unknown, currentGroupId?: string) {
    const groupRouteIds = new Set(this.db.routes.filter((route) => route.type === "group").map((route) => route.id));
    const claimedElsewhere = new Set(
      this.db.routeDisplayGroups
        .filter((group) => group.id !== currentGroupId)
        .flatMap((group) => group.routeIds)
    );
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of Array.isArray(routeIds) ? routeIds : []) {
      const routeId = String(value);
      if (!groupRouteIds.has(routeId) || claimedElsewhere.has(routeId) || seen.has(routeId)) continue;
      seen.add(routeId);
      result.push(routeId);
    }
    return result;
  }

  private pruneRouteDisplayGroups() {
    const groupRouteIds = new Set(this.db.routes.filter((route) => route.type === "group").map((route) => route.id));
    let changed = false;
    for (const group of this.db.routeDisplayGroups) {
      const filtered = group.routeIds.filter((routeId) => groupRouteIds.has(routeId));
      if (filtered.length !== group.routeIds.length) {
        group.routeIds = filtered;
        group.updatedAt = now();
        changed = true;
      }
    }
    return changed;
  }

  resolveRoute(routeNameOrId: string) {
    const route = this.db.routes.find((item) => item.id === routeNameOrId || item.name === routeNameOrId);
    if (!route || route.type !== "switch" || !route.enabled) {
      throw new Error("切换型路由不存在或已停用");
    }
    const site = this.db.sites.find((item) => item.id === route.siteId);
    const addresses = site?.enabled === false ? [] : site?.addresses.filter((address) => address.enabled) || [];
    if (!site || addresses.length === 0) throw new Error("路由绑定的供应商地址不可用");
    const headerTemplate = route.headerTemplateId
      ? this.db.headerTemplates.find((item) => item.id === route.headerTemplateId)
      : undefined;
    return { route, site, addresses, headerTemplate };
  }

  private normalizeGroupRouteMembers(inputMembers: Array<Partial<GroupRouteMember>> = [], legacyModelGroupId?: string) {
    const members = new Map<string, GroupRouteMember>();
    const addMember = (input: Partial<GroupRouteMember>) => {
      const siteId = input.siteId?.trim();
      const apiKeyId = input.apiKeyId?.trim();
      const model = input.model?.trim();
      if (!siteId || !apiKeyId || !model) return;
      const group = this.db.providerApiKeyGroups.find((item) => item.siteId === siteId && item.apiKeys.some((apiKey) => apiKey.id === apiKeyId));
      const apiKey = group?.apiKeys.find((item) => item.id === apiKeyId);
      if (!group || !apiKey || !apiKey.models.includes(model)) return;
      const member = { siteId, apiKeyId, model };
      members.set(groupMemberKey(member), member);
    };

    for (const member of inputMembers) addMember(member);

    const addMatchingModels = (rule: string) => {
      if (!rule.trim()) return;
      for (const group of this.db.providerApiKeyGroups) {
        for (const apiKey of group.apiKeys) {
          for (const model of apiKey.models) {
            if (smartModelMatches(model, rule)) addMember({ siteId: group.siteId, apiKeyId: apiKey.id, model });
          }
        }
      }
    };

    if (members.size === 0 && legacyModelGroupId) addMatchingModels(legacyModelGroupId);
    return Array.from(members.values());
  }

  private refreshGroupRouteMembers() {
    this.db.routes = this.db.routes.map((route) => {
      if (route.type !== "group") return route;
      const matchRule = normalizeMatchRule(route.matchRule || "");
      if (!matchRule) return route;
      const members = this.normalizeGroupRouteMembers(route.members || [], matchRule ? route.modelGroupId : undefined);
      const oldKeys = (route.members || []).map(groupMemberKey).sort().join("\n");
      const newKeys = members.map(groupMemberKey).sort().join("\n");
      if (matchRule === route.matchRule && oldKeys === newKeys) return route;
      return {
        ...route,
        matchRule,
        members,
        updatedAt: now()
      };
    });
  }

  private migrateRouteProxiesToAddresses() {
    const proxiesBySite = new Map<string, RouteProxyConfig[]>();
    let changed = false;
    for (const route of this.db.routes) {
      const legacyRoute = route as RouteRecord & { proxy?: unknown };
      const proxy = normalizeRouteProxy(legacyRoute.proxy);
      if (proxy) {
        const siteIds = route.type === "switch"
          ? [route.siteId]
          : Array.from(new Set((route.members || []).map((member) => member.siteId)));
        for (const siteId of siteIds) {
          if (!siteId) continue;
          const current = proxiesBySite.get(siteId) || [];
          current.push(proxy);
          proxiesBySite.set(siteId, current);
        }
      }
      if (Object.prototype.hasOwnProperty.call(legacyRoute, "proxy")) {
        delete legacyRoute.proxy;
        changed = true;
      }
    }

    for (const site of this.db.sites) {
      const legacyProxies = proxiesBySite.get(site.id) || [];
      const distinctLegacyProxies = Array.from(
        new Map(legacyProxies.map((proxy) => [`${proxy.mode}:${proxy.url || ""}`, proxy])).values()
      );
      if (distinctLegacyProxies.length > 1) {
        console.warn(`Supplier ${site.name} had conflicting route proxy settings; migrated the most recent non-direct setting to its addresses.`);
      }
      const legacyProxy = distinctLegacyProxies[0];
      const addresses = site.addresses.map((address) => {
        const hasAddressProxy = Object.prototype.hasOwnProperty.call(address, "proxy");
        return this.normalizeAddress({
          ...address,
          proxy: hasAddressProxy ? address.proxy : legacyProxy
        });
      });
      if (JSON.stringify(addresses) !== JSON.stringify(site.addresses)) {
        site.addresses = addresses;
        site.updatedAt = now();
        changed = true;
      }
    }
    return changed;
  }

  private normalizeAddress(address: Partial<SiteAddress>): SiteAddress {
    if (!address.label?.trim()) throw new Error("地址名称不能为空");
    if (!address.baseUrl?.trim()) throw new Error("地址 URL 不能为空");
    const models = Array.isArray(address.models)
      ? address.models.map((model) => String(model).trim()).filter(Boolean)
      : [];
    return {
      id: address.id || `addr-${randomUUID()}`,
      label: address.label.trim(),
      baseUrl: normalizeBaseUrl(address.baseUrl),
      enabled: address.enabled ?? true,
      models,
      proxy: normalizeRouteProxy(address.proxy)
    };
  }

  private initializeSqlite() {
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth (id INTEGER PRIMARY KEY CHECK (id = 1), admin_password_hash TEXT);
      CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY, name TEXT NOT NULL, site_type TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, addresses_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL, plain_text_key TEXT, enabled INTEGER NOT NULL, models_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT);
      CREATE TABLE IF NOT EXISTS provider_api_key_groups (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, group_name TEXT NOT NULL, model_manage_mode TEXT NOT NULL DEFAULT 'manual', last_model_sync_at TEXT, last_model_sync_status TEXT, last_model_sync_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_api_keys (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, label TEXT NOT NULL, prefix TEXT NOT NULL, secret TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'api-key', enabled INTEGER NOT NULL, models_json TEXT NOT NULL, last_checked_at TEXT, FOREIGN KEY (group_id) REFERENCES provider_api_key_groups(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS idx_provider_api_keys_group_id ON provider_api_keys(group_id);
      CREATE TABLE IF NOT EXISTS temporary_account_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, provider_type TEXT, site_id TEXT NOT NULL, strategy TEXT, enabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS temporary_accounts (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, label TEXT NOT NULL, prefix TEXT NOT NULL, secret TEXT NOT NULL, account_type TEXT, provider_type TEXT, account_id TEXT, email TEXT, refresh_token TEXT, id_token TEXT, session_token TEXT, agent_runtime_id TEXT, agent_private_key TEXT, agent_task_id TEXT, chatgpt_user_id TEXT, chatgpt_account_is_fedramp INTEGER, grok_oauth_format TEXT, oauth_client_id TEXT, oauth_token_endpoint TEXT, upstream_base_url TEXT, token_expires_at TEXT, grok_using_api INTEGER, enabled INTEGER NOT NULL, models_json TEXT NOT NULL, availability TEXT, quota_stages_json TEXT NOT NULL, imported_at TEXT NOT NULL, last_quota_checked_at TEXT, last_check_status_code INTEGER, last_check_error TEXT, FOREIGN KEY (group_id) REFERENCES temporary_account_groups(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS idx_temporary_accounts_group_id ON temporary_accounts(group_id);
      CREATE INDEX IF NOT EXISTS idx_temporary_accounts_enabled ON temporary_accounts(enabled);
      CREATE INDEX IF NOT EXISTS idx_temporary_accounts_availability ON temporary_accounts(availability);
      CREATE TABLE IF NOT EXISTS header_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, headers_text TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, type TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS route_display_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, route_ids_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS request_logs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
      CREATE TABLE IF NOT EXISTS route_last_success (route_id TEXT PRIMARY KEY, candidate_key TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    this.ensureSqliteColumn("temporary_account_groups", "provider_type", "TEXT");
    this.ensureSqliteColumn("temporary_account_groups", "preferred_account_id", "TEXT");
    this.ensureSqliteColumn("temporary_accounts", "provider_type", "TEXT");
    this.ensureSqliteColumn("temporary_accounts", "agent_runtime_id", "TEXT");
    this.ensureSqliteColumn("temporary_accounts", "agent_private_key", "TEXT");
    this.ensureSqliteColumn("temporary_accounts", "agent_task_id", "TEXT");
    this.ensureSqliteColumn("temporary_accounts", "chatgpt_user_id", "TEXT");
    this.ensureSqliteColumn("temporary_accounts", "chatgpt_account_is_fedramp", "INTEGER");
    this.ensureSqliteColumn("temporary_accounts", "grok_oauth_format", "TEXT");
    this.ensureSqliteColumn("temporary_accounts", "oauth_client_id", "TEXT");
    this.ensureSqliteColumn("temporary_accounts", "oauth_token_endpoint", "TEXT");
    this.ensureSqliteColumn("temporary_accounts", "upstream_base_url", "TEXT");
    this.ensureSqliteColumn("temporary_accounts", "token_expires_at", "TEXT");
    this.ensureSqliteColumn("temporary_accounts", "grok_using_api", "INTEGER");
    this.ensureSqliteColumn("provider_api_keys", "kind", "TEXT NOT NULL DEFAULT 'api-key'");
    this.ensureSqliteColumn("api_keys", "models_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureSqliteColumn("sites", "enabled", "INTEGER NOT NULL DEFAULT 1");
    this.ensureSqliteColumn("provider_api_key_groups", "model_manage_mode", "TEXT NOT NULL DEFAULT 'manual'");
    this.ensureSqliteColumn("provider_api_key_groups", "last_model_sync_at", "TEXT");
    this.ensureSqliteColumn("provider_api_key_groups", "last_model_sync_status", "TEXT");
    this.ensureSqliteColumn("provider_api_key_groups", "last_model_sync_message", "TEXT");
  }

  private ensureSqliteColumn(table: string, column: string, definition: string) {
    const rows = this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.some((row) => row.name === column)) this.sqlite.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }

  private load(): AppDatabase {
    const initialized = this.sqlite.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (!initialized) {
      const legacy = this.loadLegacyDatabase();
      this.replaceSqliteDatabase(legacy);
      return legacy;
    }
    return this.loadDatabaseFromSqlite();
  }

  private loadLegacyDatabase(): AppDatabase {
    if (!existsSync(this.dbPath)) {
      const empty = createEmptyDatabase();
      this.requestLogStore.importLegacy(this.loadRequestLogs(empty.settings.maxRequestLogs), empty.settings.maxRequestLogs);
      return empty;
    }
    const parsed = JSON.parse(readFileSync(this.dbPath, "utf8")) as Partial<AppDatabase>;
    const settings = normalizeSettings(parsed.settings);
    const legacyRequestLogs = (parsed as Partial<AppDatabase> & { requestLogs?: RequestLogInput[] }).requestLogs || [];
    this.requestLogStore.importLegacy(this.loadRequestLogs(settings.maxRequestLogs, legacyRequestLogs), settings.maxRequestLogs);
    const legacyTemporaryAccountGroups = parsed.temporaryAccountGroups || [];
    return {
      sites: (parsed.sites || []).map((site) => ({ ...site, enabled: site.enabled ?? true, siteType: normalizeSiteType(site.siteType) })),
      apiKeys: (parsed.apiKeys || []).map((key) => ({ ...key, models: normalizeModelList(key.models) })),
      providerApiKeyGroups: (parsed.providerApiKeyGroups || []).map((group) => this.normalizeProviderApiKeyGroup(group)),
      temporaryAccountGroups: this.loadTemporaryAccountGroups(legacyTemporaryAccountGroups),
      headerTemplates: parsed.headerTemplates || [],
      routes: (parsed.routes || []) as RouteRecord[],
      routeDisplayGroups: this.normalizeRouteDisplayGroups(parsed.routeDisplayGroups),
      settings,
      adminPasswordHash: normalizePasswordHash(parsed.adminPasswordHash)
    };
  }

  private loadDatabaseFromSqlite(): AppDatabase {
    const settingsRows = this.sqlite.prepare("SELECT key, value FROM settings").all() as Array<{ key: keyof AppSettings; value: string }>;
    const rawSettings = Object.fromEntries(settingsRows.map((row) => [row.key, JSON.parse(row.value)])) as Partial<AppSettings>;
    const auth = this.sqlite.prepare("SELECT admin_password_hash FROM auth WHERE id = 1").get() as { admin_password_hash?: string } | undefined;
    const sites: Site[] = (this.sqlite.prepare("SELECT * FROM sites ORDER BY created_at DESC").all() as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      siteType: normalizeSiteType(row.site_type),
      enabled: row.enabled == null ? true : Boolean(row.enabled),
      addresses: JSON.parse(String(row.addresses_json)) as SiteAddress[],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }));
    const apiKeys = (this.sqlite.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all() as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      prefix: String(row.prefix),
      keyHash: String(row.key_hash),
      plainTextKey: row.plain_text_key == null ? undefined : String(row.plain_text_key),
      enabled: Boolean(row.enabled),
      models: normalizeModelList(JSON.parse(String(row.models_json || "[]"))),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastUsedAt: row.last_used_at == null ? undefined : String(row.last_used_at)
    }));
    const providerApiKeyGroups = (this.sqlite.prepare("SELECT * FROM provider_api_key_groups ORDER BY created_at DESC").all() as Array<Record<string, unknown>>).map((row) => {
      const apiKeys = (this.sqlite.prepare("SELECT * FROM provider_api_keys WHERE group_id = ? ORDER BY rowid").all(row.id) as Array<Record<string, unknown>>).map((apiKey) => {
        const kind: ProviderApiKeyKind =
          apiKey.kind === "chatgpt-official" || apiKey.kind === "grok-official" || apiKey.kind === "account-pool" ? apiKey.kind : "api-key";
        return {
          id: String(apiKey.id),
          label: String(apiKey.label),
          prefix: String(apiKey.prefix),
          secret: String(apiKey.secret),
          kind,
          enabled: Boolean(apiKey.enabled),
          models: normalizeModelList(JSON.parse(String(apiKey.models_json))),
          lastCheckedAt: apiKey.last_checked_at == null ? undefined : String(apiKey.last_checked_at)
        };
      });
      return this.normalizeProviderApiKeyGroup({
        id: String(row.id),
        siteId: String(row.site_id),
        groupName: String(row.group_name),
        modelManageMode: normalizeProviderModelManageMode(row.model_manage_mode),
        lastModelSyncAt: row.last_model_sync_at == null ? undefined : String(row.last_model_sync_at),
        lastModelSyncStatus: normalizeProviderModelSyncStatus(row.last_model_sync_status),
        lastModelSyncMessage: row.last_model_sync_message == null ? undefined : String(row.last_model_sync_message),
        apiKeys,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at)
      });
    });
    const temporaryAccountGroups = (this.sqlite.prepare("SELECT * FROM temporary_account_groups ORDER BY created_at DESC").all() as Array<Record<string, unknown>>).map((row) => {
      const accounts = (this.sqlite.prepare("SELECT * FROM temporary_accounts WHERE group_id = ? ORDER BY rowid").all(row.id) as Array<Record<string, unknown>>).map((account) => ({
        id: String(account.id),
        label: String(account.label),
        prefix: String(account.prefix),
        secret: String(account.secret),
        accountType: account.account_type == null ? undefined : account.account_type === "api-key" ? "api-key" as const : account.account_type === "openai-api-key" ? "openai-api-key" as const : "codex" as const,
        providerType: normalizeTemporaryAccountProviderType(account.provider_type),
        accountId: account.account_id == null ? undefined : String(account.account_id),
        email: account.email == null ? undefined : String(account.email),
        refreshToken: account.refresh_token == null ? undefined : String(account.refresh_token),
        idToken: account.id_token == null ? undefined : String(account.id_token),
        sessionToken: account.session_token == null ? undefined : String(account.session_token),
        agentRuntimeId: account.agent_runtime_id == null ? undefined : String(account.agent_runtime_id),
        agentPrivateKey: account.agent_private_key == null ? undefined : String(account.agent_private_key),
        agentTaskId: account.agent_task_id == null ? undefined : String(account.agent_task_id),
        chatgptUserId: account.chatgpt_user_id == null ? undefined : String(account.chatgpt_user_id),
        chatgptAccountIsFedramp: account.chatgpt_account_is_fedramp == null ? undefined : Boolean(account.chatgpt_account_is_fedramp),
        grokOAuthFormat: account.grok_oauth_format === "grok2api-oauth" ? "grok2api-oauth" as const : account.grok_oauth_format === "cpa-oauth" ? "cpa-oauth" as const : undefined,
        oauthClientId: account.oauth_client_id == null ? undefined : String(account.oauth_client_id),
        oauthTokenEndpoint: account.oauth_token_endpoint == null ? undefined : String(account.oauth_token_endpoint),
        upstreamBaseUrl: account.upstream_base_url == null ? undefined : String(account.upstream_base_url),
        tokenExpiresAt: account.token_expires_at == null ? undefined : String(account.token_expires_at),
        grokUsingApi: account.grok_using_api == null ? undefined : Boolean(account.grok_using_api),
        enabled: Boolean(account.enabled),
        models: normalizeModelList(JSON.parse(String(account.models_json))),
        availability: normalizeTemporaryAccountAvailability(account.availability),
        quotaStages: JSON.parse(String(account.quota_stages_json)) as TemporaryAccountQuotaStage[],
        importedAt: String(account.imported_at),
        lastQuotaCheckedAt: account.last_quota_checked_at == null ? undefined : String(account.last_quota_checked_at),
        lastCheckStatusCode: typeof account.last_check_status_code === "number" ? account.last_check_status_code : undefined,
        lastCheckError: account.last_check_error == null ? undefined : String(account.last_check_error)
      }));
      const providerType = normalizeTemporaryAccountProviderType(row.provider_type || String(row.name).toLowerCase());
      return {
        id: String(row.id),
        name: TEMPORARY_ACCOUNT_PROVIDER_LABELS[providerType],
        source: row.source === "cpa" ? "cpa" as const : "subapi" as const,
        providerType,
        siteId: String(row.site_id),
        strategy: row.strategy == null ? undefined : normalizeGroupStrategy(row.strategy),
        preferredAccountId: typeof row.preferred_account_id === "string" ? row.preferred_account_id : undefined,
        enabled: row.enabled == null ? true : Boolean(row.enabled),
        accounts: accounts.map((account) => ({ ...account, providerType })),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at)
      };
    });
    const headerTemplates = (this.sqlite.prepare("SELECT * FROM header_templates ORDER BY created_at DESC").all() as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      headersText: String(row.headers_text),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }));
    const routes = (this.sqlite.prepare("SELECT data_json FROM routes ORDER BY created_at DESC").all() as Array<{ data_json: string }>).map((row) => JSON.parse(row.data_json) as RouteRecord);
    const routeDisplayGroups = this.normalizeRouteDisplayGroups(
      (this.sqlite.prepare("SELECT * FROM route_display_groups ORDER BY created_at DESC").all() as Array<Record<string, unknown>>).map((row) => ({
        id: String(row.id),
        name: String(row.name),
        routeIds: JSON.parse(String(row.route_ids_json || "[]")),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at)
      }))
    );
    return { sites, apiKeys, providerApiKeyGroups, temporaryAccountGroups, headerTemplates, routes, routeDisplayGroups, settings: normalizeSettings(rawSettings), adminPasswordHash: normalizePasswordHash(auth?.admin_password_hash) };
  }

  private loadTemporaryAccountGroups(fallback: TemporaryAccountGroup[] = []) {
    const source = existsSync(this.temporaryAccountsPath)
      ? JSON.parse(readFileSync(this.temporaryAccountsPath, "utf8")) as TemporaryAccountGroup[]
      : fallback;
    return source.map((group) => ({
      ...group,
      strategy: normalizeGroupStrategy(group.strategy),
      accounts: (group.accounts || []).map((account) => ({
        ...account,
        accountType: account.accountType || (account.accountId ? "codex" : account.secret?.startsWith("sk-") ? "openai-api-key" : undefined),
        models: normalizeModelList(account.models),
        availability: normalizeTemporaryAccountAvailability(account.availability),
        quotaStages: Array.isArray(account.quotaStages) ? account.quotaStages : []
      }))
    }));
  }

  private loadRequestLogs(limit: number, fallback: RequestLogInput[] = []) {
    if (!existsSync(this.logsPath)) return fallback.slice(0, limit);
    const lines = readFileSync(this.logsPath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const logs: RequestLogInput[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as RequestLogInput;
        if (parsed.id && parsed.createdAt) logs.push(parsed);
      } catch {
        // Ignore malformed log lines so one bad append does not break startup.
      }
    }
    return logs.reverse().slice(0, limit);
  }

  private persist() {
    this.replaceSqliteDatabase(this.db);
  }

  private replaceSqliteDatabase(db: AppDatabase) {
    const replace = this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM route_display_groups").run();
      this.sqlite.prepare("DELETE FROM routes").run();
      this.sqlite.prepare("DELETE FROM header_templates").run();
      this.sqlite.prepare("DELETE FROM temporary_accounts").run();
      this.sqlite.prepare("DELETE FROM temporary_account_groups").run();
      this.sqlite.prepare("DELETE FROM provider_api_keys").run();
      this.sqlite.prepare("DELETE FROM provider_api_key_groups").run();
      this.sqlite.prepare("DELETE FROM api_keys").run();
      this.sqlite.prepare("DELETE FROM sites").run();
      this.sqlite.prepare("DELETE FROM auth").run();
      this.sqlite.prepare("DELETE FROM settings").run();
      this.writeDatabaseRows(db);
      this.sqlite.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')").run();
      this.sqlite.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_from_json_at', ?)").run(now());
    });
    replace();
  }

  private writeDatabaseRows(db: AppDatabase) {
    const insertSetting = this.sqlite.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(db.settings)) insertSetting.run(key, JSON.stringify(value));
    this.sqlite.prepare("INSERT INTO auth (id, admin_password_hash) VALUES (1, ?)").run(db.adminPasswordHash || null);
    const insertSite = this.sqlite.prepare("INSERT INTO sites (id, name, site_type, enabled, addresses_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const site of db.sites) insertSite.run(site.id, site.name, site.siteType, site.enabled === false ? 0 : 1, JSON.stringify(site.addresses), site.createdAt, site.updatedAt);
    const insertApiKey = this.sqlite.prepare("INSERT INTO api_keys (id, name, prefix, key_hash, plain_text_key, enabled, models_json, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const key of db.apiKeys) insertApiKey.run(key.id, key.name, key.prefix, key.keyHash, key.plainTextKey || null, key.enabled ? 1 : 0, JSON.stringify(key.models || []), key.createdAt, key.updatedAt, key.lastUsedAt || null);
    const insertProviderGroup = this.sqlite.prepare(
      "INSERT INTO provider_api_key_groups (id, site_id, group_name, model_manage_mode, last_model_sync_at, last_model_sync_status, last_model_sync_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const insertProviderKey = this.sqlite.prepare("INSERT INTO provider_api_keys (id, group_id, label, prefix, secret, kind, enabled, models_json, last_checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const group of db.providerApiKeyGroups) {
      insertProviderGroup.run(
        group.id,
        group.siteId,
        group.groupName,
        normalizeProviderModelManageMode(group.modelManageMode),
        group.lastModelSyncAt || null,
        group.lastModelSyncStatus || null,
        group.lastModelSyncMessage || null,
        group.createdAt,
        group.updatedAt
      );
      for (const apiKey of group.apiKeys) insertProviderKey.run(apiKey.id, group.id, apiKey.label, apiKey.prefix, apiKey.secret, apiKey.kind || "api-key", apiKey.enabled ? 1 : 0, JSON.stringify(apiKey.models), apiKey.lastCheckedAt || null);
    }
    const insertTemporaryGroup = this.sqlite.prepare("INSERT INTO temporary_account_groups (id, name, source, provider_type, site_id, strategy, preferred_account_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertTemporaryAccount = this.sqlite.prepare("INSERT INTO temporary_accounts (id, group_id, label, prefix, secret, account_type, provider_type, account_id, email, refresh_token, id_token, session_token, agent_runtime_id, agent_private_key, agent_task_id, chatgpt_user_id, chatgpt_account_is_fedramp, grok_oauth_format, oauth_client_id, oauth_token_endpoint, upstream_base_url, token_expires_at, grok_using_api, enabled, models_json, availability, quota_stages_json, imported_at, last_quota_checked_at, last_check_status_code, last_check_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const group of db.temporaryAccountGroups) {
      const providerType = normalizeTemporaryAccountProviderType(group.providerType || group.name.toLowerCase());
      insertTemporaryGroup.run(group.id, TEMPORARY_ACCOUNT_PROVIDER_LABELS[providerType], group.source, providerType, group.siteId, group.strategy || null, group.preferredAccountId || null, group.enabled === false ? 0 : 1, group.createdAt, group.updatedAt);
      for (const account of group.accounts) insertTemporaryAccount.run(account.id, group.id, account.label, account.prefix, account.secret, account.accountType || null, account.providerType || providerType, account.accountId || null, account.email || null, account.refreshToken || null, account.idToken || null, account.sessionToken || null, account.agentRuntimeId || null, account.agentPrivateKey || null, account.agentTaskId || null, account.chatgptUserId || null, account.chatgptAccountIsFedramp == null ? null : account.chatgptAccountIsFedramp ? 1 : 0, account.grokOAuthFormat || null, account.oauthClientId || null, account.oauthTokenEndpoint || null, account.upstreamBaseUrl || null, account.tokenExpiresAt || null, account.grokUsingApi == null ? null : account.grokUsingApi ? 1 : 0, account.enabled === false ? 0 : 1, JSON.stringify(account.models), account.availability || "unknown", JSON.stringify(account.quotaStages || []), account.importedAt, account.lastQuotaCheckedAt || null, account.lastCheckStatusCode ?? null, account.lastCheckError || null);
    }
    const insertHeader = this.sqlite.prepare("INSERT INTO header_templates (id, name, headers_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    for (const template of db.headerTemplates) insertHeader.run(template.id, template.name, template.headersText, template.createdAt, template.updatedAt);
    const insertRoute = this.sqlite.prepare("INSERT INTO routes (id, type, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    for (const route of db.routes) insertRoute.run(route.id, route.type, JSON.stringify(route), route.createdAt, route.updatedAt);
    const insertRouteDisplayGroup = this.sqlite.prepare("INSERT INTO route_display_groups (id, name, route_ids_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    for (const group of db.routeDisplayGroups) insertRouteDisplayGroup.run(group.id, group.name, JSON.stringify(group.routeIds || []), group.createdAt, group.updatedAt);
  }

  private persistTemporaryAccountCheckResult(groupId: string, account: TemporaryAccount) {
    this.sqlite.prepare(`
      UPDATE temporary_accounts
      SET label = ?, prefix = ?, secret = ?, account_type = ?, provider_type = ?, account_id = ?, email = ?, refresh_token = ?, id_token = ?, session_token = ?, agent_runtime_id = ?, agent_private_key = ?, agent_task_id = ?, chatgpt_user_id = ?, chatgpt_account_is_fedramp = ?, grok_oauth_format = ?, oauth_client_id = ?, oauth_token_endpoint = ?, upstream_base_url = ?, token_expires_at = ?, grok_using_api = ?, enabled = ?, models_json = ?, availability = ?, quota_stages_json = ?, imported_at = ?, last_quota_checked_at = ?, last_check_status_code = ?, last_check_error = ?
      WHERE id = ?
    `).run(account.label, account.prefix, account.secret, account.accountType || null, account.providerType || "gpt", account.accountId || null, account.email || null, account.refreshToken || null, account.idToken || null, account.sessionToken || null, account.agentRuntimeId || null, account.agentPrivateKey || null, account.agentTaskId || null, account.chatgptUserId || null, account.chatgptAccountIsFedramp == null ? null : account.chatgptAccountIsFedramp ? 1 : 0, account.grokOAuthFormat || null, account.oauthClientId || null, account.oauthTokenEndpoint || null, account.upstreamBaseUrl || null, account.tokenExpiresAt || null, account.grokUsingApi == null ? null : account.grokUsingApi ? 1 : 0, account.enabled === false ? 0 : 1, JSON.stringify(account.models), account.availability || "unknown", JSON.stringify(account.quotaStages || []), account.importedAt, account.lastQuotaCheckedAt || null, account.lastCheckStatusCode ?? null, account.lastCheckError || null, account.id);
    this.sqlite.prepare("UPDATE temporary_account_groups SET updated_at = ? WHERE id = ?").run(now(), groupId);
  }

  private persistApiKeyLastUsedAt(apiKey: ApiKeyRecord) {
    this.sqlite.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(apiKey.lastUsedAt || null, apiKey.id);
  }

  private persistApiKey(apiKey: ApiKeyRecord) {
    this.sqlite.prepare("UPDATE api_keys SET name = ?, enabled = ?, models_json = ?, updated_at = ?, last_used_at = ? WHERE id = ?")
      .run(apiKey.name, apiKey.enabled ? 1 : 0, JSON.stringify(apiKey.models || []), apiKey.updatedAt, apiKey.lastUsedAt || null, apiKey.id);
  }

  private normalizeProviderApiKeyEntry(input: Partial<ProviderApiKeyEntry>, index: number, existingKeys: ProviderApiKeyEntry[] = []): ProviderApiKeyEntry {
    const existing = input.id ? existingKeys.find((key) => key.id === input.id) : undefined;
    const kind = input.kind === "api-key" || input.kind === "chatgpt-official" || input.kind === "grok-official" || input.kind === "account-pool" ? input.kind : existing?.kind || "api-key";
    const isOfficialKey = kind === "chatgpt-official" || kind === "grok-official" || kind === "account-pool";
    const resolvedSecret = isOfficialKey ? "" : input.secret?.trim() || existing?.secret;
    if (!isOfficialKey && !resolvedSecret) throw new Error(`第 ${index + 1} 个 API Key 不能为空`);
    const secret = resolvedSecret || "";
    const models = Array.isArray(input.models)
      ? Array.from(new Set(input.models.map((model) => String(model).trim()).filter(Boolean))).sort()
      : [];
    return {
      id: input.id || (kind === "chatgpt-official" ? CHATGPT_OFFICIAL_PROVIDER_KEY_ID : kind === "grok-official" ? GROK_OFFICIAL_PROVIDER_KEY_ID : `provider-key-${randomUUID()}`),
      label: input.label?.trim() || (kind === "chatgpt-official" ? CHATGPT_OFFICIAL_PROVIDER_KEY_LABEL : kind === "grok-official" ? GROK_OFFICIAL_PROVIDER_KEY_LABEL : `Key ${index + 1}`),
      prefix: kind === "chatgpt-official" ? "chatgpt" : kind === "grok-official" ? "grok" : kind === "account-pool" ? "account-pool" : secret.slice(0, 10),
      secret,
      kind,
      enabled: input.enabled ?? true,
      models,
      lastCheckedAt: input.lastCheckedAt
    };
  }

  private normalizeRouteDisplayGroups(input: unknown): RouteDisplayGroup[] {
    if (!Array.isArray(input)) return [];
    const timestamp = now();
    const claimed = new Set<string>();
    const groups: RouteDisplayGroup[] = [];
    for (const raw of input) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Partial<RouteDisplayGroup>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      if (!record.id || !name) continue;
      const routeIds: string[] = [];
      for (const value of Array.isArray(record.routeIds) ? record.routeIds : []) {
        const routeId = String(value);
        if (claimed.has(routeId)) continue;
        claimed.add(routeId);
        routeIds.push(routeId);
      }
      groups.push({
        id: String(record.id),
        name,
        routeIds,
        createdAt: record.createdAt || timestamp,
        updatedAt: record.updatedAt || timestamp
      });
    }
    return groups;
  }

  private normalizeProviderApiKeyGroup(group: Partial<ProviderApiKeyGroup> & Pick<ProviderApiKeyGroup, "id" | "siteId" | "groupName" | "apiKeys" | "createdAt" | "updatedAt">): ProviderApiKeyGroup {
    return {
      id: group.id,
      siteId: group.siteId,
      groupName: group.groupName,
      modelManageMode: normalizeProviderModelManageMode(group.modelManageMode),
      lastModelSyncAt: group.lastModelSyncAt,
      lastModelSyncStatus: normalizeProviderModelSyncStatus(group.lastModelSyncStatus),
      lastModelSyncMessage: group.lastModelSyncMessage,
      apiKeys: group.apiKeys || [],
      createdAt: group.createdAt,
      updatedAt: group.updatedAt
    };
  }

  private toProviderApiKeyGroupView(group: ProviderApiKeyGroup) {
    const site = this.db.sites.find((item) => item.id === group.siteId);
    const normalized = this.normalizeProviderApiKeyGroup(group);
    return {
      ...normalized,
      groupName: normalized.groupName || site?.name || "API Key 分组",
      apiKeys: normalized.apiKeys.map((apiKey) => ({ ...apiKey }))
    };
  }

  private syncSiteModelsFromProviderKeys(siteId: string) {
    const site = this.db.sites.find((item) => item.id === siteId);
    if (!site) return;
    const models = Array.from(
      new Set(
        this.db.providerApiKeyGroups
          .filter((group) => group.siteId === siteId)
          .flatMap((group) => group.apiKeys.filter((key) => key.enabled).flatMap((key) => key.models))
          .filter(Boolean)
      )
    ).sort();
    site.addresses = site.addresses.map((address) => ({ ...address, models }));
    site.updatedAt = now();
  }
}

export function parseHeaderTemplate(headersText = "") {
  const headers: Record<string, string> = {};
  for (const rawLine of headersText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
      return process.env[name] || "";
    });
    if (key) headers[key] = value;
  }
  return headers;
}
