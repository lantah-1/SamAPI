import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  ApiKeyCreated,
  ApiKeyRecord,
  AppDatabase,
  AppSettings,
  HeaderTemplate,
  ProviderApiKeyEntry,
  ProviderApiKeyGroup,
  ProviderApiKeyGroupInput,
  RequestLog,
  RouteRecord,
  Site,
  SiteAddress,
  SwitchRoute
} from "../shared/types.js";

const ENDPOINTS = ["messages", "chat/completions", "responses"] as const;
const DEFAULT_SETTINGS: AppSettings = {
  maxRequestLogs: 100
};

function now() {
  return new Date().toISOString();
}

function hashSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("地址 URL 必须是合法的网址，例如 https://api.example.com/v1");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("地址 URL 仅支持 http:// 或 https:// 开头的合法网址");
  }
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeSiteType(value: unknown) {
  return value === "newapi" ? "newapi" : "unknown";
}

function normalizeSettings(input?: Partial<AppSettings>): AppSettings {
  const maxRequestLogs = Number(input?.maxRequestLogs ?? DEFAULT_SETTINGS.maxRequestLogs);
  return {
    maxRequestLogs: Number.isFinite(maxRequestLogs) ? Math.min(5000, Math.max(1, Math.floor(maxRequestLogs))) : DEFAULT_SETTINGS.maxRequestLogs
  };
}

function createEmptyDatabase(): AppDatabase {
  return {
    sites: [],
    apiKeys: [],
    providerApiKeyGroups: [],
    headerTemplates: [],
    routes: [],
    settings: { ...DEFAULT_SETTINGS }
  };
}

export class JsonStore {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly logsPath: string;
  private db: AppDatabase;
  private requestLogs: RequestLog[] = [];

  constructor(dataDir = process.env.SAMAPI_DATA_DIR || path.resolve(process.cwd(), "data")) {
    this.dataDir = path.resolve(dataDir);
    this.dbPath = path.join(this.dataDir, "samapi.json");
    this.logsPath = path.join(this.dataDir, "request-logs.jsonl");
    mkdirSync(this.dataDir, { recursive: true });
    this.db = this.load();
  }

  snapshot() {
    return {
      ...this.db,
      providerApiKeyGroups: this.db.providerApiKeyGroups.map((group) => this.toProviderApiKeyGroupView(group)),
      requestLogs: this.listRequestLogs(),
      dbPath: this.dbPath,
      dataDir: this.dataDir,
      endpoints: [...ENDPOINTS]
    };
  }

  getDb() {
    return this.db;
  }

  listRequestLogs(limit = this.db.settings.maxRequestLogs) {
    return this.requestLogs.slice(0, limit);
  }

  recordRequestLog(input: Omit<RequestLog, "id" | "createdAt">) {
    const created: RequestLog = {
      id: `log-${randomUUID()}`,
      createdAt: now(),
      ...input
    };
    this.requestLogs.unshift(created);
    appendFileSync(this.logsPath, `${JSON.stringify(created)}\n`);
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
    const addresses = (input.addresses || []).map((address) => this.normalizeAddress(address));
    if (!input.name?.trim()) {
      throw new Error("站点名称不能为空");
    }
    if (addresses.length === 0) {
      throw new Error("至少需要一个地址");
    }

    if (input.id) {
      const current = this.db.sites.find((site) => site.id === input.id);
      if (!current) throw new Error("站点不存在");
      Object.assign(current, {
        name: input.name.trim(),
        siteType: normalizeSiteType(input.siteType),
        addresses,
        updatedAt: timestamp
      });
      this.db.providerApiKeyGroups = this.db.providerApiKeyGroups.map((group) =>
        group.siteId === current.id ? { ...group, groupName: current.name, updatedAt: timestamp } : group
      );
      this.persist();
      return current;
    }

    const created: Site = {
      id: `site-${randomUUID()}`,
      name: input.name.trim(),
      siteType: normalizeSiteType(input.siteType),
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
    this.db.routes = this.db.routes.filter((route) => route.type !== "switch" || route.siteId !== id);
    this.persist();
  }

  createApiKey(name: string): ApiKeyCreated {
    if (!name.trim()) throw new Error("密钥名称不能为空");
    const timestamp = now();
    const plainTextKey = `sk-samapi-${randomBytes(24).toString("base64url")}`;
    const created: ApiKeyCreated = {
      id: `key-${randomUUID()}`,
      name: name.trim(),
      prefix: plainTextKey.slice(0, 18),
      keyHash: hashSecret(plainTextKey),
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      plainTextKey
    };
    const { plainTextKey: _plainTextKey, ...record } = created;
    this.db.apiKeys.unshift(record);
    this.persist();
    return created;
  }

  updateApiKey(id: string, input: Partial<ApiKeyRecord>) {
    const current = this.db.apiKeys.find((key) => key.id === id);
    if (!current) throw new Error("密钥不存在");
    if (typeof input.name === "string") current.name = input.name.trim();
    if (typeof input.enabled === "boolean") current.enabled = input.enabled;
    current.updatedAt = now();
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
    const groupName = site.name;

    if (input.id) {
      const current = this.db.providerApiKeyGroups.find((group) => group.id === input.id);
      if (!current) throw new Error("API Key 分组不存在");
      const previousSiteId = current.siteId;
      const apiKeys = (input.apiKeys || []).map((key, index) => this.normalizeProviderApiKeyEntry(key, index, current.apiKeys));
      if (apiKeys.length === 0) throw new Error("至少需要一个 API Key");
      Object.assign(current, {
        siteId: input.siteId,
        groupName,
        apiKeys,
        updatedAt: timestamp
      });
      if (previousSiteId !== input.siteId) this.syncSiteModelsFromProviderKeys(previousSiteId);
      this.syncSiteModelsFromProviderKeys(input.siteId);
      this.persist();
      return this.toProviderApiKeyGroupView(current);
    }

    const apiKeys = (input.apiKeys || []).map((key, index) => this.normalizeProviderApiKeyEntry(key, index));
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
    this.persist();
    return this.toProviderApiKeyGroupView(created);
  }

  deleteProviderApiKeyGroup(id: string) {
    const current = this.db.providerApiKeyGroups.find((group) => group.id === id);
    this.db.providerApiKeyGroups = this.db.providerApiKeyGroups.filter((group) => group.id !== id);
    if (current) this.syncSiteModelsFromProviderKeys(current.siteId);
    this.persist();
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
    this.persist();
    return true;
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
      if (route.type === "switch" && route.headerTemplateId === id) {
        return { ...route, headerTemplateId: undefined, updatedAt: now() };
      }
      return route;
    });
    this.persist();
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
      enabled: input.enabled ?? true,
      updatedAt: timestamp
    };

    if (input.id) {
      const current = this.db.routes.find((route): route is SwitchRoute => route.id === input.id && route.type === "switch");
      if (!current) throw new Error("路由不存在");
      Object.assign(current, routeShape);
      this.persist();
      return current;
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
    const addresses = site?.addresses.filter((address) => address.enabled) || [];
    if (!site || addresses.length === 0) throw new Error("路由绑定的供应商地址不可用");
    const headerTemplate = route.headerTemplateId
      ? this.db.headerTemplates.find((item) => item.id === route.headerTemplateId)
      : undefined;
    return { route, site, addresses, headerTemplate };
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

  private load(): AppDatabase {
    if (!existsSync(this.dbPath)) {
      const empty = createEmptyDatabase();
      writeFileSync(this.dbPath, JSON.stringify(empty, null, 2));
      return empty;
    }
    const parsed = JSON.parse(readFileSync(this.dbPath, "utf8")) as Partial<AppDatabase>;
    const settings = normalizeSettings(parsed.settings);
    const legacyRequestLogs = (parsed as Partial<AppDatabase> & { requestLogs?: RequestLog[] }).requestLogs || [];
    this.requestLogs = this.loadRequestLogs(settings.maxRequestLogs, legacyRequestLogs);
    if (!existsSync(this.logsPath) && legacyRequestLogs.length > 0) {
      this.rewriteRequestLogFile();
    }
    return {
      sites: (parsed.sites || []).map((site) => ({ ...site, siteType: normalizeSiteType(site.siteType) })),
      apiKeys: parsed.apiKeys || [],
      providerApiKeyGroups: parsed.providerApiKeyGroups || [],
      headerTemplates: parsed.headerTemplates || [],
      routes: (parsed.routes || []) as RouteRecord[],
      settings
    };
  }

  private loadRequestLogs(limit: number, fallback: RequestLog[] = []) {
    if (!existsSync(this.logsPath)) return fallback.slice(0, limit);
    const lines = readFileSync(this.logsPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
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

  private rewriteRequestLogFile() {
    const content = this.requestLogs
      .slice()
      .reverse()
      .map((log) => JSON.stringify(log))
      .join("\n");
    writeFileSync(this.logsPath, content ? `${content}\n` : "");
  }

  private persist() {
    const tempPath = `${this.dbPath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(this.db, null, 2));
    renameSync(tempPath, this.dbPath);
  }

  private normalizeProviderApiKeyEntry(input: Partial<ProviderApiKeyEntry>, index: number, existingKeys: ProviderApiKeyEntry[] = []): ProviderApiKeyEntry {
    const existing = input.id ? existingKeys.find((key) => key.id === input.id) : undefined;
    const secret = input.secret?.trim() || existing?.secret;
    if (!secret) throw new Error(`第 ${index + 1} 个 API Key 不能为空`);
    const models = Array.isArray(input.models)
      ? Array.from(new Set(input.models.map((model) => String(model).trim()).filter(Boolean))).sort()
      : [];
    return {
      id: input.id || `provider-key-${randomUUID()}`,
      label: input.label?.trim() || `Key ${index + 1}`,
      prefix: secret.slice(0, 10),
      secret,
      enabled: input.enabled ?? true,
      models,
      lastCheckedAt: input.lastCheckedAt
    };
  }

  private toProviderApiKeyGroupView(group: ProviderApiKeyGroup) {
    const site = this.db.sites.find((item) => item.id === group.siteId);
    return {
      ...group,
      groupName: site?.name || group.groupName,
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
          .flatMap((group) => group.apiKeys.flatMap((key) => key.models))
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
