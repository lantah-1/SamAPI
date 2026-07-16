import { randomBytes, randomUUID } from "node:crypto";
import DatabaseConstructor, { type Database as SqliteDatabase } from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  ApiKeyCreated,
  ApiKeyRecord,
  AppDatabase,
  AppSettings,
  GroupRoute,
  GroupRouteMember,
  HeaderTemplate,
  ProviderApiKeyEntry,
  ProviderApiKeyGroup,
  ProviderApiKeyGroupInput,
  ProviderApiKeyKind,
  RequestLog,
  RequestLogSummary,
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
  normalizeGroupStrategy,
  normalizeMatchRule,
  normalizeModelList,
  normalizePasswordHash,
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

export class JsonStore {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly logsPath: string;
  readonly temporaryAccountsPath: string;
  readonly sqlitePath: string;
  private readonly sqlite: SqliteDatabase;
  private db: AppDatabase;
  private requestLogs: RequestLog[] = [];
  private temporaryAccountIndex = 0;

  constructor(dataDir = process.env.SAMAPI_DATA_DIR || path.resolve(process.cwd(), "data")) {
    this.dataDir = path.resolve(dataDir);
    this.dbPath = path.join(this.dataDir, "samapi.json");
    this.logsPath = path.join(this.dataDir, "request-logs.jsonl");
    this.temporaryAccountsPath = path.join(this.dataDir, "temporary-accounts.json");
    this.sqlitePath = path.join(this.dataDir, "samapi.sqlite");
    mkdirSync(this.dataDir, { recursive: true });
    this.sqlite = new DatabaseConstructor(this.sqlitePath);
    this.initializeSqlite();
    this.db = this.load();
    this.ensureOfficialChatGptProviderKeyGroup();
    this.ensureOfficialGrokSite();
    this.ensureOfficialGrokProviderKeyGroup();
    const mergedTemporaryAccounts = this.mergeTemporaryAccountTypeGroups();
    const migratedGrokModels = this.migrateOfficialGrokAddressModelsToProviderKey();
    const removedUnsupportedGrokAccounts = this.removeUnsupportedGrokAccounts();
    this.refreshGroupRouteMembers();
    if (mergedTemporaryAccounts || migratedGrokModels || removedUnsupportedGrokAccounts) this.persist();
  }

  getDb() {
    return this.db;
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
        group.providerType = providerType;
        group.name = TEMPORARY_ACCOUNT_PROVIDER_LABELS[providerType];
        group.enabled = true;
        group.accounts = group.accounts.map((account) => ({ ...account, providerType, enabled: true }));
        merged.set(providerType, group);
        continue;
      }
      const existingIds = new Set(existing.accounts.map((account) => account.id));
      const existingSecrets = new Set(existing.accounts.map((account) => hashSecret(account.secret.trim() || account.refreshToken?.trim() || account.id)));
      const incoming = group.accounts
        .filter((account) => !existingIds.has(account.id) && !existingSecrets.has(hashSecret(account.secret.trim() || account.refreshToken?.trim() || account.id)))
        .map((account) => ({ ...account, providerType, enabled: true }));
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

  private requestLogSummary(log: RequestLog): RequestLogSummary {
    const route = this.db.routes.find((item) => item.id === log.routeId || item.name === log.routeName);
    const headerTemplateId = route && (route.type === "switch" || route.type === "group") ? route.headerTemplateId : undefined;
    const headerTemplate = headerTemplateId ? this.db.headerTemplates.find((item) => item.id === headerTemplateId) : undefined;
    return {
      id: log.id,
      createdAt: log.createdAt,
      status: log.status,
      statusCode: log.statusCode,
      durationMs: log.durationMs,
      downstream: log.downstream || {
        model: log.routeName,
        endpoint: log.path,
        userAgent: log.userAgent,
        path: log.path,
        method: log.method
      },
      routeName: log.routeName,
      routeId: log.routeId,
      routeTarget: log.routeTarget || {
        routeName: log.routeName,
        model: log.model,
        endpoint: log.endpoint,
        providerName: log.providerName
      },
      providerName: log.providerName,
      providerId: log.providerId,
      model: log.model,
      headerTemplateId,
      headerTemplateName: headerTemplate?.name,
      upstreamUrl: log.upstreamUrl,
      errorMessage: log.errorMessage,
      proxy: log.proxy,
      summary: log.summary
    };
  }

  listRequestLogs(limit = this.db.settings.maxRequestLogs, offset = 0) {
    return this.requestLogs.slice(offset, offset + limit).map((log) => this.requestLogSummary(log));
  }

  listNewRequestLogs(since: string, limit = this.db.settings.maxRequestLogs) {
    return this.requestLogs.filter((log) => log.createdAt > since).slice(0, limit).map((log) => this.requestLogSummary(log));
  }

  getRequestLog(id: string) {
    return this.requestLogs.find((log) => log.id === id);
  }

  updateRequestLog(id: string, patch: Partial<Omit<RequestLog, "id" | "createdAt">>) {
    const index = this.requestLogs.findIndex((log) => log.id === id);
    if (index < 0) return undefined;
    const updated = {
      ...this.requestLogs[index],
      ...patch
    };
    this.requestLogs[index] = updated;
    this.insertRequestLogRow(updated);
    return updated;
  }

  requestLogCount() {
    return this.requestLogs.length;
  }

  recordRequestLog(input: Omit<RequestLog, "id" | "createdAt">) {
    const created: RequestLog = {
      id: `log-${randomUUID()}`,
      createdAt: now(),
      ...input
    };
    this.requestLogs.unshift(created);
    this.insertRequestLogRow(created);
    if (this.requestLogs.length > this.db.settings.maxRequestLogs) {
      this.requestLogs = this.requestLogs.slice(0, this.db.settings.maxRequestLogs);
      this.rewriteRequestLogFile();
    }
    return created;
  }

  updateSettings(input: Partial<AppSettings>) {
    this.db.settings = normalizeSettings({ ...this.db.settings, ...input });
    this.requestLogs = this.requestLogs.slice(0, this.db.settings.maxRequestLogs);
    this.rewriteRequestLogFile();
    this.persist();
    return this.db.settings;
  }

  getAdminPasswordHash() {
    return this.db.adminPasswordHash;
  }

  updateAdminPasswordHash(password: string) {
    const normalized = password.trim();
    if (normalized.length < 8) throw new Error("新管理密码至少需要 8 个字符");
    this.db.adminPasswordHash = hashSecret(normalized);
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
      apiKeys: [this.normalizeProviderApiKeyEntry({ kind: "chatgpt-official", label: CHATGPT_OFFICIAL_PROVIDER_KEY_LABEL, enabled: true }, 0)],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.providerApiKeyGroups.unshift(group);
    this.syncSiteModelsFromProviderKeys(site.id);
    this.persist();
    return this.toProviderApiKeyGroupView(group);
  }

  importTemporaryAccounts(input: TemporaryAccountImportInput) {
    const timestamp = now();
    const source = input.mode === "cpa" || input.source === "cpa" ? "cpa" : "subapi";
    const providerType = normalizeTemporaryAccountProviderType(input.providerType);
    const site = providerType === "grok" ? this.ensureOfficialGrokSite() : this.ensureOfficialOpenAiSite();
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
      throw new Error(providerType === "grok"
        ? `没有解析到可用的 Grok OAuth 账号；仅支持单账号 CPA / grok2api OAuth JSON，暂不支持 SSO JSON 和 accounts 列表${names}`
        : `没有解析到可用账号密钥${names}`);
    }
    const seen = new Set<string>(
      this.db.temporaryAccountGroups.flatMap((group) =>
        group.accounts.map((account) => hashSecret(account.secret.trim() || account.refreshToken?.trim() || account.id))
      )
    );
    const group = this.ensureTemporaryAccountTypeGroup(providerType, site.id, source, timestamp);
    const accounts: TemporaryAccount[] = [];
    let skipped = 0;
    for (const account of parsedAccounts) {
      const secret = account.secret.trim();
      const credentialIdentity = secret || account.refreshToken?.trim() || "";
      if (!credentialIdentity) continue;
      const hash = hashSecret(credentialIdentity);
      if (seen.has(hash)) {
        skipped += 1;
        continue;
      }
      seen.add(hash);
      accounts.push({
        id: `temp-account-${randomUUID()}`,
        label: account.label || `账号 ${group.accounts.length + accounts.length + 1}`,
        prefix: secret ? secret.slice(0, 12) : "oauth-refresh",
        secret,
        accountType: providerType === "gpt" ? account.accountType : undefined,
        providerType,
        accountId: account.accountId,
        email: account.email,
        refreshToken: account.refreshToken,
        idToken: account.idToken,
        sessionToken: account.sessionToken,
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

  private orderedTemporaryAccountPool(pool: TemporaryAccount[]) {
    if (pool.length === 0) return pool;
    const strategy = this.db.settings.temporaryAccountStrategy;
    if (strategy === "random") {
      const shuffled = [...pool];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
      }
      return shuffled;
    }
    if (strategy === "sequential") {
      const start = this.temporaryAccountIndex % pool.length;
      this.temporaryAccountIndex = (this.temporaryAccountIndex + 1) % pool.length;
      return [...pool.slice(start), ...pool.slice(0, start)];
    }
    return pool;
  }

  resolveTemporaryProviderAccounts(providerType: TemporaryAccountProviderType, model: string) {
    const allEnabledAccounts = this.db.temporaryAccountGroups
      .filter((group) => normalizeTemporaryAccountProviderType(group.providerType) === providerType)
      .flatMap((group) => group.accounts);
    const candidates = allEnabledAccounts.filter((account) => account.models.length === 0 || account.models.includes(model));
    const pool = candidates.length > 0 ? candidates : allEnabledAccounts;
    const usable = pool.filter(temporaryAccountCanBeUsed);
    if (usable.length === 0) return [];
    const available = usable.filter((account) => account.availability === "available");
    const unchecked = usable.filter((account) => account.availability !== "available");
    return [...this.orderedTemporaryAccountPool(available), ...this.orderedTemporaryAccountPool(unchecked)];
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
      group.updatedAt = now();
      this.db.temporaryAccountGroups = this.db.temporaryAccountGroups.filter((item) => item.accounts.length > 0);
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
      group.updatedAt = now();
      changed = true;
    }
    if (!changed) return;
    this.db.temporaryAccountGroups = this.db.temporaryAccountGroups.filter((item) => item.accounts.length > 0);
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
    }
  ) {
    for (const group of this.db.temporaryAccountGroups) {
      const account = group.accounts.find((item) => item.id === accountId);
      if (!account) continue;
      if (input.availability) account.availability = input.availability;
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
      if (typeof input.tokenExpiresAt === "string" && input.tokenExpiresAt.trim()) account.tokenExpiresAt = input.tokenExpiresAt.trim();
      group.updatedAt = now();
      this.persistTemporaryAccountCheckResult(group.id, account);
      return account;
    }
    return undefined;
  }

  deleteRequestLog(id: string) {
    this.requestLogs = this.requestLogs.filter((log) => log.id !== id);
    this.rewriteRequestLogFile();
  }

  clearRequestLogs() {
    this.requestLogs = [];
    this.rewriteRequestLogFile();
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
      proxy: normalizeRouteProxy(input.proxy),
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

    const routeShape = {
      name: input.name.trim(),
      type: "group" as const,
      strategy,
      modelGroupId: input.modelGroupId?.trim() || undefined,
      matchRule,
      members,
      endpoint: input.endpoint || "messages",
      headerTemplateId: input.headerTemplateId || undefined,
      proxy: normalizeRouteProxy(input.proxy),
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
    this.persist();
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
      models
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
      CREATE TABLE IF NOT EXISTS provider_api_key_groups (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, group_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_api_keys (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, label TEXT NOT NULL, prefix TEXT NOT NULL, secret TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'api-key', enabled INTEGER NOT NULL, models_json TEXT NOT NULL, last_checked_at TEXT, FOREIGN KEY (group_id) REFERENCES provider_api_key_groups(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS idx_provider_api_keys_group_id ON provider_api_keys(group_id);
      CREATE TABLE IF NOT EXISTS temporary_account_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, provider_type TEXT, site_id TEXT NOT NULL, strategy TEXT, enabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS temporary_accounts (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, label TEXT NOT NULL, prefix TEXT NOT NULL, secret TEXT NOT NULL, account_type TEXT, provider_type TEXT, account_id TEXT, email TEXT, refresh_token TEXT, id_token TEXT, session_token TEXT, grok_oauth_format TEXT, oauth_client_id TEXT, oauth_token_endpoint TEXT, upstream_base_url TEXT, token_expires_at TEXT, grok_using_api INTEGER, enabled INTEGER NOT NULL, models_json TEXT NOT NULL, availability TEXT, quota_stages_json TEXT NOT NULL, imported_at TEXT NOT NULL, last_quota_checked_at TEXT, last_check_status_code INTEGER, last_check_error TEXT, FOREIGN KEY (group_id) REFERENCES temporary_account_groups(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS idx_temporary_accounts_group_id ON temporary_accounts(group_id);
      CREATE INDEX IF NOT EXISTS idx_temporary_accounts_enabled ON temporary_accounts(enabled);
      CREATE INDEX IF NOT EXISTS idx_temporary_accounts_availability ON temporary_accounts(availability);
      CREATE TABLE IF NOT EXISTS header_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, headers_text TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, type TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS request_logs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
    `);
    this.ensureSqliteColumn("temporary_account_groups", "provider_type", "TEXT");
    this.ensureSqliteColumn("temporary_accounts", "provider_type", "TEXT");
    this.ensureSqliteColumn("temporary_accounts", "grok_oauth_format", "TEXT");
    this.ensureSqliteColumn("temporary_accounts", "oauth_client_id", "TEXT");
    this.ensureSqliteColumn("temporary_accounts", "oauth_token_endpoint", "TEXT");
    this.ensureSqliteColumn("temporary_accounts", "upstream_base_url", "TEXT");
    this.ensureSqliteColumn("temporary_accounts", "token_expires_at", "TEXT");
    this.ensureSqliteColumn("temporary_accounts", "grok_using_api", "INTEGER");
    this.ensureSqliteColumn("provider_api_keys", "kind", "TEXT NOT NULL DEFAULT 'api-key'");
    this.ensureSqliteColumn("api_keys", "models_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureSqliteColumn("sites", "enabled", "INTEGER NOT NULL DEFAULT 1");
  }

  private ensureSqliteColumn(table: string, column: string, definition: string) {
    const rows = this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.some((row) => row.name === column)) this.sqlite.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }

  private load(): AppDatabase {
    const initialized = this.sqlite.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (!initialized) {
      const legacy = this.loadLegacyDatabase();
      this.replaceSqliteDatabase(legacy, this.requestLogs);
      return legacy;
    }
    const db = this.loadDatabaseFromSqlite();
    this.requestLogs = this.loadRequestLogsFromSqlite(db.settings.maxRequestLogs);
    return db;
  }

  private loadLegacyDatabase(): AppDatabase {
    if (!existsSync(this.dbPath)) {
      const empty = createEmptyDatabase();
      this.requestLogs = this.loadRequestLogs(empty.settings.maxRequestLogs);
      return empty;
    }
    const parsed = JSON.parse(readFileSync(this.dbPath, "utf8")) as Partial<AppDatabase>;
    const settings = normalizeSettings(parsed.settings);
    const legacyRequestLogs = (parsed as Partial<AppDatabase> & { requestLogs?: RequestLog[] }).requestLogs || [];
    this.requestLogs = this.loadRequestLogs(settings.maxRequestLogs, legacyRequestLogs);
    const legacyTemporaryAccountGroups = parsed.temporaryAccountGroups || [];
    return {
      sites: (parsed.sites || []).map((site) => ({ ...site, enabled: site.enabled ?? true, siteType: normalizeSiteType(site.siteType) })),
      apiKeys: (parsed.apiKeys || []).map((key) => ({ ...key, models: normalizeModelList(key.models) })),
      providerApiKeyGroups: parsed.providerApiKeyGroups || [],
      temporaryAccountGroups: this.loadTemporaryAccountGroups(legacyTemporaryAccountGroups),
      headerTemplates: parsed.headerTemplates || [],
      routes: (parsed.routes || []) as RouteRecord[],
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
          apiKey.kind === "chatgpt-official" || apiKey.kind === "grok-official" ? apiKey.kind : "api-key";
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
      return { id: String(row.id), siteId: String(row.site_id), groupName: String(row.group_name), apiKeys, createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
    });
    const temporaryAccountGroups = (this.sqlite.prepare("SELECT * FROM temporary_account_groups ORDER BY created_at DESC").all() as Array<Record<string, unknown>>).map((row) => {
      const accounts = (this.sqlite.prepare("SELECT * FROM temporary_accounts WHERE group_id = ? ORDER BY rowid").all(row.id) as Array<Record<string, unknown>>).map((account) => ({
        id: String(account.id),
        label: String(account.label),
        prefix: String(account.prefix),
        secret: String(account.secret),
        accountType: account.account_type == null ? undefined : account.account_type === "openai-api-key" ? "openai-api-key" as const : "codex" as const,
        providerType: normalizeTemporaryAccountProviderType(account.provider_type),
        accountId: account.account_id == null ? undefined : String(account.account_id),
        email: account.email == null ? undefined : String(account.email),
        refreshToken: account.refresh_token == null ? undefined : String(account.refresh_token),
        idToken: account.id_token == null ? undefined : String(account.id_token),
        sessionToken: account.session_token == null ? undefined : String(account.session_token),
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
      return { id: String(row.id), name: TEMPORARY_ACCOUNT_PROVIDER_LABELS[providerType], source: row.source === "cpa" ? "cpa" as const : "subapi" as const, providerType, siteId: String(row.site_id), strategy: normalizeGroupStrategy(row.strategy), enabled: true, accounts: accounts.map((account) => ({ ...account, providerType, enabled: true })), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
    });
    const headerTemplates = (this.sqlite.prepare("SELECT * FROM header_templates ORDER BY created_at DESC").all() as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      headersText: String(row.headers_text),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }));
    const routes = (this.sqlite.prepare("SELECT data_json FROM routes ORDER BY created_at DESC").all() as Array<{ data_json: string }>).map((row) => JSON.parse(row.data_json) as RouteRecord);
    return { sites, apiKeys, providerApiKeyGroups, temporaryAccountGroups, headerTemplates, routes, settings: normalizeSettings(rawSettings), adminPasswordHash: normalizePasswordHash(auth?.admin_password_hash) };
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

  private loadRequestLogs(limit: number, fallback: RequestLog[] = []) {
    if (!existsSync(this.logsPath)) return fallback.slice(0, limit);
    const lines = readFileSync(this.logsPath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const logs: RequestLog[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as RequestLog;
        if (parsed.id && parsed.createdAt) logs.push(parsed);
      } catch {
        // Ignore malformed log lines so one bad append does not break startup.
      }
    }
    return logs.reverse().slice(0, limit);
  }

  private loadRequestLogsFromSqlite(limit: number) {
    return (this.sqlite.prepare("SELECT data_json FROM request_logs ORDER BY created_at DESC LIMIT ?").all(limit) as Array<{ data_json: string }>).map((row) => JSON.parse(row.data_json) as RequestLog);
  }

  private rewriteRequestLogFile() {
    this.replaceRequestLogs(this.requestLogs);
  }

  private persist() {
    this.replaceSqliteDatabase(this.db, this.requestLogs);
  }

  private replaceSqliteDatabase(db: AppDatabase, requestLogs = this.requestLogs) {
    const replace = this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM request_logs").run();
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
      this.writeDatabaseRows(db, requestLogs);
      this.sqlite.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')").run();
      this.sqlite.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_from_json_at', ?)").run(now());
    });
    replace();
  }

  private writeDatabaseRows(db: AppDatabase, requestLogs: RequestLog[]) {
    const insertSetting = this.sqlite.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(db.settings)) insertSetting.run(key, JSON.stringify(value));
    this.sqlite.prepare("INSERT INTO auth (id, admin_password_hash) VALUES (1, ?)").run(db.adminPasswordHash || null);
    const insertSite = this.sqlite.prepare("INSERT INTO sites (id, name, site_type, enabled, addresses_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const site of db.sites) insertSite.run(site.id, site.name, site.siteType, site.enabled === false ? 0 : 1, JSON.stringify(site.addresses), site.createdAt, site.updatedAt);
    const insertApiKey = this.sqlite.prepare("INSERT INTO api_keys (id, name, prefix, key_hash, plain_text_key, enabled, models_json, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const key of db.apiKeys) insertApiKey.run(key.id, key.name, key.prefix, key.keyHash, key.plainTextKey || null, key.enabled ? 1 : 0, JSON.stringify(key.models || []), key.createdAt, key.updatedAt, key.lastUsedAt || null);
    const insertProviderGroup = this.sqlite.prepare("INSERT INTO provider_api_key_groups (id, site_id, group_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    const insertProviderKey = this.sqlite.prepare("INSERT INTO provider_api_keys (id, group_id, label, prefix, secret, kind, enabled, models_json, last_checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const group of db.providerApiKeyGroups) {
      insertProviderGroup.run(group.id, group.siteId, group.groupName, group.createdAt, group.updatedAt);
      for (const apiKey of group.apiKeys) insertProviderKey.run(apiKey.id, group.id, apiKey.label, apiKey.prefix, apiKey.secret, apiKey.kind || "api-key", apiKey.enabled ? 1 : 0, JSON.stringify(apiKey.models), apiKey.lastCheckedAt || null);
    }
    const insertTemporaryGroup = this.sqlite.prepare("INSERT INTO temporary_account_groups (id, name, source, provider_type, site_id, strategy, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertTemporaryAccount = this.sqlite.prepare("INSERT INTO temporary_accounts (id, group_id, label, prefix, secret, account_type, provider_type, account_id, email, refresh_token, id_token, session_token, grok_oauth_format, oauth_client_id, oauth_token_endpoint, upstream_base_url, token_expires_at, grok_using_api, enabled, models_json, availability, quota_stages_json, imported_at, last_quota_checked_at, last_check_status_code, last_check_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const group of db.temporaryAccountGroups) {
      const providerType = normalizeTemporaryAccountProviderType(group.providerType || group.name.toLowerCase());
      insertTemporaryGroup.run(group.id, TEMPORARY_ACCOUNT_PROVIDER_LABELS[providerType], group.source, providerType, group.siteId, group.strategy || null, 1, group.createdAt, group.updatedAt);
      for (const account of group.accounts) insertTemporaryAccount.run(account.id, group.id, account.label, account.prefix, account.secret, account.accountType || null, account.providerType || providerType, account.accountId || null, account.email || null, account.refreshToken || null, account.idToken || null, account.sessionToken || null, account.grokOAuthFormat || null, account.oauthClientId || null, account.oauthTokenEndpoint || null, account.upstreamBaseUrl || null, account.tokenExpiresAt || null, account.grokUsingApi == null ? null : account.grokUsingApi ? 1 : 0, 1, JSON.stringify(account.models), account.availability || "unknown", JSON.stringify(account.quotaStages || []), account.importedAt, account.lastQuotaCheckedAt || null, account.lastCheckStatusCode ?? null, account.lastCheckError || null);
    }
    const insertHeader = this.sqlite.prepare("INSERT INTO header_templates (id, name, headers_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    for (const template of db.headerTemplates) insertHeader.run(template.id, template.name, template.headersText, template.createdAt, template.updatedAt);
    const insertRoute = this.sqlite.prepare("INSERT INTO routes (id, type, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    for (const route of db.routes) insertRoute.run(route.id, route.type, JSON.stringify(route), route.createdAt, route.updatedAt);
    const insertLog = this.sqlite.prepare("INSERT INTO request_logs (id, created_at, data_json) VALUES (?, ?, ?)");
    for (const log of requestLogs.slice().reverse()) insertLog.run(log.id, log.createdAt, JSON.stringify(log));
  }

  private insertRequestLogRow(log: RequestLog) {
    this.sqlite.prepare("INSERT OR REPLACE INTO request_logs (id, created_at, data_json) VALUES (?, ?, ?)").run(log.id, log.createdAt, JSON.stringify(log));
  }

  private replaceRequestLogs(logs: RequestLog[]) {
    const replace = this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM request_logs").run();
      const insertLog = this.sqlite.prepare("INSERT INTO request_logs (id, created_at, data_json) VALUES (?, ?, ?)");
      for (const log of logs.slice().reverse()) insertLog.run(log.id, log.createdAt, JSON.stringify(log));
    });
    replace();
  }

  private persistTemporaryAccountCheckResult(groupId: string, account: TemporaryAccount) {
    this.sqlite.prepare(`
      UPDATE temporary_accounts
      SET label = ?, prefix = ?, secret = ?, account_type = ?, provider_type = ?, account_id = ?, email = ?, refresh_token = ?, id_token = ?, session_token = ?, grok_oauth_format = ?, oauth_client_id = ?, oauth_token_endpoint = ?, upstream_base_url = ?, token_expires_at = ?, grok_using_api = ?, enabled = ?, models_json = ?, availability = ?, quota_stages_json = ?, imported_at = ?, last_quota_checked_at = ?, last_check_status_code = ?, last_check_error = ?
      WHERE id = ?
    `).run(account.label, account.prefix, account.secret, account.accountType || null, account.providerType || "gpt", account.accountId || null, account.email || null, account.refreshToken || null, account.idToken || null, account.sessionToken || null, account.grokOAuthFormat || null, account.oauthClientId || null, account.oauthTokenEndpoint || null, account.upstreamBaseUrl || null, account.tokenExpiresAt || null, account.grokUsingApi == null ? null : account.grokUsingApi ? 1 : 0, 1, JSON.stringify(account.models), account.availability || "unknown", JSON.stringify(account.quotaStages || []), account.importedAt, account.lastQuotaCheckedAt || null, account.lastCheckStatusCode ?? null, account.lastCheckError || null, account.id);
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
    const kind = input.kind === "chatgpt-official" || input.kind === "grok-official" ? input.kind : existing?.kind || "api-key";
    const isOfficialKey = kind === "chatgpt-official" || kind === "grok-official";
    const resolvedSecret = isOfficialKey ? "" : input.secret?.trim() || existing?.secret;
    if (!isOfficialKey && !resolvedSecret) throw new Error(`第 ${index + 1} 个 API Key 不能为空`);
    const secret = resolvedSecret || "";
    const models = Array.isArray(input.models)
      ? Array.from(new Set(input.models.map((model) => String(model).trim()).filter(Boolean))).sort()
      : [];
    return {
      id: input.id || (kind === "chatgpt-official" ? CHATGPT_OFFICIAL_PROVIDER_KEY_ID : kind === "grok-official" ? GROK_OFFICIAL_PROVIDER_KEY_ID : `provider-key-${randomUUID()}`),
      label: input.label?.trim() || (kind === "chatgpt-official" ? CHATGPT_OFFICIAL_PROVIDER_KEY_LABEL : kind === "grok-official" ? GROK_OFFICIAL_PROVIDER_KEY_LABEL : `Key ${index + 1}`),
      prefix: kind === "chatgpt-official" ? "chatgpt" : kind === "grok-official" ? "grok" : secret.slice(0, 10),
      secret,
      kind,
      enabled: input.enabled ?? true,
      models,
      lastCheckedAt: input.lastCheckedAt
    };
  }

  private toProviderApiKeyGroupView(group: ProviderApiKeyGroup) {
    const site = this.db.sites.find((item) => item.id === group.siteId);
    return {
      ...group,
      groupName: group.groupName || site?.name || "API Key 分组",
      apiKeys: group.apiKeys.map((apiKey) => ({ ...apiKey }))
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
