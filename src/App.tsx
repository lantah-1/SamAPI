import {
  Activity,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  KeyRound,
  LockKeyhole,
  LogIn,
  Map,
  Plus,
  RefreshCw,
  Route,
  Save,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
  Upload,
  Wand2,
  X
} from "lucide-react";
import { Children, FormEvent, isValidElement, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError, api, isUnauthorizedError } from "./api";
import type {
  ApiKeyCreated,
  AppSettings,
  AppSnapshot,
  AppThemeId,
  EndpointKind,
  GroupRoute,
  GroupRouteMember,
  GroupRouteStrategy,
  HeaderTemplate,
  ProviderApiKeyGroupView,
  ProviderModelGroupOption,
  RequestLog,
  RouteRecord,
  RouteType,
  Site,
  SiteAddress,
  SiteType,
  SwitchRoute,
  TemporaryAccount,
  TemporaryAccountAvailability,
  TemporaryAccountCheckResult,
  TemporaryAccountGroup,
  TemporaryAccountImportSource,
  TemporaryAccountProviderType
} from "../shared/types";

type Section = "routes" | "sites" | "providerKeys" | "temporaryAccounts" | "keys" | "headers" | "logs" | "settings" | "docs";
type AuthStatus = "checking" | "signed-out" | "signed-in";

interface RouteDraft {
  id?: string;
  name?: string;
  type?: RouteType;
  siteId?: string;
  addressId?: string;
  model?: string;
  modelGroupId?: string;
  matchRule?: string;
  members?: GroupRouteMember[];
  strategy?: GroupRouteStrategy;
  endpoint?: EndpointKind;
  headerTemplateId?: string;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface ProviderApiKeyDraft {
  id?: string;
  label: string;
  secret: string;
  enabled: boolean;
  models: string[];
  lastCheckedAt?: string;
}

interface ProviderKeyGroupDraft {
  id?: string;
  siteId: string;
  groupName: string;
  apiKeys: ProviderApiKeyDraft[];
}

interface TemporaryAccountImportDraft {
  name: string;
  providerType: TemporaryAccountProviderType;
  source: TemporaryAccountImportSource;
  modelsText: string;
  content: string;
  contents: string[];
  fileNames: string[];
}

interface HeaderKeyValue {
  key: string;
  value: string;
}

interface HeaderTemplateDraft extends Partial<HeaderTemplate> {
  headerRows: HeaderKeyValue[];
}

interface ProviderModelOption {
  siteId: string;
  siteName: string;
  apiKeyId: string;
  apiKeyLabel: string;
  model: string;
  enabled: boolean;
}

const blankAddress: SiteAddress = {
  id: "",
  label: "主地址",
  baseUrl: "",
  enabled: true,
  models: []
};

const blankHeaderRow: HeaderKeyValue = {
  key: "",
  value: ""
};

const endpointLabels: Record<EndpointKind, string> = {
  messages: "message",
  "chat/completions": "chat/complete",
  responses: "response"
};

const siteTypeLabels: Record<SiteType, string> = {
  newapi: "NewApi",
  unknown: "未知"
};

const routeTypeLabels: Record<RouteType, string> = {
  switch: "切换型",
  group: "分组型"
};

const groupStrategyLabels: Record<GroupRouteStrategy, string> = {
  "stable-first": "稳定优先",
  sequential: "顺序执行",
  random: "随机调用"
};

const temporaryAccountSourceLabels: Record<TemporaryAccountImportSource, string> = {
  cpa: "CPA",
  subapi: "Sub2API"
};

const temporaryAccountProviderLabels: Record<TemporaryAccountProviderType, string> = {
  gpt: "GPT",
  grok: "Grok",
  claude: "Claude",
  gemini: "Gemini"
};

const temporaryAccountAvailabilityLabels: Record<TemporaryAccountAvailability, string> = {
  available: "可用",
  unavailable: "不可用",
  unknown: "未检查"
};

const themeOptions = [
  {
    id: "fresh",
    name: "清泉",
    description: "冷白底色配青绿色状态，清爽、安静、适合默认使用。",
    swatches: ["#f6f8fb", "#0f766e", "#99f6e4"]
  },
  {
    id: "salt",
    name: "海盐蓝",
    description: "蓝灰与海水蓝，界面更冷静，长时间查看日志也舒服。",
    swatches: ["#f5f9ff", "#2563eb", "#67e8f9"]
  },
  {
    id: "citrus",
    name: "青柚绿",
    description: "偏自然的绿色和浅柠色，轻快但不刺眼。",
    swatches: ["#f7faf3", "#3f7d20", "#d9f99d"]
  },
  {
    id: "rose",
    name: "雾玫瑰",
    description: "冷灰底上加一点玫瑰红，柔和、干净、有识别度。",
    swatches: ["#fbf7f9", "#be185d", "#fbcfe8"]
  },
  {
    id: "midnight",
    name: "深海夜",
    description: "深色模式，适合夜间调试和低光环境。",
    swatches: ["#0b1220", "#22d3ee", "#134e4a"]
  }
] satisfies Array<{ id: AppThemeId; name: string; description: string; swatches: string[] }>;

const navItems = [
  { id: "routes", label: "路由管理", icon: Route },
  { id: "sites", label: "站点管理", icon: Server },
  { id: "providerKeys", label: "API Key 管理", icon: KeyRound },
  { id: "temporaryAccounts", label: "临时账号", icon: Upload },
  { id: "keys", label: "客户端密钥", icon: ShieldCheck },
  { id: "headers", label: "Header 模版", icon: Braces },
  { id: "logs", label: "日志管理", icon: Activity },
  { id: "docs", label: "接入", icon: Map }
] satisfies Array<{ id: Section; label: string; icon: typeof Route }>;

const settingsNavItem = { id: "settings", label: "设置", icon: Settings } satisfies { id: Section; label: string; icon: typeof Route };
const allNavItems = [...navItems, settingsNavItem];
const LOGS_PAGE_SIZE = 5;

function groupMemberKey(member: GroupRouteMember) {
  return `${member.siteId}::${member.apiKeyId}::${member.model}`;
}

function providerModelOptions(snapshot?: AppSnapshot): ProviderModelOption[] {
  if (!snapshot) return [];
  const options = new globalThis.Map<string, ProviderModelOption>();
  for (const group of snapshot.providerApiKeyGroups) {
    const site = snapshot.sites.find((item) => item.id === group.siteId);
    for (const apiKey of group.apiKeys) {
      for (const model of apiKey.models) {
        if (!model) continue;
        const option = {
          siteId: group.siteId,
          siteName: site?.name || group.groupName,
          apiKeyId: apiKey.id,
          apiKeyLabel: apiKey.label,
          model,
          enabled: Boolean(apiKey.enabled && site)
        };
        options.set(groupMemberKey(option), option);
      }
    }
  }
  return Array.from(options.values()).sort((left, right) => {
    const siteOrder = left.siteName.localeCompare(right.siteName);
    if (siteOrder !== 0) return siteOrder;
    const keyOrder = left.apiKeyLabel.localeCompare(right.apiKeyLabel);
    if (keyOrder !== 0) return keyOrder;
    return left.model.localeCompare(right.model);
  });
}

function optionToMember(option: ProviderModelOption): GroupRouteMember {
  return {
    siteId: option.siteId,
    apiKeyId: option.apiKeyId,
    model: option.model
  };
}

function uniqueMembers(members: GroupRouteMember[]) {
  const memberMap = new globalThis.Map<string, GroupRouteMember>();
  for (const member of members) memberMap.set(groupMemberKey(member), member);
  return Array.from(memberMap.values());
}

function matchRuleTokens(rule: string) {
  return rule
    .split(/[\n,，;；]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function modelMatchesRule(model: string, rule: string) {
  const normalizedModel = model.trim().toLowerCase();
  if (!normalizedModel) return false;
  return matchRuleTokens(rule).some((token) => normalizedModel.startsWith(token));
}

function modelMatchTokens(value: string) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function smartModelMatches(model: string, query: string) {
  if (modelMatchesRule(model, query)) return true;
  const modelTokens = modelMatchTokens(model);
  const queryTokens = modelMatchTokens(query);
  if (modelTokens.length === 0 || queryTokens.length === 0) return false;
  const modelCounts = new globalThis.Map<string, number>();
  for (const token of modelTokens) modelCounts.set(token, (modelCounts.get(token) || 0) + 1);
  return queryTokens.every((token) => {
    const current = modelCounts.get(token) || 0;
    if (current <= 0) return false;
    modelCounts.set(token, current - 1);
    return true;
  });
}

function groupRouteStats(snapshot: AppSnapshot, route: GroupRoute) {
  const selected = new Set((route.members || []).map(groupMemberKey));
  const selectedOptions = providerModelOptions(snapshot).filter((option) => selected.has(groupMemberKey(option)));
  return {
    providerCount: new Set(selectedOptions.map((option) => option.siteId)).size,
    keyCount: new Set(selectedOptions.map((option) => option.apiKeyId)).size,
    modelCount: selectedOptions.length,
    models: selectedOptions.map((option) => option.model)
  };
}

function groupRouteMemberGroups(snapshot: AppSnapshot, route: GroupRoute) {
  const selected = new Set((route.members || []).map(groupMemberKey));
  const providerMap = new globalThis.Map<
    string,
    {
      siteId: string;
      siteName: string;
      apiKeys: globalThis.Map<string, { apiKeyId: string; apiKeyLabel: string; models: string[] }>;
    }
  >();
  for (const option of providerModelOptions(snapshot)) {
    if (!selected.has(groupMemberKey(option))) continue;
    const provider =
      providerMap.get(option.siteId) ||
      {
        siteId: option.siteId,
        siteName: option.siteName,
        apiKeys: new globalThis.Map<string, { apiKeyId: string; apiKeyLabel: string; models: string[] }>()
      };
    const apiKey = provider.apiKeys.get(option.apiKeyId) || { apiKeyId: option.apiKeyId, apiKeyLabel: option.apiKeyLabel, models: [] };
    apiKey.models.push(option.model);
    provider.apiKeys.set(option.apiKeyId, apiKey);
    providerMap.set(option.siteId, provider);
  }
  return Array.from(providerMap.values()).map((provider) => ({
    ...provider,
    apiKeys: Array.from(provider.apiKeys.values())
  }));
}

function emptyRoute(snapshot?: AppSnapshot, type: RouteType = "switch"): RouteDraft {
  if (type === "group") {
    return {
      name: "default-group",
      type: "group",
      matchRule: "",
      members: [],
      strategy: "stable-first",
      endpoint: "messages",
      headerTemplateId: snapshot?.headerTemplates[0]?.id,
      enabled: true
    };
  }
  const site = snapshot?.sites[0];
  const models = site ? siteModels(site) : [];
  return {
    name: "default-messages",
    type: "switch",
    siteId: site?.id || "",
    model: models[0] || "",
    endpoint: "messages",
    headerTemplateId: snapshot?.headerTemplates[0]?.id,
    enabled: true
  };
}

function siteModels(site?: Site) {
  if (!site) return [];
  return Array.from(new Set(site.addresses.filter((address) => address.enabled).flatMap((address) => address.models).filter(Boolean))).sort();
}

function parseModelText(value: string) {
  return Array.from(new Set(value.split(/[\n,，;；\s]+/).map((model) => model.trim()).filter(Boolean))).sort();
}

function serializeModelText(models: string[]) {
  return models.join("\n");
}

function mergeModelOptions(...modelLists: Array<Array<string | undefined>>) {
  return Array.from(new Set(modelLists.flat().filter((model): model is string => Boolean(model)))).sort();
}

function emptySite(): Partial<Site> {
  return {
    name: "",
    siteType: "unknown",
    addresses: [{ ...blankAddress }]
  };
}

function parseHeaderRows(headersText = ""): HeaderKeyValue[] {
  const rows = headersText
    .split(/\r?\n/)
    .map((rawLine) => rawLine.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex < 0) return { key: line, value: "" };
      return {
        key: line.slice(0, separatorIndex).trim(),
        value: line.slice(separatorIndex + 1).trim()
      };
    });
  return rows.length > 0 ? rows : [{ ...blankHeaderRow }];
}

function serializeHeaderRows(rows: HeaderKeyValue[]) {
  return rows
    .map((row) => ({ key: row.key.trim(), value: row.value.trim() }))
    .filter((row) => row.key)
    .map((row) => `${row.key}: ${row.value}`)
    .join("\n");
}

function emptyHeader(): HeaderTemplateDraft {
  return {
    name: "",
    headersText: "",
    headerRows: [{ ...blankHeaderRow }]
  };
}

function emptyProviderKeyGroup(snapshot?: AppSnapshot): ProviderKeyGroupDraft {
  const site = snapshot?.sites[0];
  return {
    siteId: site?.id || "",
    groupName: site?.name || "",
    apiKeys: [{ label: "Key 1", secret: "", enabled: true, models: [] }]
  };
}

function emptyTemporaryAccountImport(): TemporaryAccountImportDraft {
  return {
    name: "GPT 临时账号",
    providerType: "gpt",
    source: "subapi",
    modelsText: "",
    content: "",
    contents: [],
    fileNames: []
  };
}

function temporaryAccountCheckSummary(result: TemporaryAccountCheckResult) {
  return `${result.total} 个账号，${result.available} 可用 / ${result.unavailable} 不可用 / ${result.unknown} 未检查`;
}

function temporaryAccountAvailabilityStats(accounts: TemporaryAccount[]) {
  return accounts.reduce(
    (stats, account) => {
      const availability = account.availability || "unknown";
      stats[availability] += 1;
      return stats;
    },
    { available: 0, unavailable: 0, unknown: 0 } satisfies Record<TemporaryAccountAvailability, number>
  );
}

function temporaryAccountTypeLabel(account: TemporaryAccount) {
  if (account.accountType === "openai-api-key") return "OpenAI API Key";
  if (account.accountType === "codex" || account.accountId) return "Codex";
  return "临时账号";
}

function formatQuotaValue(value: TemporaryAccount["quotaStages"][number]["remaining"], unit?: string) {
  if (value === undefined || value === null || value === "") return "";
  return `${value}${unit || ""}`;
}

function temporaryAccountQuotaText(stage: TemporaryAccount["quotaStages"][number]) {
  const parts = [
    formatQuotaValue(stage.remaining, stage.unit) ? `剩余 ${formatQuotaValue(stage.remaining, stage.unit)}` : "",
    formatQuotaValue(stage.used, stage.unit) ? `已用 ${formatQuotaValue(stage.used, stage.unit)}` : "",
    formatQuotaValue(stage.total, stage.unit) ? `总量 ${formatQuotaValue(stage.total, stage.unit)}` : "",
    stage.resetAt ? `${formatTime(stage.resetAt)} 重置` : ""
  ].filter(Boolean);
  return `${stage.label}${parts.length > 0 ? `：${parts.join(" / ")}` : ""}`;
}

function numericQuotaValue(value: TemporaryAccount["quotaStages"][number]["remaining"]) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = Number(value.replace(/,/g, "").replace(/%$/, "").trim());
  return Number.isFinite(normalized) ? normalized : undefined;
}

function temporaryAccountQuotaPercent(stage: TemporaryAccount["quotaStages"][number]) {
  const remaining = numericQuotaValue(stage.remaining);
  const used = numericQuotaValue(stage.used);
  const total = numericQuotaValue(stage.total);
  if (total && total > 0 && remaining != null) return Math.min(100, Math.max(0, (remaining / total) * 100));
  if (total && total > 0 && used != null) return Math.min(100, Math.max(0, ((total - used) / total) * 100));
  if (remaining != null) return remaining > 0 ? 100 : 0;
  return undefined;
}

function formatQuotaPercent(value?: number) {
  if (value == null) return "未知";
  return `${Math.round(value)}%`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function prettyJson(value: unknown) {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function upstreamAttemptsSummary(log: RequestLog) {
  return (log.upstreamAttempts || []).map(({ requestBody: _requestBody, ...attempt }) => attempt);
}

function upstreamRequestBodies(log: RequestLog) {
  const bodies = (log.upstreamAttempts || [])
    .filter((attempt) => attempt.requestBody !== undefined)
    .map((attempt) => ({
      addressLabel: attempt.addressLabel,
      upstreamUrl: attempt.upstreamUrl,
      model: attempt.model,
      endpoint: attempt.endpoint,
      body: attempt.requestBody
    }));
  return bodies.length > 0 ? bodies : "-";
}

function apiOrigin() {
  const hostname = window.location.hostname || "127.0.0.1";
  return `http://${hostname}:8787`;
}

function toastDurationMs(message: string) {
  return Math.min(12000, Math.max(3500, message.length * 45));
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`field ${props.className || ""}`} />;
}

function selectOptionLabel(value: React.ReactNode): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(selectOptionLabel).join("");
  return "";
}

function SelectInput(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, children, disabled, value, defaultValue, onChange, name } = props;
  const selectId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const currentValue = String(value ?? defaultValue ?? "");
  const options = useMemo(
    () =>
      Children.toArray(children).flatMap((child) => {
        if (!isValidElement<{ value?: string | number; disabled?: boolean; children?: React.ReactNode }>(child)) return [];
        if (child.type !== "option") return [];
        const optionValue = String(child.props.value ?? selectOptionLabel(child.props.children));
        return [
          {
            value: optionValue,
            label: selectOptionLabel(child.props.children) || optionValue,
            disabled: Boolean(child.props.disabled)
          }
        ];
      }),
    [children]
  );
  const selectedIndex = options.findIndex((option) => option.value === currentValue);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const firstEnabledIndex = options.findIndex((option) => !option.disabled);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : Math.max(firstEnabledIndex, 0));
  }, [firstEnabledIndex, open, options, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  const commitValue = (nextValue: string) => {
    setOpen(false);
    onChange?.({
      target: { value: nextValue, name },
      currentTarget: { value: nextValue, name }
    } as unknown as React.ChangeEvent<HTMLSelectElement>);
  };

  const moveActive = (direction: 1 | -1) => {
    if (options.length === 0) return;
    setActiveIndex((current) => {
      let next = current;
      for (let step = 0; step < options.length; step += 1) {
        next = (next + direction + options.length) % options.length;
        if (!options[next].disabled) return next;
      }
      return current;
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const option = options[activeIndex];
      if (option && !option.disabled) commitValue(option.value);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <span
      ref={rootRef}
      className={`select-shell ${open ? "select-shell-open" : ""} ${disabled ? "select-shell-disabled" : ""}`}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={`field select-trigger ${className || ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${selectId}-listbox`}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
      >
        <span className={`select-trigger-value ${selectedOption ? "" : "select-trigger-placeholder"}`}>
          {selectedOption?.label || "请选择"}
        </span>
        <ChevronDown className="select-chevron h-4 w-4" aria-hidden="true" />
      </button>
      {open ? (
        <div id={`${selectId}-listbox`} className="select-menu" role="listbox">
          {options.map((option, index) => {
            const selected = option.value === currentValue;
            const active = index === activeIndex;
            return (
              <button
                key={`${option.value}-${index}`}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={option.disabled}
                className={`select-option ${selected ? "select-option-selected" : ""} ${active ? "select-option-active" : ""}`}
                onMouseEnter={() => setActiveIndex(index)}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!option.disabled) commitValue(option.value);
                }}
              >
                <span>{option.label}</span>
                {selected ? <Check className="h-4 w-4" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}

function ActionButton({
  children,
  tone = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "ghost" | "danger" }) {
  return (
    <button {...props} className={`action action-${tone} ${props.className || ""}`}>
      {children}
    </button>
  );
}

function NavButton(props: { item: (typeof allNavItems)[number]; active: boolean; onClick: (section: Section) => void; className?: string }) {
  const Icon = props.item.icon;
  return (
    <button
      onClick={() => props.onClick(props.item.id)}
      title={props.item.label}
      className={`nav-button ${props.active ? "nav-button-active" : ""} ${props.className || ""}`}
    >
      <Icon className="h-5 w-5" />
      <span className="app-nav-label">{props.item.label}</span>
    </button>
  );
}

function AuthLanding(props: {
  status: AuthStatus;
  busy: boolean;
  error: string;
  onLogin: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const checking = props.status === "checking";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!password.trim() || props.busy || checking) return;
    props.onLogin(password);
  };

  return (
    <main className="auth-page min-h-screen text-ink">
      <div className="grain" />
      <div className="auth-shell">
        <section className="auth-copy" aria-labelledby="auth-title">
          <div className="auth-kicker">
            <span className="auth-kicker-mark">
              <ShieldCheck className="h-4 w-4" />
            </span>
            Local model gateway
          </div>
          <h1 id="auth-title">SamAPI</h1>
          <p className="auth-intro">
            一个面向本地和私有部署的模型路由控制台，用来集中管理上游模型供应商、Header 模版、客户端密钥和路由策略。
          </p>
          <div className="auth-metric-row" aria-label="SamAPI capability summary">
            <div>
              <strong>Proxy</strong>
              <span>统一转发入口</span>
            </div>
            <div>
              <strong>Keys</strong>
              <span>客户端密钥</span>
            </div>
            <div>
              <strong>Logs</strong>
              <span>请求链路记录</span>
            </div>
          </div>
          <div className="auth-feature-grid">
            <div className="auth-feature">
              <Route className="h-4 w-4" />
              <span>在多个供应商、模型和 endpoint 之间切换路由。</span>
            </div>
            <div className="auth-feature">
              <KeyRound className="h-4 w-4" />
              <span>把上游 Key 和下游调用密钥分开管理。</span>
            </div>
            <div className="auth-feature">
              <Activity className="h-4 w-4" />
              <span>记录下游请求、上游响应和失败原因。</span>
            </div>
          </div>
        </section>

        <form className="auth-panel panel" onSubmit={submit}>
          <div className="auth-lock">
            <LockKeyhole className="h-5 w-5" />
          </div>
          <div>
            <h2>进入控制台</h2>
            <p>管理入口已启用密码保护。</p>
          </div>
          <label>
            管理密码
            <TextInput
              type="password"
              value={password}
              autoFocus
              autoComplete="current-password"
              disabled={props.busy || checking}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {props.error ? <div className="auth-error" role="alert">{props.error}</div> : null}
          <ActionButton type="submit" disabled={!password.trim() || props.busy || checking}>
            {props.busy || checking ? <RefreshCw className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
            {checking ? "检查会话" : "进入"}
          </ActionButton>
        </form>
      </div>
    </main>
  );
}

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [temporaryAccountsLoaded, setTemporaryAccountsLoaded] = useState(false);
  const [temporaryAccountsLoading, setTemporaryAccountsLoading] = useState(false);
  const [temporaryAccountsError, setTemporaryAccountsError] = useState("");
  const [section, setSection] = useState<Section>("routes");
  const [routeDraft, setRouteDraft] = useState<RouteDraft>({});
  const [routeEditorOpen, setRouteEditorOpen] = useState(false);
  const [siteDraft, setSiteDraft] = useState<Partial<Site>>(emptySite());
  const [siteEditorOpen, setSiteEditorOpen] = useState(false);
  const [providerKeyDraft, setProviderKeyDraft] = useState<ProviderKeyGroupDraft>(emptyProviderKeyGroup());
  const [providerKeyEditorOpen, setProviderKeyEditorOpen] = useState(false);
  const [temporaryAccountDraft, setTemporaryAccountDraft] = useState<TemporaryAccountImportDraft>(emptyTemporaryAccountImport());
  const [temporaryAccountEditorOpen, setTemporaryAccountEditorOpen] = useState(false);
  const [headerDraft, setHeaderDraft] = useState<HeaderTemplateDraft>(emptyHeader());
  const [headerEditorOpen, setHeaderEditorOpen] = useState(false);
  const [keyName, setKeyName] = useState("client-app");
  const [keyEditorOpen, setKeyEditorOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<ApiKeyCreated | null>(null);
  const [toast, setToast] = useState<string>("");
  const [appScrollbarVisible, setAppScrollbarVisible] = useState(false);
  const [appScrollbarThumb, setAppScrollbarThumb] = useState({ height: 0, scrollable: false, top: 0 });
  const [logsAutoRefresh, setLogsAutoRefresh] = useState(true);
  const [logsRefreshing, setLogsRefreshing] = useState(false);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsPage, setLogsPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [modelSyncing, setModelSyncing] = useState(false);
  const [modelDiscoveringIndex, setModelDiscoveringIndex] = useState<number | null>(null);
  const [providerModelGroupOptions, setProviderModelGroupOptions] = useState<Record<number, ProviderModelGroupOption[]>>({});
  const [temporaryAccountChecking, setTemporaryAccountChecking] = useState<string | null>(null);
  const [temporaryAccountDeleting, setTemporaryAccountDeleting] = useState<string | null>(null);
  const [selectedTemporaryAccountIds, setSelectedTemporaryAccountIds] = useState<string[]>([]);
  const appScrollRef = useRef<HTMLDivElement | null>(null);
  const appScrollContentRef = useRef<HTMLDivElement | null>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);
  const toastStartedAtRef = useRef(0);
  const toastRemainingMsRef = useRef(0);
  const appScrollbarTimerRef = useRef<number | undefined>(undefined);

  const clearToastTimer = () => {
    if (toastTimerRef.current === undefined) return;
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = undefined;
  };

  const startToastTimer = (durationMs: number) => {
    clearToastTimer();
    toastRemainingMsRef.current = durationMs;
    toastStartedAtRef.current = Date.now();
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = undefined;
      setToast("");
    }, durationMs);
  };

  const pauseToastTimer = () => {
    if (toastTimerRef.current === undefined) return;
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = undefined;
    const elapsedMs = Date.now() - toastStartedAtRef.current;
    toastRemainingMsRef.current = Math.max(0, toastRemainingMsRef.current - elapsedMs);
  };

  const resumeToastTimer = () => {
    if (!toast || toastTimerRef.current !== undefined) return;
    startToastTimer(Math.max(500, toastRemainingMsRef.current));
  };

  const closeToast = () => {
    clearToastTimer();
    setToast("");
  };

  const clearAppScrollbarTimer = () => {
    if (appScrollbarTimerRef.current === undefined) return;
    window.clearTimeout(appScrollbarTimerRef.current);
    appScrollbarTimerRef.current = undefined;
  };

  const showAppScrollbar = () => {
    setAppScrollbarVisible(true);
    clearAppScrollbarTimer();
    appScrollbarTimerRef.current = window.setTimeout(() => {
      setAppScrollbarVisible(false);
      appScrollbarTimerRef.current = undefined;
    }, 2000);
  };

  const hideAppScrollbar = () => {
    clearAppScrollbarTimer();
    setAppScrollbarVisible(false);
  };

  const updateAppScrollbar = () => {
    const element = appScrollRef.current;
    if (!element) return;
    const { clientHeight, scrollHeight, scrollTop } = element;
    const scrollable = scrollHeight > clientHeight + 1;
    if (!scrollable) {
      setAppScrollbarThumb((current) => (current.scrollable ? { height: 0, scrollable: false, top: 0 } : current));
      return;
    }
    const inset = 8;
    const trackHeight = Math.max(0, clientHeight - inset * 2);
    const height = Math.min(trackHeight, Math.max(44, (clientHeight / scrollHeight) * trackHeight));
    const maxTop = Math.max(0, trackHeight - height);
    const maxScrollTop = Math.max(1, scrollHeight - clientHeight);
    const top = inset + (scrollTop / maxScrollTop) * maxTop;
    setAppScrollbarThumb((current) =>
      current.scrollable &&
      Math.abs(current.height - height) < 0.5 &&
      Math.abs(current.top - top) < 0.5
        ? current
        : { height, scrollable: true, top }
    );
  };

  const revealAppScrollbar = () => {
    updateAppScrollbar();
    showAppScrollbar();
  };

  const handleUnauthorized = (error: unknown) => {
    if (!isUnauthorizedError(error)) return false;
    setSnapshot(null);
    setTemporaryAccountsLoaded(false);
    setTemporaryAccountsLoading(false);
    setTemporaryAccountsError("");
    setAuthStatus("signed-out");
    setAuthError("会话已过期，请重新输入管理密码");
    return true;
  };

  const load = async (options: { includeRequestLogs?: boolean; includeTemporaryAccounts?: boolean } = {}) => {
    const currentSnapshot = snapshot;
    const [bootstrap, settings, sites, apiKeys, providerApiKeyGroups, headerTemplates, routes, requestLogs, temporaryAccountGroups] =
      await Promise.all([
        api.bootstrap(),
        api.listSettings(),
        api.listSites(),
        api.listKeys(),
        api.listProviderKeyGroups(),
        api.listHeaders(),
        api.listRoutes(),
        options.includeRequestLogs
          ? api.listLogs(LOGS_PAGE_SIZE, logsPage * LOGS_PAGE_SIZE).then((result) => {
              setLogsTotal(result.total);
              return result.items;
            })
          : Promise.resolve(currentSnapshot?.requestLogs || []),
        options.includeTemporaryAccounts ? api.listTemporaryAccountGroups() : Promise.resolve(currentSnapshot?.temporaryAccountGroups || [])
      ]);
    const next: AppSnapshot = {
      ...bootstrap,
      settings,
      sites,
      apiKeys,
      providerApiKeyGroups,
      headerTemplates,
      routes,
      requestLogs,
      temporaryAccountGroups
    };
    if (options.includeTemporaryAccounts) {
      setTemporaryAccountsLoaded(true);
      setTemporaryAccountsError("");
    }
    setTemporaryAccountsLoading(false);
    setSnapshot(next);
    setRouteDraft((current) => (current.name ? current : emptyRoute(next)));
    setAuthStatus("signed-in");
    setAuthError("");
  };

  const loadTemporaryAccountGroups = async () => {
    if (temporaryAccountsLoading) return;
    setTemporaryAccountsLoading(true);
    setTemporaryAccountsError("");
    try {
      const temporaryAccountGroups = await api.listTemporaryAccountGroups();
      setSnapshot((current) => (current ? { ...current, temporaryAccountGroups } : current));
      setTemporaryAccountsLoaded(true);
    } catch (error) {
      if (handleUnauthorized(error)) return;
      const message = error instanceof Error ? error.message : "临时账号加载失败";
      setTemporaryAccountsError(message);
      setTemporaryAccountsLoaded(true);
      setToast(message);
    } finally {
      setTemporaryAccountsLoading(false);
    }
  };

  const bootstrap = async () => {
    try {
      const session = await api.authSession();
      if (!session.authenticated) {
        setSnapshot(null);
        setTemporaryAccountsLoaded(false);
        setTemporaryAccountsLoading(false);
        setTemporaryAccountsError("");
        setAuthStatus("signed-out");
        return;
      }
      await load();
    } catch (error) {
      setSnapshot(null);
      setTemporaryAccountsLoaded(false);
      setTemporaryAccountsLoading(false);
      setTemporaryAccountsError("");
      setAuthStatus("signed-out");
      setAuthError(error instanceof Error ? error.message : "认证状态检查失败");
    }
  };

  const login = async (password: string) => {
    setAuthBusy(true);
    setAuthError("");
    try {
      await api.login(password);
      await load();
      setToast("已进入控制台");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "登录失败");
    } finally {
      setAuthBusy(false);
    }
  };

  const loadLogsPage = async (page = logsPage, showSuccess = false) => {
    setLogsRefreshing(true);
    try {
      const offset = page * LOGS_PAGE_SIZE;
      const result = await api.listLogs(LOGS_PAGE_SIZE, offset);
      setSnapshot((current) => (current ? { ...current, requestLogs: result.items } : current));
      setLogsTotal(result.total);
      setLogsPage(result.total > 0 && offset >= result.total ? Math.max(0, Math.ceil(result.total / LOGS_PAGE_SIZE) - 1) : page);
      if (showSuccess) setToast("日志已刷新");
    } catch (error) {
      if (!handleUnauthorized(error)) setToast(error instanceof Error ? error.message : "日志刷新失败");
    } finally {
      setLogsRefreshing(false);
    }
  };

  const refreshLogs = async (showSuccess = false) => {
    if (logsPage !== 0) {
      await loadLogsPage(logsPage, showSuccess);
      return;
    }
    setLogsRefreshing(true);
    try {
      const latestCreatedAt = snapshot?.requestLogs[0]?.createdAt;
      if (!latestCreatedAt) {
        await loadLogsPage(0, showSuccess);
        return;
      }
      const result = await api.listNewLogs(latestCreatedAt);
      if (result.items.length > 0) {
        setSnapshot((current) => {
          if (!current) return current;
          const existingIds = new Set(current.requestLogs.map((log) => log.id));
          const mergedLogs = [...result.items.filter((log) => !existingIds.has(log.id)), ...current.requestLogs].slice(0, LOGS_PAGE_SIZE);
          return { ...current, requestLogs: mergedLogs };
        });
      }
      setLogsTotal(result.total);
      if (showSuccess) setToast(result.items.length > 0 ? `日志已刷新，新增 ${result.items.length} 条` : "日志已刷新");
    } catch (error) {
      if (!handleUnauthorized(error)) setToast(error instanceof Error ? error.message : "日志刷新失败");
    } finally {
      setLogsRefreshing(false);
    }
  };

  useEffect(() => {
    bootstrap();
  }, []);

  useEffect(() => {
    const themeId = snapshot?.settings.themeId || "fresh";
    document.documentElement.dataset.theme = themeId;
    document.documentElement.style.colorScheme = themeId === "midnight" ? "dark" : "light";
  }, [snapshot?.settings.themeId]);

  useEffect(() => {
    if (!toast) return;
    startToastTimer(toastDurationMs(toast));
    return clearToastTimer;
  }, [toast]);

  useEffect(() => clearAppScrollbarTimer, []);

  useEffect(() => {
    const scrollElement = appScrollRef.current;
    const contentElement = appScrollContentRef.current;
    if (!scrollElement || !contentElement) return;
    updateAppScrollbar();
    const observer = new ResizeObserver(updateAppScrollbar);
    observer.observe(scrollElement);
    observer.observe(contentElement);
    window.addEventListener("resize", updateAppScrollbar);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateAppScrollbar);
    };
  }, [section, snapshot]);

  useEffect(() => {
    if (authStatus !== "signed-in" || section !== "temporaryAccounts" || temporaryAccountsLoaded) return;
    loadTemporaryAccountGroups();
  }, [authStatus, section, temporaryAccountsLoaded]);

  useEffect(() => {
    if (authStatus !== "signed-in" || section !== "logs") return;
    loadLogsPage(logsPage);
  }, [authStatus, section, logsPage]);

  useEffect(() => {
    if (authStatus !== "signed-in" || section !== "logs" || !logsAutoRefresh) return;
    const interval = window.setInterval(() => {
      refreshLogs();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [authStatus, section, logsAutoRefresh, logsPage, snapshot?.requestLogs[0]?.createdAt]);

  const selectedSite = useMemo(
    () => snapshot?.sites.find((site) => site.id === routeDraft.siteId),
    [routeDraft.siteId, snapshot]
  );
  const selectedSiteModels = useMemo(() => siteModels(selectedSite), [selectedSite]);

  const mutate = async (work: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await work();
      await load({
        includeRequestLogs: section === "logs",
        includeTemporaryAccounts: temporaryAccountsLoaded
      });
      setToast(message);
    } catch (error) {
      if (!handleUnauthorized(error)) setToast(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const changeAdminPassword = async (currentPassword: string, nextPassword: string) => {
    setBusy(true);
    try {
      await api.updateAdminPassword(currentPassword, nextPassword);
      setSnapshot(null);
      setTemporaryAccountsLoaded(false);
      setTemporaryAccountsLoading(false);
      setTemporaryAccountsError("");
      setAuthStatus("signed-out");
      setAuthError("");
      setToast("");
    } catch (error) {
      if (handleUnauthorized(error)) return;
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const saveRoute = (event: FormEvent) => {
    event.preventDefault();
    mutate(async () => {
      await api.saveRoute(routeDraft as Partial<RouteRecord>);
      setRouteEditorOpen(false);
    }, "路由已保存");
  };

  const saveSite = (event: FormEvent) => {
    event.preventDefault();
    mutate(async () => {
      await api.saveSite(siteDraft);
      setSiteEditorOpen(false);
    }, "站点已保存");
  };

  const saveProviderKeyGroup = (event: FormEvent) => {
    event.preventDefault();
    mutate(async () => {
      await api.saveProviderKeyGroup(providerKeyDraft);
      setProviderKeyEditorOpen(false);
    }, "API Key 分组已保存");
  };

  const importTemporaryAccounts = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    (async () => {
      const result = await api.importTemporaryAccounts({
        name: temporaryAccountDraft.name,
        providerType: temporaryAccountDraft.providerType,
        content: temporaryAccountDraft.content,
        contents: temporaryAccountDraft.contents
      });
      setTemporaryAccountEditorOpen(false);
      setTemporaryAccountDraft(emptyTemporaryAccountImport());
      const temporaryAccountGroups = await api.listTemporaryAccountGroups();
      setSnapshot((current) => (current ? { ...current, temporaryAccountGroups } : current));
      setTemporaryAccountsLoaded(true);
      setTemporaryAccountsLoading(false);
      const checkSummary = result.checkResult ? `；检查结果：${temporaryAccountCheckSummary(result.checkResult)}` : "";
      setToast(`已导入 ${result.imported} 个临时账号${result.skipped ? `，跳过 ${result.skipped} 个重复项` : ""}${checkSummary}`);
    })()
      .catch((error) => {
        if (!handleUnauthorized(error)) setToast(error instanceof Error ? error.message : "临时账号导入失败");
      })
      .finally(() => setBusy(false));
  };

  const checkTemporaryAccounts = async () => {
    setTemporaryAccountChecking("all");
    try {
      const result = await api.checkTemporaryAccounts();
      const temporaryAccountGroups = await api.listTemporaryAccountGroups();
      setSnapshot((current) => (current ? { ...current, temporaryAccountGroups } : current));
      setTemporaryAccountsLoaded(true);
      setTemporaryAccountsLoading(false);
      setToast(`GPT 账号检查完成：${temporaryAccountCheckSummary(result)}`);
    } catch (error) {
      if (!handleUnauthorized(error)) setToast(error instanceof Error ? error.message : "临时账号检查失败");
    } finally {
      setTemporaryAccountChecking(null);
    }
  };

  const deleteTemporaryAccount = async (id: string) => {
    if (temporaryAccountDeleting) return;
    setTemporaryAccountDeleting(id);
    try {
      await api.deleteTemporaryAccount(id);
      const temporaryAccountGroups = await api.listTemporaryAccountGroups();
      setSnapshot((current) => (current ? { ...current, temporaryAccountGroups } : current));
      setSelectedTemporaryAccountIds((current) => current.filter((item) => item !== id));
      setToast("临时账号已删除");
    } catch (error) {
      if (!handleUnauthorized(error)) setToast(error instanceof Error ? error.message : "临时账号删除失败");
    } finally {
      setTemporaryAccountDeleting(null);
    }
  };

  const deleteSelectedTemporaryAccounts = async () => {
    if (temporaryAccountDeleting || selectedTemporaryAccountIds.length === 0) return;
    setTemporaryAccountDeleting("batch");
    try {
      await api.deleteTemporaryAccounts(selectedTemporaryAccountIds);
      const temporaryAccountGroups = await api.listTemporaryAccountGroups();
      setSnapshot((current) => (current ? { ...current, temporaryAccountGroups } : current));
      setSelectedTemporaryAccountIds([]);
      setToast("已批量删除临时账号");
    } catch (error) {
      if (!handleUnauthorized(error)) setToast(error instanceof Error ? error.message : "临时账号批量删除失败");
    } finally {
      setTemporaryAccountDeleting(null);
    }
  };

  const saveHeader = (event: FormEvent) => {
    event.preventDefault();
    mutate(async () => {
      await api.saveHeader({
        id: headerDraft.id,
        name: headerDraft.name,
        headersText: serializeHeaderRows(headerDraft.headerRows)
      });
      setHeaderEditorOpen(false);
    }, "Header 模版已保存");
  };

  const openNewRoute = () => {
    setRouteDraft(emptyRoute(snapshot || undefined));
    setRouteEditorOpen(true);
  };

  const openEditRoute = (route: RouteRecord) => {
    setRouteDraft(route);
    setRouteEditorOpen(true);
  };

  const openNewSite = () => {
    setSiteDraft(emptySite());
    setSiteEditorOpen(true);
  };

  const openEditSite = (site: Site) => {
    setSiteDraft(JSON.parse(JSON.stringify(site)));
    setSiteEditorOpen(true);
  };

  const openNewProviderKeyGroup = () => {
    setProviderKeyDraft(emptyProviderKeyGroup(snapshot || undefined));
    setProviderKeyEditorOpen(true);
  };

  const openNewTemporaryAccounts = () => {
    setTemporaryAccountDraft(emptyTemporaryAccountImport());
    setTemporaryAccountEditorOpen(true);
  };

  const openEditProviderKeyGroup = (group: ProviderApiKeyGroupView) => {
    setProviderKeyDraft({
      id: group.id,
      siteId: group.siteId,
      groupName: group.groupName,
      apiKeys: group.apiKeys.map((apiKey) => ({
        id: apiKey.id,
        label: apiKey.label,
        secret: apiKey.secret,
        enabled: apiKey.enabled,
        models: apiKey.models,
        lastCheckedAt: apiKey.lastCheckedAt
      }))
    });
    setProviderKeyEditorOpen(true);
  };

  const discoverProviderModels = async (index: number) => {
    const apiKey = providerKeyDraft.apiKeys[index];
    setModelDiscoveringIndex(index);
    try {
      const result = await api.discoverProviderModels(providerKeyDraft.siteId, apiKey?.secret || "", apiKey?.label || "");
      setProviderKeyDraft((current) => ({
        ...current,
        apiKeys: current.apiKeys.map((item, itemIndex) =>
          itemIndex === index
            ? { ...item, models: result.models, lastCheckedAt: new Date().toISOString() }
            : item
        )
      }));
      setProviderModelGroupOptions((current) => ({ ...current, [index]: [] }));
      setToast(`已获取 ${result.models.length} 个模型`);
    } catch (error) {
      if (!handleUnauthorized(error)) {
        const payload = error instanceof ApiError ? error.payload : undefined;
        const modelGroups = payload && typeof payload === "object" && "modelGroups" in payload ? (payload as { modelGroups?: unknown }).modelGroups : undefined;
        if (Array.isArray(modelGroups) && modelGroups.length > 0) {
          setProviderModelGroupOptions((current) => ({ ...current, [index]: modelGroups as ProviderModelGroupOption[] }));
          setToast("未匹配到 Key 名称，请从返回的分组中选择模型");
        } else {
          setToast(error instanceof Error ? error.message : "模型获取失败");
        }
      }
    } finally {
      await load().catch(() => undefined);
      setModelDiscoveringIndex(null);
    }
  };

  const syncProviderModels = async () => {
    setModelSyncing(true);
    try {
      const result = await api.syncProviderModels();
      await load();
      if (result.total === 0) {
        setToast("没有可同步的已启用 API Key");
        return;
      }
      const failedItems = result.results.filter((item) => item.status === "failed");
      const failedSummary = failedItems
        .slice(0, 3)
        .map((item) => `${item.siteName}/${item.apiKeyLabel}: ${item.errorMessage || "同步失败"}`)
        .join("；");
      setToast(
        result.failed > 0
          ? `模型同步完成：成功 ${result.success}/${result.total}，失败 ${result.failed}${failedSummary ? `；${failedSummary}` : ""}`
          : `模型同步完成：成功 ${result.success}/${result.total}`
      );
    } catch (error) {
      if (!handleUnauthorized(error)) setToast(error instanceof Error ? error.message : "模型同步失败");
    } finally {
      setModelSyncing(false);
    }
  };

  const openNewKey = () => {
    setKeyName("client-app");
    setCreatedKey(null);
    setKeyEditorOpen(true);
  };

  const closeKeyEditor = () => {
    setKeyEditorOpen(false);
    setCreatedKey(null);
  };

  const openNewHeader = () => {
    setHeaderDraft(emptyHeader());
    setHeaderEditorOpen(true);
  };

  const openEditHeader = (template: HeaderTemplate) => {
    setHeaderDraft({
      ...template,
      headerRows: parseHeaderRows(template.headersText)
    });
    setHeaderEditorOpen(true);
  };

  const openNewForSection = () => {
    if (section === "routes") openNewRoute();
    if (section === "sites") openNewSite();
    if (section === "providerKeys") openNewProviderKeyGroup();
    if (section === "temporaryAccounts") openNewTemporaryAccounts();
    if (section === "keys") openNewKey();
    if (section === "headers") openNewHeader();
  };

  const canAddInSection = ["routes", "sites", "providerKeys", "temporaryAccounts", "keys", "headers"].includes(section);

  const setRouteSite = (siteId: string) => {
    const site = snapshot?.sites.find((item) => item.id === siteId);
    const models = siteModels(site);
    setRouteDraft((current) => ({
      ...current,
      type: "switch",
      siteId,
      addressId: undefined,
      model: models[0] || ""
    }));
  };

  const copyText = async (value: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        textarea.style.top = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (!copied) throw new Error("copy failed");
      }
      setToast("已复制");
    } catch {
      setToast("复制失败，请手动选中密钥复制");
    }
  };

  if (authStatus !== "signed-in") {
    return <AuthLanding status={authStatus} busy={authBusy} error={authError} onLogin={login} />;
  }

  if (!snapshot) {
    return (
      <main className="min-h-screen bg-paper text-ink grid place-items-center">
        <div className="flex items-center gap-3 text-sm font-semibold">
          <RefreshCw className="h-4 w-4 animate-spin" />
          Loading SamAPI
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-paper text-ink">
      <div className="grain" />
      {toast ? (
        <div
          className="toast-float"
          role="status"
          aria-live="polite"
          onMouseEnter={pauseToastTimer}
          onMouseLeave={resumeToastTimer}
          onFocus={pauseToastTimer}
          onBlur={resumeToastTimer}
        >
          <span className="toast-message">{toast}</span>
          <button className="toast-close" type="button" onClick={closeToast} title="关闭消息">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}
      <div className="app-shell mx-auto flex min-h-screen w-full max-w-[1500px] gap-4 p-4 md:p-6">
        <aside className="app-nav panel flex w-[84px] shrink-0 flex-col items-center gap-3 p-3 lg:w-64 lg:items-stretch">
          <div className="app-brand mb-2 flex h-12 items-center gap-3 lg:px-2">
            <div className="app-brand-mark grid h-10 w-10 place-items-center rounded-lg">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div className="app-brand-copy hidden lg:block">
              <div className="font-display text-lg font-black">SamAPI</div>
              <div className="text-xs text-ink/55">Local model gateway</div>
            </div>
          </div>
          {navItems.map((item) => (
            <NavButton key={item.id} item={item} active={section === item.id} onClick={setSection} />
          ))}
          <div className="app-database hidden rounded-lg border border-ink/10 bg-white/50 p-3 text-xs leading-5 text-ink/60 lg:block">
            <div className="mb-1 flex items-center gap-2 font-semibold text-ink">
              <Database className="h-4 w-4" />
              数据库
            </div>
            <div className="break-all">{snapshot.dbPath}</div>
          </div>
          <div className="app-bottom-actions">
            <NavButton item={settingsNavItem} active={section === settingsNavItem.id} onClick={setSection} className="app-settings-nav" />
          </div>
        </aside>

        <section className="app-content flex min-w-0 flex-1 flex-col gap-4">
          <header className="app-header panel flex min-h-16 items-center justify-between gap-4 px-4 py-3">
            <div className="app-header-title">
              <div className="text-xs font-bold text-rust">Control Plane</div>
              <h1 className="font-display text-2xl font-black md:text-3xl">
                {allNavItems.find((item) => item.id === section)?.label}
              </h1>
            </div>
            {canAddInSection || section === "logs" ? (
              <div className="app-header-actions flex items-center gap-2">
                {section === "logs" ? (
                  <ActionButton
                    className="app-header-icon-action"
                    type="button"
                    tone="ghost"
                    onClick={() => refreshLogs(true)}
                    disabled={logsRefreshing}
                    title="刷新日志"
                    aria-label="刷新日志"
                  >
                    <RefreshCw className={`h-4 w-4 ${logsRefreshing ? "animate-spin" : ""}`} />
                  </ActionButton>
                ) : null}
                {canAddInSection ? (
                  <ActionButton type="button" onClick={openNewForSection}>
                    <Plus className="h-4 w-4" />
                    添加
                  </ActionButton>
                ) : null}
              </div>
            ) : null}
          </header>

          <div className="app-scroll-frame" onMouseEnter={revealAppScrollbar} onMouseMove={revealAppScrollbar} onMouseLeave={hideAppScrollbar}>
            <div ref={appScrollRef} className="app-scroll" onScroll={revealAppScrollbar}>
              <div ref={appScrollContentRef} className="app-scroll-content">
            {section === "routes" && (
              <RoutesView
                snapshot={snapshot}
                draft={routeDraft}
                editorOpen={routeEditorOpen}
                selectedSite={selectedSite}
                selectedSiteModels={selectedSiteModels}
                onDraft={setRouteDraft}
                onSite={setRouteSite}
                onSubmit={saveRoute}
                onClose={() => setRouteEditorOpen(false)}
                onDelete={(id) => mutate(async () => api.deleteRoute(id), "路由已删除")}
                onEdit={openEditRoute}
                onQuickSave={(route) => mutate(async () => api.saveRoute(route), "路由已更新")}
                onCopy={copyText}
              />
            )}
            {section === "sites" && (
              <SitesView
                snapshot={snapshot}
                draft={siteDraft}
                editorOpen={siteEditorOpen}
                onDraft={setSiteDraft}
                onSubmit={saveSite}
                onClose={() => setSiteEditorOpen(false)}
                onEdit={openEditSite}
                onDelete={(id) => mutate(async () => api.deleteSite(id), "站点已删除")}
              />
            )}
            {section === "providerKeys" && (
              <ProviderKeysView
                snapshot={snapshot}
                draft={providerKeyDraft}
                editorOpen={providerKeyEditorOpen}
                busy={busy}
                modelSyncing={modelSyncing}
                modelDiscoveringIndex={modelDiscoveringIndex}
                modelGroupOptions={providerModelGroupOptions}
                onDraft={setProviderKeyDraft}
                onSubmit={saveProviderKeyGroup}
                onClose={() => setProviderKeyEditorOpen(false)}
                onDiscoverModels={discoverProviderModels}
                onSyncModels={syncProviderModels}
                onEdit={openEditProviderKeyGroup}
                onDelete={(id) => mutate(async () => api.deleteProviderKeyGroup(id), "API Key 分组已删除")}
              />
            )}
            {section === "temporaryAccounts" && (
              <TemporaryAccountsView
                snapshot={snapshot}
                draft={temporaryAccountDraft}
                editorOpen={temporaryAccountEditorOpen}
                busy={busy}
                checking={temporaryAccountChecking}
                deleting={temporaryAccountDeleting}
                selectedAccountIds={selectedTemporaryAccountIds}
                onSelectedAccountIds={setSelectedTemporaryAccountIds}
                onDraft={setTemporaryAccountDraft}
                onSubmit={importTemporaryAccounts}
                onClose={() => setTemporaryAccountEditorOpen(false)}
                onCheck={checkTemporaryAccounts}
                loading={temporaryAccountsLoading || !temporaryAccountsLoaded}
                error={temporaryAccountsError}
                onRetry={loadTemporaryAccountGroups}
                onStrategyChange={(strategy) => mutate(async () => api.updateSettings({ temporaryAccountStrategy: strategy }), "临时账号策略已更新")}
                onDeleteAccount={deleteTemporaryAccount}
                onDeleteSelected={deleteSelectedTemporaryAccounts}
              />
            )}
            {section === "keys" && (
              <KeysView
                snapshot={snapshot}
                keyName={keyName}
                editorOpen={keyEditorOpen}
                createdKey={createdKey}
                onKeyName={setKeyName}
                onCreate={() =>
                  mutate(async () => {
                    const key = await api.createKey(keyName);
                    setCreatedKey(key);
                  }, "密钥已生成")
                }
                onClose={closeKeyEditor}
                onToggle={(id, enabled) => mutate(async () => api.updateKey(id, { enabled }), "密钥已更新")}
                onDelete={(id) => mutate(async () => api.deleteKey(id), "密钥已删除")}
                onCopy={copyText}
              />
            )}
            {section === "headers" && (
              <HeadersView
                snapshot={snapshot}
                draft={headerDraft}
                editorOpen={headerEditorOpen}
                onDraft={setHeaderDraft}
                onSubmit={saveHeader}
                onClose={() => setHeaderEditorOpen(false)}
                onEdit={openEditHeader}
                onDelete={(id) => mutate(async () => api.deleteHeader(id), "Header 模版已删除")}
              />
            )}
            {section === "logs" && (
              <LogsView
                snapshot={snapshot}
                total={logsTotal}
                page={logsPage}
                pageSize={LOGS_PAGE_SIZE}
                autoRefresh={logsAutoRefresh}
                onAutoRefresh={setLogsAutoRefresh}
                onPage={setLogsPage}
                onDelete={(id) => mutate(async () => api.deleteLog(id), "日志已删除")}
                onClear={() => mutate(async () => api.clearLogs(), "日志已清空")}
              />
            )}
            {section === "settings" && (
              <SettingsView
                snapshot={snapshot}
                busy={busy}
                onRefresh={load}
                onSave={(settings) => mutate(async () => api.updateSettings(settings), "设置已保存")}
                onPasswordChange={changeAdminPassword}
                onThemeChange={(themeId) => {
                  setSnapshot((current) => (current ? { ...current, settings: { ...current.settings, themeId } } : current));
                  mutate(async () => api.updateSettings({ themeId }), "主题已切换");
                }}
              />
            )}
            {section === "docs" && <DocsView snapshot={snapshot} onCopy={copyText} />}
              </div>
            </div>
            <div className={`app-scrollbar-float ${appScrollbarVisible && appScrollbarThumb.scrollable ? "app-scrollbar-float-visible" : ""}`}>
              <div
                className="app-scrollbar-thumb"
                style={{
                  height: `${appScrollbarThumb.height}px`,
                  transform: `translateY(${appScrollbarThumb.top}px)`
                }}
              />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function RoutesView(props: {
  snapshot: AppSnapshot;
  draft: RouteDraft;
  editorOpen: boolean;
  selectedSite?: Site;
  selectedSiteModels: string[];
  onDraft: (value: RouteDraft) => void;
  onSite: (siteId: string) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  onDelete: (id: string) => void;
  onEdit: (route: RouteRecord) => void;
  onQuickSave: (route: Partial<SwitchRoute>) => Promise<void>;
  onCopy: (value: string) => void;
}) {
  const switchRoutes = props.snapshot.routes.filter((route): route is SwitchRoute => route.type === "switch");
  const groupRoutes = props.snapshot.routes.filter((route): route is GroupRoute => route.type === "group");
  const routeCount = switchRoutes.length + groupRoutes.length;
  const modelOptions = providerModelOptions(props.snapshot);
  const enabledModelOptions = modelOptions.filter((option) => option.enabled);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [quickDrafts, setQuickDrafts] = useState<Record<string, Partial<SwitchRoute>>>({});
  const routeDraft = (route: SwitchRoute) => ({ ...route, ...(quickDrafts[route.id] || {}) });
  const updateRouteDraft = (route: SwitchRoute, patch: Partial<SwitchRoute>) => {
    setQuickDrafts((current) => ({
      ...current,
      [route.id]: {
        ...(current[route.id] || route),
        ...patch
      }
    }));
  };
  const updateRouteSite = (route: SwitchRoute, siteId: string) => {
    const site = props.snapshot.sites.find((item) => item.id === siteId);
    const models = siteModels(site);
    updateRouteDraft(route, {
      siteId,
      model: models[0] || ""
    });
  };
  const saveQuickRoute = async (route: SwitchRoute) => {
    const next = routeDraft(route);
    await props.onQuickSave(next);
    setQuickDrafts((current) => {
      const { [route.id]: _saved, ...rest } = current;
      return rest;
    });
  };
  const draftType = props.draft.type || "switch";
  const changeDraftType = (type: RouteType) => {
    if (type === draftType) return;
    const next = emptyRoute(props.snapshot, type);
    props.onDraft({
      ...next,
      id: props.draft.id,
      name: props.draft.name || next.name,
      endpoint: props.draft.endpoint || next.endpoint,
      headerTemplateId: props.draft.headerTemplateId || next.headerTemplateId,
      enabled: props.draft.enabled ?? true
    });
  };
  const switchModelOptions = mergeModelOptions([props.draft.model], props.selectedSiteModels);
  const draftMembers = props.draft.members || [];
  const selectedGroupKeys = new Set(draftMembers.map(groupMemberKey));
  const selectedAvailableCount = modelOptions.filter((option) => selectedGroupKeys.has(groupMemberKey(option))).length;
  const groupedModelOptions = props.snapshot.providerApiKeyGroups
    .map((group) => {
      const site = props.snapshot.sites.find((item) => item.id === group.siteId);
      const apiKeys = group.apiKeys
        .map((apiKey) => ({
          apiKey,
          options: modelOptions.filter((option) => option.siteId === group.siteId && option.apiKeyId === apiKey.id)
        }))
        .filter((item) => item.options.length > 0);
      return {
        siteId: group.siteId,
        siteName: site?.name || group.groupName,
        apiKeys
      };
    })
    .filter((group) => group.apiKeys.length > 0);
  const updateGroupMembers = (members: GroupRouteMember[]) => {
    props.onDraft({ ...props.draft, type: "group", members: uniqueMembers(members) });
  };
  const toggleGroupMember = (option: ProviderModelOption, checked: boolean) => {
    const optionKey = groupMemberKey(option);
    updateGroupMembers(checked ? [...draftMembers, optionToMember(option)] : draftMembers.filter((member) => groupMemberKey(member) !== optionKey));
  };
  const applyRuleSelection = () => {
    const rule = (props.draft.matchRule || props.draft.name || "").trim();
    const matched = enabledModelOptions.filter((option) => modelMatchesRule(option.model, rule)).map(optionToMember);
    props.onDraft({ ...props.draft, type: "group", matchRule: rule, members: uniqueMembers([...draftMembers, ...matched]) });
  };
  const applySmartSelection = () => {
    const query = (props.draft.matchRule || props.draft.name || "").trim();
    const matched = enabledModelOptions.filter((option) => smartModelMatches(option.model, query)).map(optionToMember);
    props.onDraft({ ...props.draft, type: "group", matchRule: props.draft.matchRule || query, members: uniqueMembers([...draftMembers, ...matched]) });
  };
  const clearGroupSelection = () => updateGroupMembers([]);
  const canSaveRoute = draftType !== "group" || selectedAvailableCount > 0 || Boolean(props.draft.matchRule?.trim());
  return (
    <>
      {routeCount === 0 ? (
        <div className="center-empty">暂无路由</div>
      ) : (
        <div className="grid gap-4">
        {switchRoutes.length > 0 ? (
        <section className="panel p-4">
          <div className="form-head">
            <div>
              <h2>切换型路由</h2>
              <div className="mt-1 text-xs font-bold text-ink/55">{switchRoutes.length} 条路由</div>
            </div>
          </div>
          <div className="site-list">
            {switchRoutes.map((route) => {
              const site = props.snapshot.sites.find((item) => item.id === route.siteId);
              const quick = routeDraft(route);
              const quickSite = props.snapshot.sites.find((item) => item.id === quick.siteId) || site;
              const models = siteModels(quickSite);
              const modelOptions = mergeModelOptions([quick.model], models);
              const isOpen = Boolean(expanded[route.id]);
              const hasChanges =
                quick.siteId !== route.siteId ||
                quick.model !== route.model ||
                quick.endpoint !== route.endpoint ||
                quick.headerTemplateId !== route.headerTemplateId ||
                quick.enabled !== route.enabled;
              const toggleRoute = () => setExpanded((current) => ({ ...current, [route.id]: !isOpen }));
              return (
                <article
                  key={route.id}
                  className={`record route-record ${isOpen ? "route-record-open" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  onClick={toggleRoute}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    toggleRoute();
                  }}
                >
                  <div className="route-record-main">
                    <div className="min-w-0">
                      <div className="route-title-line">
                        <span className="route-expand-indicator">
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </span>
                        <span className="record-title">{route.name}</span>
                      </div>
                      <div className="record-meta">
                        {site?.name} / 目标模型 {route.model} / {endpointLabels[route.endpoint]}
                      </div>
                    </div>
                  </div>
                  <div
                    className="record-actions route-record-actions"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <ActionButton tone="ghost" title="复制模型名" onClick={() => props.onCopy(route.name)}>
                      <Copy className="h-4 w-4" />
                    </ActionButton>
                    <ActionButton tone="ghost" onClick={() => props.onEdit(route)} title="编辑">
                      <Wand2 className="h-4 w-4" />
                    </ActionButton>
                    <ActionButton tone="danger" onClick={() => props.onDelete(route.id)} title="删除">
                      <Trash2 className="h-4 w-4" />
                    </ActionButton>
                  </div>
                  {isOpen ? (
                    <div
                      className="route-quick-panel"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <div className="route-quick-grid">
                        <label className="route-quick-control">
                          <span className="route-quick-label">供应商</span>
                          <SelectInput value={quick.siteId || ""} onChange={(event) => updateRouteSite(route, event.target.value)}>
                            <option value="">选择供应商</option>
                            {props.snapshot.sites.map((siteOption) => (
                              <option key={siteOption.id} value={siteOption.id}>
                                {siteOption.name}
                              </option>
                            ))}
                          </SelectInput>
                        </label>
                        <label className="route-quick-control">
                          <span className="route-quick-label">快捷切换模型</span>
                          <SelectInput
                            value={quick.model || ""}
                            disabled={modelOptions.length === 0}
                            onChange={(event) => updateRouteDraft(route, { model: event.target.value })}
                          >
                            {modelOptions.length === 0 ? <option value="">暂无可选模型</option> : null}
                            {modelOptions.map((model) => (
                              <option key={model} value={model}>
                                {model}
                              </option>
                            ))}
                          </SelectInput>
                        </label>
                        <div className="route-quick-control">
                          <span className="route-quick-label">可用模型</span>
                          <div className="route-quick-body route-quick-stat">
                            <strong>{models.length} 个</strong>
                          </div>
                        </div>
                        <label className="route-quick-control">
                          <span className="route-quick-label">Endpoint</span>
                          <SelectInput
                            value={quick.endpoint || route.endpoint}
                            onChange={(event) => updateRouteDraft(route, { endpoint: event.target.value as EndpointKind })}
                          >
                            {props.snapshot.endpoints.map((endpoint) => (
                              <option key={endpoint} value={endpoint}>
                                {endpointLabels[endpoint]}
                              </option>
                            ))}
                          </SelectInput>
                        </label>
                        <label className="route-quick-control">
                          <span className="route-quick-label">Header 模版</span>
                          <SelectInput
                            value={quick.headerTemplateId || ""}
                            onChange={(event) => updateRouteDraft(route, { headerTemplateId: event.target.value || undefined })}
                          >
                            <option value="">不使用</option>
                            {props.snapshot.headerTemplates.map((template) => (
                              <option key={template.id} value={template.id}>
                                {template.name}
                              </option>
                            ))}
                          </SelectInput>
                        </label>
                        <label className="route-quick-control">
                          <span className="route-quick-label">状态</span>
                          <span className="route-quick-body route-quick-toggle">
                            <input
                              type="checkbox"
                              checked={quick.enabled ?? true}
                              onChange={(event) => updateRouteDraft(route, { enabled: event.target.checked })}
                            />
                            启用
                          </span>
                        </label>
                      </div>
                      <div className="route-quick-actions">
                        <ActionButton
                          tone="ghost"
                          disabled={!hasChanges}
                          onClick={() =>
                            setQuickDrafts((current) => {
                              const { [route.id]: _discarded, ...rest } = current;
                              return rest;
                            })
                          }
                        >
                          还原
                        </ActionButton>
                        <ActionButton disabled={!hasChanges || !quick.model} onClick={() => saveQuickRoute(route)}>
                          <Save className="h-4 w-4" />
                          保存切换
                        </ActionButton>
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
        ) : null}
        {groupRoutes.length > 0 ? (
          <section className="panel p-4">
            <div className="form-head">
              <div>
                <h2>分组型路由</h2>
                <div className="mt-1 text-xs font-bold text-ink/55">{groupRoutes.length} 条路由</div>
              </div>
            </div>
            <div className="site-list">
              {groupRoutes.map((route) => {
                const stats = groupRouteStats(props.snapshot, route);
                const memberGroups = groupRouteMemberGroups(props.snapshot, route);
                const headerTemplate = route.headerTemplateId
                  ? props.snapshot.headerTemplates.find((template) => template.id === route.headerTemplateId)
                  : undefined;
                const isOpen = Boolean(expanded[route.id]);
                const toggleRoute = () => setExpanded((current) => ({ ...current, [route.id]: !isOpen }));
                return (
                  <article
                    key={route.id}
                    className={`record route-record group-route-record ${isOpen ? "route-record-open" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-expanded={isOpen}
                    onClick={toggleRoute}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      toggleRoute();
                    }}
                  >
                    <div className="route-record-main">
                      <div className="min-w-0">
                        <div className="route-title-line">
                          <span className="route-expand-indicator">
                            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </span>
                          <span className="record-title">{route.name}</span>
                        </div>
                        <div className="record-meta">
                          关键词 {route.matchRule || "-"} / {groupStrategyLabels[route.strategy]} / {endpointLabels[route.endpoint]}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <span className="pill">{stats.providerCount} 个供应商</span>
                          <span className="pill">{stats.keyCount} 个 Key</span>
                          <span className="pill">{stats.modelCount} 个模型</span>
                          <span className="pill">{route.enabled ? "已启用" : "已停用"}</span>
                        </div>
                        {stats.models.length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {stats.models.slice(0, 6).map((model) => (
                              <span key={model} className="pill pill-muted">
                                {model}
                              </span>
                            ))}
                            {stats.models.length > 6 ? <span className="pill pill-muted">+{stats.models.length - 6}</span> : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div
                      className="record-actions route-record-actions"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <ActionButton tone="ghost" title="复制模型名" onClick={() => props.onCopy(route.name)}>
                        <Copy className="h-4 w-4" />
                      </ActionButton>
                      <ActionButton tone="ghost" onClick={() => props.onEdit(route)} title="编辑">
                        <Wand2 className="h-4 w-4" />
                      </ActionButton>
                      <ActionButton tone="danger" onClick={() => props.onDelete(route.id)} title="删除">
                        <Trash2 className="h-4 w-4" />
                      </ActionButton>
                    </div>
                    {isOpen ? (
                      <div
                        className="route-detail-panel group-route-detail"
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <div className="group-route-summary">
                          <div>
                            <span>匹配关键词</span>
                            <strong>{route.matchRule || "-"}</strong>
                          </div>
                          <div>
                            <span>调用策略</span>
                            <strong>{groupStrategyLabels[route.strategy]}</strong>
                          </div>
                          <div>
                            <span>Header 模版</span>
                            <strong>{headerTemplate?.name || "不使用"}</strong>
                          </div>
                          <div>
                            <span>Endpoint</span>
                            <strong>{endpointLabels[route.endpoint]}</strong>
                          </div>
                        </div>
                        <div className="group-route-members">
                          <div className="group-route-members-head">
                            <strong>组内模型详情</strong>
                            <span>
                              {stats.providerCount} 个供应商 / {stats.keyCount} 个 Key / {stats.modelCount} 个模型
                            </span>
                          </div>
                          {memberGroups.length === 0 ? (
                            <div className="group-route-empty">暂无可用组内模型</div>
                          ) : (
                            <div className="group-route-member-list">
                              {memberGroups.map((provider) => (
                                <div key={provider.siteId} className="group-route-member-provider">
                                  <div className="group-route-provider-name">{provider.siteName}</div>
                                  {provider.apiKeys.map((apiKey) => (
                                    <div key={apiKey.apiKeyId} className="group-route-member-key">
                                      <div className="group-route-key-name">{apiKey.apiKeyLabel}</div>
                                      <div className="group-route-models">
                                        {apiKey.models.map((model) => (
                                          <span key={model} className="pill pill-muted">
                                            {model}
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}
        </div>
      )}

      {props.editorOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form onSubmit={props.onSubmit} className="modal-panel route-modal-panel" role="dialog" aria-modal="true" aria-label="路由编辑">
            <div className="form-head route-modal-head">
              <h2>{props.draft.id ? "编辑路由" : "新增路由"}</h2>
              <ActionButton type="button" tone="ghost" onClick={props.onClose} title="关闭">
                <X className="h-4 w-4" />
              </ActionButton>
            </div>
            <div className="route-modal-body">
              <div className="form-grid">
                <label>
                  路由名称
                  <TextInput value={props.draft.name || ""} onChange={(event) => props.onDraft({ ...props.draft, name: event.target.value })} />
                </label>
                <label>
                  路由类型
                  <SelectInput value={draftType} onChange={(event) => changeDraftType(event.target.value as RouteType)}>
                    <option value="switch">{routeTypeLabels.switch}</option>
                    <option value="group">{routeTypeLabels.group}</option>
                  </SelectInput>
                </label>
                {draftType === "switch" ? (
                  <>
                    <label>
                      供应商
                      <SelectInput value={props.draft.siteId || ""} onChange={(event) => props.onSite(event.target.value)}>
                        <option value="">选择供应商</option>
                        {props.snapshot.sites.map((site) => (
                          <option key={site.id} value={site.id}>
                            {site.name}
                          </option>
                        ))}
                      </SelectInput>
                    </label>
                    <label>
                      模型
                      <SelectInput
                        value={props.draft.model || ""}
                        disabled={switchModelOptions.length === 0}
                        onChange={(event) => props.onDraft({ ...props.draft, model: event.target.value })}
                      >
                        {switchModelOptions.length === 0 ? <option value="">请先选择供应商</option> : null}
                        {switchModelOptions.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </SelectInput>
                    </label>
                  </>
                ) : (
                  <>
                    <label className="form-span-2">
                      匹配关键词
                      <div className="group-rule-row">
                        <TextInput
                          value={props.draft.matchRule || ""}
                          placeholder="请输入关键词"
                          onChange={(event) => props.onDraft({ ...props.draft, type: "group", matchRule: event.target.value })}
                        />
                        <ActionButton type="button" tone="ghost" disabled={!props.draft.matchRule?.trim()} onClick={applyRuleSelection}>
                          前缀勾选
                        </ActionButton>
                        <ActionButton
                          type="button"
                          tone="ghost"
                          disabled={!(props.draft.matchRule || props.draft.name)?.trim()}
                          onClick={applySmartSelection}
                        >
                          <Wand2 className="h-4 w-4" />
                          智能勾选
                        </ActionButton>
                      </div>
                    </label>
                    <label>
                      调用策略
                      <SelectInput
                        value={props.draft.strategy || "stable-first"}
                        onChange={(event) => props.onDraft({ ...props.draft, type: "group", strategy: event.target.value as GroupRouteStrategy })}
                      >
                        <option value="stable-first">{groupStrategyLabels["stable-first"]}</option>
                        <option value="sequential">{groupStrategyLabels.sequential}</option>
                        <option value="random">{groupStrategyLabels.random}</option>
                      </SelectInput>
                    </label>
                    <div className="group-model-picker form-span-2">
                      <div className="group-model-head">
                        <div>
                          <strong>组内模型</strong>
                          <span>
                            已选 {selectedAvailableCount} / 可用 {enabledModelOptions.length}
                          </span>
                        </div>
                        <ActionButton type="button" tone="ghost" disabled={selectedAvailableCount === 0} onClick={clearGroupSelection}>
                          清空
                        </ActionButton>
                      </div>
                      {modelOptions.length === 0 ? (
                        <div className="group-model-empty">暂无可选模型</div>
                      ) : (
                        <div className="group-model-list">
                          {groupedModelOptions.map((provider) => (
                            <div key={provider.siteId} className="group-model-provider">
                              <div className="group-model-provider-title">{provider.siteName}</div>
                              {provider.apiKeys.map(({ apiKey, options }) => (
                                <div key={apiKey.id} className="group-model-key">
                                  <div className="group-model-key-title">
                                    <span>{apiKey.label}</span>
                                    {!apiKey.enabled ? <span>已停用</span> : null}
                                  </div>
                                  <div className="group-model-options">
                                    {options.map((option) => {
                                      const optionKey = groupMemberKey(option);
                                      const checked = selectedGroupKeys.has(optionKey);
                                      return (
                                        <label
                                          key={optionKey}
                                          className={`group-model-option ${checked ? "group-model-option-checked" : ""} ${
                                            option.enabled ? "" : "group-model-option-disabled"
                                          }`}
                                        >
                                          <input
                                            type="checkbox"
                                            checked={checked}
                                            disabled={!option.enabled}
                                            onChange={(event) => toggleGroupMember(option, event.target.checked)}
                                          />
                                          <span>{option.model}</span>
                                        </label>
                                      );
                                    })}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
                <label>
                  Header 模版
                  <SelectInput
                    value={props.draft.headerTemplateId || ""}
                    onChange={(event) => props.onDraft({ ...props.draft, headerTemplateId: event.target.value || undefined })}
                  >
                    <option value="">不使用模版</option>
                    {props.snapshot.headerTemplates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </SelectInput>
                </label>
                <label>
                  Endpoint
                  <SelectInput
                    value={props.draft.endpoint || "messages"}
                    onChange={(event) => props.onDraft({ ...props.draft, endpoint: event.target.value as EndpointKind })}
                  >
                    {props.snapshot.endpoints.map((endpoint) => (
                      <option key={endpoint} value={endpoint}>
                        {endpointLabels[endpoint]}
                      </option>
                    ))}
                  </SelectInput>
                </label>
              </div>
              <label className="toggle-row mt-3">
                <input
                  type="checkbox"
                  checked={props.draft.enabled ?? true}
                  onChange={(event) => props.onDraft({ ...props.draft, enabled: event.target.checked })}
                />
                启用
              </label>
            </div>
            <div className="route-modal-actions">
              <ActionButton type="button" tone="ghost" onClick={props.onClose}>
                取消
              </ActionButton>
              <ActionButton type="submit" disabled={!canSaveRoute}>
                <Save className="h-4 w-4" />
                保存路由
              </ActionButton>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

function SitesView(props: {
  snapshot: AppSnapshot;
  draft: Partial<Site>;
  editorOpen: boolean;
  onDraft: (value: Partial<Site>) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  onEdit: (site: Site) => void;
  onDelete: (id: string) => void;
}) {
  const addresses = props.draft.addresses || [{ ...blankAddress }];
  const updateAddress = (index: number, patch: Partial<SiteAddress>) => {
    props.onDraft({
      ...props.draft,
      addresses: addresses.map((address, itemIndex) => (itemIndex === index ? { ...address, ...patch } : address))
    });
  };
  const removeAddress = (index: number) => {
    if (addresses.length <= 1) return;
    props.onDraft({
      ...props.draft,
      addresses: addresses.filter((_address, itemIndex) => itemIndex !== index)
    });
  };
  return (
    <>
      {props.snapshot.sites.length === 0 ? (
        <div className="center-empty">暂无站点</div>
      ) : (
        <section className="panel p-4">
          <div className="form-head">
            <div>
              <h2>站点列表</h2>
              <div className="mt-1 text-xs font-bold text-ink/55">{props.snapshot.sites.length} 个站点</div>
            </div>
          </div>
        <div className="site-list">
          {props.snapshot.sites.map((site) => (
            <article key={site.id} className="record">
              <div>
                <div className="record-title">{site.name}</div>
                <div className="record-meta">
                  {siteTypeLabels[site.siteType || "unknown"]} / {site.addresses.length} 个地址
                </div>
              </div>
              <div className="record-actions">
                <ActionButton tone="ghost" onClick={() => props.onEdit(site)} title="编辑">
                  <Wand2 className="h-4 w-4" />
                </ActionButton>
                <ActionButton tone="danger" onClick={() => props.onDelete(site.id)} title="删除">
                  <Trash2 className="h-4 w-4" />
                </ActionButton>
              </div>
            </article>
          ))}
        </div>
        </section>
      )}

      {props.editorOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form onSubmit={props.onSubmit} className="modal-panel" role="dialog" aria-modal="true" aria-label="站点编辑">
            <div className="form-head">
              <h2>{props.draft.id ? "编辑站点" : "新增站点"}</h2>
              <ActionButton type="button" tone="ghost" onClick={props.onClose} title="关闭">
                <X className="h-4 w-4" />
              </ActionButton>
            </div>
            <div className="form-grid">
              <label>
                名称
                <TextInput value={props.draft.name || ""} onChange={(event) => props.onDraft({ ...props.draft, name: event.target.value })} />
              </label>
              <label>
                网站类型
                <SelectInput
                  value={props.draft.siteType || "unknown"}
                  onChange={(event) => props.onDraft({ ...props.draft, siteType: event.target.value as SiteType })}
                >
                  <option value="newapi">NewApi</option>
                  <option value="unknown">未知</option>
                </SelectInput>
              </label>
            </div>
            <div className="mt-4 space-y-3">
              {addresses.map((address, index) => (
                <div key={address.id || index} className="address-block">
                  <div className="address-block-head">
                    <div className="text-xs font-black text-ink/55">地址 {index + 1}</div>
                    <ActionButton
                      type="button"
                      tone="danger"
                      title="删除地址"
                      disabled={addresses.length <= 1}
                      onClick={() => removeAddress(index)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </ActionButton>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label>
                      地址名称
                      <TextInput value={address.label} onChange={(event) => updateAddress(index, { label: event.target.value })} />
                    </label>
                    <label>
                      Base URL
                      <TextInput
                        type="url"
                        inputMode="url"
                        placeholder="https://api.example.com/v1"
                        value={address.baseUrl}
                        onChange={(event) => updateAddress(index, { baseUrl: event.target.value })}
                      />
                    </label>
                  </div>
                  <label className="toggle-row mt-3">
                    <input type="checkbox" checked={address.enabled} onChange={(event) => updateAddress(index, { enabled: event.target.checked })} />
                    启用地址
                  </label>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap justify-between gap-2">
              <ActionButton
                type="button"
                tone="ghost"
                onClick={() => props.onDraft({ ...props.draft, addresses: [...addresses, { ...blankAddress, id: "" }] })}
              >
                <Plus className="h-4 w-4" />
                地址
              </ActionButton>
              <div className="flex gap-2">
                <ActionButton type="button" tone="ghost" onClick={props.onClose}>
                  取消
                </ActionButton>
                <ActionButton type="submit">
                  <Save className="h-4 w-4" />
                  保存站点
                </ActionButton>
              </div>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

function ProviderKeysView(props: {
  snapshot: AppSnapshot;
  draft: ProviderKeyGroupDraft;
  editorOpen: boolean;
  busy: boolean;
  modelSyncing: boolean;
  modelDiscoveringIndex: number | null;
  modelGroupOptions: Record<number, ProviderModelGroupOption[]>;
  onDraft: (value: ProviderKeyGroupDraft) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  onDiscoverModels: (index: number) => void;
  onSyncModels: () => void;
  onEdit: (group: ProviderApiKeyGroupView) => void;
  onDelete: (id: string) => void;
}) {
  const groups = props.snapshot.providerApiKeyGroups;
  const selectedSite = props.snapshot.sites.find((site) => site.id === props.draft.siteId);
  const updateApiKey = (index: number, patch: Partial<ProviderApiKeyDraft>) => {
    props.onDraft({
      ...props.draft,
      apiKeys: props.draft.apiKeys.map((apiKey, itemIndex) => (itemIndex === index ? { ...apiKey, ...patch } : apiKey))
    });
  };
  const addApiKey = () => {
    props.onDraft({
      ...props.draft,
      apiKeys: [
        ...props.draft.apiKeys,
        { label: `Key ${props.draft.apiKeys.length + 1}`, secret: "", enabled: true, models: [] }
      ]
    });
  };
  const removeApiKey = (index: number) => {
    if (props.draft.apiKeys.length <= 1) return;
    props.onDraft({
      ...props.draft,
      apiKeys: props.draft.apiKeys.filter((_apiKey, itemIndex) => itemIndex !== index)
    });
  };

  return (
    <>
      {groups.length === 0 ? (
        <div className="center-empty">暂无 API Key 分组</div>
      ) : (
        <section className="panel p-4">
          <div className="form-head">
            <div>
              <h2>API Key 分组</h2>
              <div className="mt-1 text-xs font-bold text-ink/55">{groups.length} 个分组</div>
            </div>
            <ActionButton type="button" tone="ghost" disabled={props.modelSyncing || groups.length === 0} onClick={props.onSyncModels}>
              <RefreshCw className={`h-4 w-4 ${props.modelSyncing ? "animate-spin" : ""}`} />
              同步模型
            </ActionButton>
          </div>
          <div className="site-list">
            {groups.map((group) => (
              <ProviderKeyGroupRecord
                key={group.id}
                group={group}
                siteName={props.snapshot.sites.find((site) => site.id === group.siteId)?.name || "未知供应商"}
                onEdit={props.onEdit}
                onDelete={props.onDelete}
              />
            ))}
          </div>
        </section>
      )}

      {props.editorOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form onSubmit={props.onSubmit} className="modal-panel" role="dialog" aria-modal="true" aria-label="API Key 分组编辑">
            <div className="form-head">
              <div>
                <h2>{props.draft.id ? "编辑 API Key 分组" : "新增 API Key 分组"}</h2>
                <div className="mt-1 text-xs font-bold text-ink/55">{selectedSite?.name || "请选择供应商"}</div>
              </div>
              <ActionButton type="button" tone="ghost" onClick={props.onClose} title="关闭">
                <X className="h-4 w-4" />
              </ActionButton>
            </div>
            <label className="block">
              供应商
              <SelectInput
                value={props.draft.siteId}
                onChange={(event) => {
                  const site = props.snapshot.sites.find((item) => item.id === event.target.value);
                  props.onDraft({ ...props.draft, siteId: event.target.value, groupName: site?.name || "" });
                }}
              >
                <option value="">选择供应商</option>
                {props.snapshot.sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </SelectInput>
            </label>

            <div className="mt-4 space-y-3">
              {props.draft.apiKeys.map((apiKey, index) => (
                <div key={apiKey.id || index} className="address-block">
                  <div className="address-block-head">
                    <div className="text-xs font-black text-ink/55">API Key {index + 1}</div>
                    <ActionButton
                      type="button"
                      tone="danger"
                      title="删除 API Key"
                      disabled={props.draft.apiKeys.length <= 1}
                      onClick={() => removeApiKey(index)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </ActionButton>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label>
                      名称
                      <TextInput value={apiKey.label} onChange={(event) => updateApiKey(index, { label: event.target.value })} />
                    </label>
                    <label>
                      API Key
                      <TextInput
                        type="password"
                        value={apiKey.secret}
                        placeholder="sk-..."
                        onChange={(event) => updateApiKey(index, { secret: event.target.value })}
                      />
                    </label>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <label className="toggle-row">
                      <input type="checkbox" checked={apiKey.enabled} onChange={(event) => updateApiKey(index, { enabled: event.target.checked })} />
                      启用
                    </label>
                    <ActionButton
                      type="button"
                      tone="ghost"
                      disabled={props.modelDiscoveringIndex !== null}
                      onClick={() => props.onDiscoverModels(index)}
                    >
                      <RefreshCw className={`h-4 w-4 ${props.modelDiscoveringIndex === index ? "animate-spin" : ""}`} />
                      获取模型
                    </ActionButton>
                  </div>
                  {props.modelGroupOptions[index]?.length > 0 ? (
                    <div className="provider-model-group-options">
                      <div className="provider-model-group-title">接口返回了可用分组，选择一个填入模型列表</div>
                      <div className="provider-model-group-list">
                        {props.modelGroupOptions[index].map((group) => (
                          <button key={group.groupName} type="button" onClick={() => updateApiKey(index, { label: group.groupName, models: group.models, lastCheckedAt: new Date().toISOString() })}>
                            <span>{group.groupName}</span>
                            <strong>{group.models.length} 个模型</strong>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <label className="mt-3 block">
                    模型列表（可手动输入）
                    <textarea
                      className="field"
                      rows={Math.max(3, Math.min(8, apiKey.models.length || 3))}
                      value={serializeModelText(apiKey.models)}
                      placeholder="自动获取失败时可手动填写，例如：\ngpt-4.1\ngpt-4.1-mini"
                      onChange={(event) => updateApiKey(index, { models: parseModelText(event.target.value) })}
                    />
                    <span className="field-hint">支持换行、逗号、空格分隔；保存后会同步到该供应商的可选模型。</span>
                  </label>
                  {apiKey.models.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {apiKey.models.slice(0, 24).map((model) => (
                        <span key={model} className="pill">
                          {model}
                        </span>
                      ))}
                      {apiKey.models.length > 24 ? <span className="pill">+{apiKey.models.length - 24}</span> : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap justify-between gap-2">
              <ActionButton type="button" tone="ghost" onClick={addApiKey}>
                <Plus className="h-4 w-4" />
                API Key
              </ActionButton>
              <div className="flex gap-2">
                <ActionButton type="button" tone="ghost" onClick={props.onClose}>
                  取消
                </ActionButton>
                <ActionButton type="submit">
                  <Save className="h-4 w-4" />
                  保存分组
                </ActionButton>
              </div>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

function ProviderKeyGroupRecord(props: {
  group: ProviderApiKeyGroupView;
  siteName: string;
  onEdit: (group: ProviderApiKeyGroupView) => void;
  onDelete: (id: string) => void;
}) {
  const models = Array.from(new Set(props.group.apiKeys.flatMap((apiKey) => apiKey.models))).sort();
  return (
    <article className="record">
      <div className="min-w-0">
        <div className="record-title">{props.siteName}</div>
        <div className="record-meta">
          {props.group.apiKeys.length} 个 Key / {models.length} 个模型
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {props.group.apiKeys.map((apiKey) => (
            <span key={apiKey.id} className="pill">
              {apiKey.label}: {apiKey.prefix}...
            </span>
          ))}
        </div>
        {models.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {models.slice(0, 18).map((model) => (
              <span key={model} className="pill">
                {model}
              </span>
            ))}
            {models.length > 18 ? <span className="pill">+{models.length - 18}</span> : null}
          </div>
        ) : null}
      </div>
      <div className="record-actions">
        <ActionButton tone="ghost" onClick={() => props.onEdit(props.group)} title="编辑">
          <Wand2 className="h-4 w-4" />
        </ActionButton>
        <ActionButton tone="danger" onClick={() => props.onDelete(props.group.id)} title="删除">
          <Trash2 className="h-4 w-4" />
        </ActionButton>
      </div>
    </article>
  );
}

function TemporaryAccountsView(props: {
  snapshot: AppSnapshot;
  draft: TemporaryAccountImportDraft;
  editorOpen: boolean;
  busy: boolean;
  loading: boolean;
  error: string;
  checking: string | null;
  deleting: string | null;
  selectedAccountIds: string[];
  onSelectedAccountIds: (ids: string[]) => void;
  onDraft: (value: TemporaryAccountImportDraft) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  onCheck: () => void;
  onRetry: () => void;
  onStrategyChange: (strategy: GroupRouteStrategy) => void;
  onDeleteAccount: (id: string) => void;
  onDeleteSelected: () => void;
}) {
  const groups = props.snapshot.temporaryAccountGroups || [];
  const openAiSite = props.snapshot.sites.find((site) => site.addresses.some((address) => address.baseUrl.includes("api.openai.com")));
  const totalAccounts = groups.reduce((total, group) => total + group.accounts.length, 0);
  const totalAvailabilityStats = temporaryAccountAvailabilityStats(groups.flatMap((group) => group.accounts));
  const selectedAccountIdSet = new Set(props.selectedAccountIds);
  const temporaryAccountStrategy = props.snapshot.settings.temporaryAccountStrategy || "sequential";
  const hasImportContent = props.draft.content.trim() || props.draft.contents.some((content) => content.trim());
  const readImportFiles = async (files?: FileList | null) => {
    const selectedFiles = Array.from(files || []);
    if (selectedFiles.length === 0) return;
    const contents = await Promise.all(selectedFiles.map((file) => file.text()));
    props.onDraft({
      ...props.draft,
      contents,
      fileNames: selectedFiles.map((file) => file.name),
      name: props.draft.name || selectedFiles[0]?.name.replace(/\.[^.]+$/, "") || ""
    });
  };
  return (
    <>
      {props.loading ? (
        <div className="center-empty">
          <RefreshCw className="h-4 w-4 animate-spin" />
          正在加载临时账号...
        </div>
      ) : props.error ? (
        <div className="center-empty center-empty-stack" role="alert">
          <div className="center-empty-title">临时账号加载失败</div>
          <div className="center-empty-description">{props.error}</div>
          <ActionButton type="button" tone="ghost" onClick={props.onRetry}>
            <RefreshCw className="h-4 w-4" />
            重试
          </ActionButton>
        </div>
      ) : groups.length === 0 ? (
        <section className="temp-account-empty panel">
          <div className="temp-account-empty-mark"><Upload className="h-5 w-5" /></div>
          <div>
            <h2>暂无临时账号</h2>
            <p>选择 GPT、Grok、Claude 或 Gemini 类型后导入 Sub2API / CPA 数据。</p>
          </div>
        </section>
      ) : (
        <section className="temp-account-surface panel">
          <div className="temp-account-overview">
            <div>
              <h2>临时账号池</h2>
              <p>{groups.length} 个类型 / {totalAccounts} 个账号 / {openAiSite?.name || "OpenAI"}</p>
            </div>
            <div className="temp-account-stats" aria-label="临时账号状态统计">
              <span><strong>{totalAvailabilityStats.available}</strong>可用</span>
              <span><strong>{totalAvailabilityStats.unavailable}</strong>不可用</span>
              <span><strong>{totalAvailabilityStats.unknown}</strong>未检查</span>
            </div>
          </div>
          <div className="temp-account-toolbar">
              <ActionButton type="button" tone="ghost" disabled={props.checking !== null || totalAccounts === 0} onClick={() => props.onCheck()}>
                <RefreshCw className={`h-4 w-4 ${props.checking === "all" ? "animate-spin" : ""}`} />
                检查 GPT
              </ActionButton>
              <ActionButton type="button" tone="danger" disabled={props.deleting !== null || props.selectedAccountIds.length === 0} onClick={props.onDeleteSelected}>
                <Trash2 className="h-4 w-4" />
                删除选中{props.selectedAccountIds.length > 0 ? ` ${props.selectedAccountIds.length}` : ""}
              </ActionButton>
            <label className="temp-account-strategy">
              <span>全局复用策略</span>
              <SelectInput value={temporaryAccountStrategy} onChange={(event) => props.onStrategyChange(event.target.value as GroupRouteStrategy)}>
                <option value="stable-first">{groupStrategyLabels["stable-first"]}</option>
                <option value="sequential">{groupStrategyLabels.sequential}</option>
                <option value="random">{groupStrategyLabels.random}</option>
              </SelectInput>
            </label>
          </div>
          <div className="temp-account-groups">
            {groups.map((group) => {
              const availabilityStats = temporaryAccountAvailabilityStats(group.accounts);
              const models = Array.from(new Set(group.accounts.flatMap((account) => account.models))).sort();
              return (
                <article key={group.id} className="temp-account-group-card">
                  <div className="temp-account-group-head">
                    <div>
                      <div className="record-title">{temporaryAccountProviderLabels[group.providerType || "gpt"]}</div>
                      <div className="record-meta">
                        {group.accounts.length} 个账号 / {availabilityStats.available} 可用 / {availabilityStats.unavailable} 不可用 / {availabilityStats.unknown} 未检查
                      </div>
                    </div>
                    <span className="temp-account-type-badge">{temporaryAccountProviderLabels[group.providerType || "gpt"]}</span>
                  </div>
                  <div className="min-w-0">
                    <div className="temp-account-list">
                      {group.accounts.map((account) => {
                        const availability = account.availability || "unknown";
                        return (
                          <div key={account.id} className={`temp-account-row temp-account-row-${availability}`}>
                            <div className="temp-account-row-main">
                              <div className="temp-account-row-title">
                                <input
                                  type="checkbox"
                                  checked={selectedAccountIdSet.has(account.id)}
                                  onChange={(event) =>
                                    props.onSelectedAccountIds(
                                      event.target.checked
                                        ? [...props.selectedAccountIds, account.id]
                                        : props.selectedAccountIds.filter((id) => id !== account.id)
                                    )
                                  }
                                  aria-label={`选择 ${account.label}`}
                                />
                                <span className={`account-status account-status-${availability}`}>
                                  {temporaryAccountAvailabilityLabels[availability]}
                                </span>
                                <span className="temp-account-name">{account.label}</span>
                                <button className="temp-account-delete" type="button" disabled={props.deleting !== null} onClick={() => props.onDeleteAccount(account.id)} title="删除账号">
                                  {props.deleting === account.id ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                                </button>
                              </div>
                              <div className="temp-account-secret">
                                {temporaryAccountTypeLabel(account)} / {account.prefix}...
                                {account.email ? ` / ${account.email}` : ""}
                                {account.accountId ? ` / ${account.accountId}` : ""}
                                {account.lastCheckStatusCode ? ` / HTTP ${account.lastCheckStatusCode}` : ""}
                              </div>
                              {account.quotaStages.length > 0 ? (
                                <div className="temp-account-quota-list">
                                  {account.quotaStages.slice(0, 5).map((stage, index) => {
                                    const percent = temporaryAccountQuotaPercent(stage);
                                    return (
                                      <div key={`${account.id}-${stage.label}-${index}`} className={`temp-account-quota temp-account-quota-${availability}`} title={temporaryAccountQuotaText(stage)}>
                                        <div className="temp-account-quota-head">
                                          <span>{stage.label}</span>
                                          <strong>{formatQuotaPercent(percent)}</strong>
                                        </div>
                                        <div className="temp-account-quota-track" aria-label={temporaryAccountQuotaText(stage)}>
                                          <div className="temp-account-quota-fill" style={{ width: `${percent ?? 0}%` }} />
                                        </div>
                                        <div className="temp-account-quota-text">{temporaryAccountQuotaText(stage)}</div>
                                      </div>
                                    );
                                  })}
                                  {account.quotaStages.length > 5 ? <span className="temp-account-quota-more">+{account.quotaStages.length - 5} 项</span> : null}
                                </div>
                              ) : null}
                              {account.lastCheckError ? <div className="temp-account-error">{account.lastCheckError}</div> : null}
                            </div>
                            <div className="temp-account-last-check">
                              {account.lastQuotaCheckedAt ? formatTime(account.lastQuotaCheckedAt) : "未检查"}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {models.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {models.slice(0, 12).map((model) => (
                          <span key={model} className="pill pill-muted">
                            {model}
                          </span>
                        ))}
                        {models.length > 12 ? <span className="pill pill-muted">+{models.length - 12}</span> : null}
                      </div>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {props.editorOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form onSubmit={props.onSubmit} className="modal-panel temp-account-modal" role="dialog" aria-modal="true" aria-label="临时账号导入">
            <div className="form-head">
              <div>
                <h2>导入临时账号</h2>
                <div className="mt-1 text-xs font-bold text-ink/55">导入后用于官方 OpenAI 切换型路由</div>
              </div>
              <ActionButton type="button" tone="ghost" onClick={props.onClose} title="关闭">
                <X className="h-4 w-4" />
              </ActionButton>
            </div>
            <div className="form-grid">
              <label>
                账号类型
                <SelectInput value={props.draft.providerType} onChange={(event) => props.onDraft({ ...props.draft, providerType: event.target.value as TemporaryAccountProviderType, name: `${temporaryAccountProviderLabels[event.target.value as TemporaryAccountProviderType]} 临时账号` })}>
                  <option value="gpt">{temporaryAccountProviderLabels.gpt}</option>
                  <option value="grok">{temporaryAccountProviderLabels.grok}</option>
                  <option value="claude">{temporaryAccountProviderLabels.claude}</option>
                  <option value="gemini">{temporaryAccountProviderLabels.gemini}</option>
                </SelectInput>
              </label>
              <label>
                数据格式
                <TextInput value="自动识别 CPA / Sub2API / JSONL / 纯 token" disabled />
                <span className="field-hint">无需手动选择，导入时会自动解析支持的账号格式。</span>
              </label>
              <label className="form-span-2">
                导入文件
                <input className="field" type="file" accept=".json,.jsonl,.txt,.csv" multiple onChange={(event) => readImportFiles(event.target.files)} />
                {props.draft.fileNames.length > 0 ? <span className="field-hint">已选择 {props.draft.fileNames.length} 个文件：{props.draft.fileNames.join("，")}</span> : null}
              </label>
              <label className="form-span-2">
                账号数据
                <textarea
                  className="field temp-account-textarea"
                  value={props.draft.content}
                  placeholder="支持 CPA/SubAPI JSON、JSONL、CSV 或每行一个 sk-/token"
                  onChange={(event) => props.onDraft({ ...props.draft, content: event.target.value })}
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <ActionButton type="button" tone="ghost" onClick={props.onClose}>
                取消
              </ActionButton>
              <ActionButton type="submit" disabled={props.busy || !hasImportContent}>
                <Upload className="h-4 w-4" />
                导入账号
              </ActionButton>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

function KeysView(props: {
  snapshot: AppSnapshot;
  keyName: string;
  editorOpen: boolean;
  createdKey: ApiKeyCreated | null;
  onKeyName: (value: string) => void;
  onCreate: () => void;
  onClose: () => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onCopy: (value: string) => void;
}) {
  return (
    <>
      {props.snapshot.apiKeys.length === 0 ? (
        <div className="center-empty">暂无密钥</div>
      ) : (
        <section className="panel p-4">
          <div className="form-head">
            <div>
              <h2>密钥列表</h2>
              <div className="mt-1 text-xs font-bold text-ink/55">{props.snapshot.apiKeys.length} 个密钥</div>
            </div>
          </div>
          <div className="site-list">
            {props.snapshot.apiKeys.map((key) => {
              const fullKey = key.plainTextKey || "";
              return (
                <article key={key.id} className="record">
                  <div className="min-w-0">
                    <div className="record-title">{key.name}</div>
                    <div className="record-meta break-all">{fullKey || `${key.prefix}...（完整密钥仅生成时显示）`}</div>
                  </div>
                  <div className="record-actions">
                    <label className="toggle-row">
                      <input type="checkbox" checked={key.enabled} onChange={(event) => props.onToggle(key.id, event.target.checked)} />
                      启用
                    </label>
                    <ActionButton tone="ghost" disabled={!fullKey} onClick={() => props.onCopy(fullKey)} title={fullKey ? "复制密钥" : "完整密钥仅生成时显示，无法从前缀还原"}>
                      <Copy className="h-4 w-4" />
                    </ActionButton>
                    <ActionButton tone="danger" onClick={() => props.onDelete(key.id)} title="删除">
                      <Trash2 className="h-4 w-4" />
                    </ActionButton>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {props.editorOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-panel" role="dialog" aria-modal="true" aria-label="密钥生成">
            <div className="form-head">
              <div className="flex items-center gap-2">
                <h2>生成密钥</h2>
                <KeyRound className="h-5 w-5 text-rust" />
              </div>
              <ActionButton type="button" tone="ghost" onClick={props.onClose} title="关闭">
                <X className="h-4 w-4" />
              </ActionButton>
            </div>
            <label>
              名称
              <TextInput value={props.keyName} onChange={(event) => props.onKeyName(event.target.value)} />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <ActionButton type="button" tone="ghost" onClick={props.onClose}>
                取消
              </ActionButton>
              <ActionButton type="button" onClick={props.onCreate}>
                <Wand2 className="h-4 w-4" />
                生成
              </ActionButton>
            </div>
            {props.createdKey ? (
              <div className="mt-4 rounded-lg border border-citron bg-citron/25 p-3">
                <code className="block break-all rounded-md bg-ink p-3 text-xs text-citron">{props.createdKey.plainTextKey}</code>
                <ActionButton tone="ghost" className="mt-3" onClick={() => props.onCopy(props.createdKey!.plainTextKey)}>
                  <Copy className="h-4 w-4" />
                </ActionButton>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  );
}

function HeadersView(props: {
  snapshot: AppSnapshot;
  draft: HeaderTemplateDraft;
  editorOpen: boolean;
  onDraft: (value: HeaderTemplateDraft) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  onEdit: (template: HeaderTemplate) => void;
  onDelete: (id: string) => void;
}) {
  const updateHeaderRow = (index: number, patch: Partial<HeaderKeyValue>) => {
    props.onDraft({
      ...props.draft,
      headerRows: props.draft.headerRows.map((row, itemIndex) => (itemIndex === index ? { ...row, ...patch } : row))
    });
  };
  const addHeaderRow = () => {
    props.onDraft({
      ...props.draft,
      headerRows: [...props.draft.headerRows, { ...blankHeaderRow }]
    });
  };
  const removeHeaderRow = (index: number) => {
    const nextRows = props.draft.headerRows.filter((_row, itemIndex) => itemIndex !== index);
    props.onDraft({
      ...props.draft,
      headerRows: nextRows.length > 0 ? nextRows : [{ ...blankHeaderRow }]
    });
  };

  return (
    <>
      {props.snapshot.headerTemplates.length === 0 ? (
        <div className="center-empty">暂无 Header 模版</div>
      ) : (
        <section className="panel p-4">
          <div className="form-head">
            <div>
              <h2>Header 模版</h2>
              <div className="mt-1 text-xs font-bold text-ink/55">{props.snapshot.headerTemplates.length} 个模版</div>
            </div>
          </div>
          <div className="site-list">
            {props.snapshot.headerTemplates.map((template) => {
              const rows = parseHeaderRows(template.headersText).filter((row) => row.key || row.value);
              return (
                <article key={template.id} className="record">
                  <div className="min-w-0">
                    <div className="record-title">{template.name}</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {rows.length > 0 ? (
                        rows.map((row, index) => (
                          <span key={`${row.key}-${index}`} className="pill">
                            {row.key || "-"}: {row.value || "-"}
                          </span>
                        ))
                      ) : (
                        <span className="pill">空模版</span>
                      )}
                    </div>
                  </div>
                  <div className="record-actions">
                    <ActionButton tone="ghost" onClick={() => props.onEdit(template)} title="编辑">
                      <Wand2 className="h-4 w-4" />
                    </ActionButton>
                    <ActionButton tone="danger" onClick={() => props.onDelete(template.id)} title="删除">
                      <Trash2 className="h-4 w-4" />
                    </ActionButton>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {props.editorOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form onSubmit={props.onSubmit} className="modal-panel" role="dialog" aria-modal="true" aria-label="Header 模版编辑">
            <div className="form-head">
              <h2>{props.draft.id ? "编辑 Header 模版" : "新增 Header 模版"}</h2>
              <ActionButton type="button" tone="ghost" onClick={props.onClose} title="关闭">
                <X className="h-4 w-4" />
              </ActionButton>
            </div>
            <label>
              名称
              <TextInput value={props.draft.name || ""} onChange={(event) => props.onDraft({ ...props.draft, name: event.target.value })} />
            </label>
            <div className="mt-4 space-y-3">
              {props.draft.headerRows.map((row, index) => (
                <div key={index} className="address-block">
                  <div className="address-block-head">
                    <div className="text-xs font-black text-ink/55">Header {index + 1}</div>
                    <ActionButton type="button" tone="danger" title="删除 Header" onClick={() => removeHeaderRow(index)}>
                      <Trash2 className="h-4 w-4" />
                    </ActionButton>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label>
                      Key
                      <TextInput
                        value={row.key}
                        placeholder="请输入 Header 名称"
                        onChange={(event) => updateHeaderRow(index, { key: event.target.value })}
                      />
                    </label>
                    <label>
                      Value
                      <TextInput
                        value={row.value}
                        placeholder="请输入 Header 值"
                        onChange={(event) => updateHeaderRow(index, { value: event.target.value })}
                      />
                    </label>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap justify-between gap-2">
              <ActionButton type="button" tone="ghost" onClick={addHeaderRow}>
                <Plus className="h-4 w-4" />
                Header
              </ActionButton>
              <div className="flex gap-2">
                <ActionButton type="button" tone="ghost" onClick={props.onClose}>
                  取消
                </ActionButton>
                <ActionButton type="submit">
                  <Save className="h-4 w-4" />
                  保存模版
                </ActionButton>
              </div>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

function LogsView(props: {
  snapshot: AppSnapshot;
  total: number;
  page: number;
  pageSize: number;
  autoRefresh: boolean;
  onAutoRefresh: (enabled: boolean) => void;
  onPage: (page: number) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const logs = props.snapshot.requestLogs;
  const successCount = logs.filter((log) => log.status === "success").length;
  const failedCount = logs.length - successCount;
  const totalPages = Math.max(1, Math.ceil(props.total / props.pageSize));
  const pageStart = props.total === 0 ? 0 : props.page * props.pageSize + 1;
  const pageEnd = Math.min(props.total, props.page * props.pageSize + logs.length);
  const header = (
    <div className="form-head">
      <div>
        <h2>请求日志</h2>
        <div className="mt-1 text-xs font-bold text-ink/55">
          第 {props.page + 1} / {totalPages} 页，{pageStart}-{pageEnd} / 共 {props.total} 条 / 本页成功 {successCount} / 失败 {failedCount} / 5 秒刷新
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <label className="toggle-row">
          <input type="checkbox" checked={props.autoRefresh} onChange={(event) => props.onAutoRefresh(event.target.checked)} />
          自动刷新
        </label>
        <div className="logs-pagination">
          <ActionButton type="button" tone="ghost" disabled={props.page <= 0} onClick={() => props.onPage(Math.max(0, props.page - 1))}>
            上一页
          </ActionButton>
          <span>{props.page + 1} / {totalPages}</span>
          <ActionButton type="button" tone="ghost" disabled={props.page >= totalPages - 1} onClick={() => props.onPage(Math.min(totalPages - 1, props.page + 1))}>
            下一页
          </ActionButton>
        </div>
        {props.total > 0 ? (
          <ActionButton tone="danger" onClick={props.onClear}>
            <Trash2 className="h-4 w-4" />
            清空
          </ActionButton>
        ) : null}
      </div>
    </div>
  );

  if (logs.length === 0) {
    return (
      <div className="logs-empty-page">
        <section className="panel p-4">{header}</section>
        <div className="center-empty">暂无日志</div>
      </div>
    );
  }

  return (
    <section className="panel p-4">
      {header}
      <div className="log-table">
        {logs.map((log) => {
            const isOpen = expanded[log.id];
            return (
              <article key={log.id} className="log-row">
                <button
                  type="button"
                  className="log-summary"
                  onClick={() => setExpanded((current) => ({ ...current, [log.id]: !isOpen }))}
                >
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-white/75 text-ink">
                    {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0">
                    <span className="record-title block">{log.model}</span>
                    <span className="record-meta block">
                      {log.summary || `${log.providerName} / ${log.userAgent || "unknown ua"}`}
                    </span>
                  </span>
                  <span className={`status-badge status-${log.status}`}>{log.status === "success" ? "成功" : "失败"}</span>
                  <span className="hidden text-right text-xs font-bold text-ink/55 md:block">
                    {formatTime(log.createdAt)}
                    <br />
                    {log.statusCode} / {log.durationMs}ms
                  </span>
                </button>

                {isOpen ? (
                  <div className="log-detail">
                    <div className="detail-grid">
                      <LogSummaryDetail log={log} />
                      <DetailBlock
                        title="下游请求"
                        value={{
                          ...(log.downstream || { model: log.routeName, endpoint: log.path, userAgent: log.userAgent }),
                          method: log.method,
                          path: log.path,
                          clientIp: log.clientIp
                        }}
                      />
                      <DetailBlock title="下游 Body" value={log.requestBody} />
                      <DetailBlock title="下游 Header" value={log.requestHeaders} />
                      <DetailBlock
                        title="路由目标"
                        value={{
                          ...(log.routeTarget || { routeName: log.routeName, model: log.model, endpoint: log.endpoint, providerName: log.providerName }),
                          routeId: log.routeId,
                          upstreamUrl: log.upstreamUrl
                        }}
                      />
                      <DetailBlock title="上游尝试" value={upstreamAttemptsSummary(log)} />
                      <DetailBlock title="上游请求 Body" value={upstreamRequestBodies(log)} />
                      <DetailBlock
                        title="上游返回"
                        value={{
                          upstreamUrl: log.upstreamUrl,
                          contentType: log.upstreamContentType,
                          preview: log.responsePreview,
                          error: log.errorMessage || undefined
                        }}
                      />
                      <DetailBlock
                        title="返回"
                        value={{
                          status: log.status,
                          statusCode: log.statusCode,
                          durationMs: log.durationMs,
                          preview: log.responsePreview,
                          error: log.errorMessage || undefined
                        }}
                      />
                    </div>
                    <div className="mt-3 flex justify-end">
                      <ActionButton tone="danger" onClick={() => props.onDelete(log.id)}>
                        <Trash2 className="h-4 w-4" />
                      </ActionButton>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
      </div>
    </section>
  );
}

function SettingsView(props: {
  snapshot: AppSnapshot;
  busy: boolean;
  onRefresh: () => void;
  onSave: (settings: Partial<AppSettings>) => void;
  onPasswordChange: (currentPassword: string, nextPassword: string) => Promise<void>;
  onThemeChange: (themeId: AppThemeId) => void;
}) {
  const [maxRequestLogs, setMaxRequestLogs] = useState(String(props.snapshot.settings.maxRequestLogs));
  const [adminSessionTtlMinutes, setAdminSessionTtlMinutes] = useState(String(props.snapshot.settings.adminSessionTtlMinutes || 30));
  const [themeId, setThemeId] = useState<AppThemeId>(props.snapshot.settings.themeId || "fresh");
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");

  useEffect(() => {
    setMaxRequestLogs(String(props.snapshot.settings.maxRequestLogs));
    setAdminSessionTtlMinutes(String(props.snapshot.settings.adminSessionTtlMinutes || 30));
    setThemeId(props.snapshot.settings.themeId || "fresh");
  }, [props.snapshot.settings.adminSessionTtlMinutes, props.snapshot.settings.maxRequestLogs, props.snapshot.settings.themeId]);

  const chooseTheme = (nextThemeId: AppThemeId) => {
    setThemeId(nextThemeId);
    props.onThemeChange(nextThemeId);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSave({ maxRequestLogs: Number(maxRequestLogs), adminSessionTtlMinutes: Number(adminSessionTtlMinutes), themeId });
  };

  const changePassword = async () => {
    setPasswordError("");
    if (!currentPassword.trim()) {
      setPasswordError("请输入当前管理密码");
      return;
    }
    if (nextPassword.trim().length < 8) {
      setPasswordError("新管理密码至少需要 8 个字符");
      return;
    }
    if (nextPassword !== confirmPassword) {
      setPasswordError("两次输入的新密码不一致");
      return;
    }
    try {
      await props.onPasswordChange(currentPassword, nextPassword);
      setCurrentPassword("");
      setNextPassword("");
      setConfirmPassword("");
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "管理密码修改失败");
    }
  };

  return (
    <section className="panel settings-panel p-4">
      <div className="form-head">
        <div>
          <h2>系统设置</h2>
          <div className="mt-1 text-xs font-bold text-ink/55">当前日志 {props.snapshot.requestLogs.length} 条</div>
        </div>
        <ActionButton type="button" tone="ghost" onClick={props.onRefresh} disabled={props.busy} title="刷新数据" aria-label="刷新数据">
          <RefreshCw className={`h-4 w-4 ${props.busy ? "animate-spin" : ""}`} />
          刷新数据
        </ActionButton>
      </div>
      <form onSubmit={submit} className="form-grid">
        <div className="settings-section form-span-2">
          <div className="settings-section-head">
            <div>
              <h3>界面主题</h3>
              <p>选择后立即生效，并保存到当前项目数据库。</p>
            </div>
          </div>
          <div className="theme-grid">
            {themeOptions.map((theme) => {
              const selected = theme.id === themeId;
              return (
                <button
                  key={theme.id}
                  type="button"
                  className={`theme-card ${selected ? "theme-card-active" : ""}`}
                  aria-pressed={selected}
                  disabled={props.busy && !selected}
                  onClick={() => chooseTheme(theme.id)}
                >
                  <span className="theme-card-top">
                    <span>
                      <span className="theme-card-name">{theme.name}</span>
                      <span className="theme-card-desc">{theme.description}</span>
                    </span>
                    <span className="theme-check">{selected ? <Check className="h-4 w-4" /> : null}</span>
                  </span>
                  <span className="theme-swatches" aria-hidden="true">
                    {theme.swatches.map((color) => (
                      <span key={color} className="theme-swatch" style={{ background: color }} />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="settings-section form-span-2">
          <div className="settings-section-head">
            <div>
              <h3>管理员密码</h3>
              <p>{props.snapshot.security.adminPasswordCustomized ? "当前使用本地数据库中的自定义密码。" : "当前使用启动环境变量或本地默认密码。"}</p>
            </div>
          </div>
          <div className="settings-password-grid">
            <label>
              当前密码
              <TextInput
                type="password"
                value={currentPassword}
                autoComplete="current-password"
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </label>
            <label>
              新密码
              <TextInput
                type="password"
                value={nextPassword}
                autoComplete="new-password"
                onChange={(event) => setNextPassword(event.target.value)}
              />
            </label>
            <label>
              确认新密码
              <TextInput
                type="password"
                value={confirmPassword}
                autoComplete="new-password"
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </label>
          </div>
          {passwordError ? <div className="auth-error mt-3" role="alert">{passwordError}</div> : null}
          <div className="mt-3 flex justify-end">
            <ActionButton type="button" tone="ghost" disabled={props.busy} onClick={changePassword}>
              <LockKeyhole className="h-4 w-4" />
              修改密码
            </ActionButton>
          </div>
        </div>

        <div className="settings-section form-span-2">
          <div className="settings-section-head">
            <div>
              <h3>日志保留</h3>
              <p>控制日志页面最多展示和保留的请求记录数量。</p>
            </div>
          </div>
        <label>
          日志最多保留条数
          <TextInput
            type="number"
            min={1}
            max={5000}
            step={1}
            value={maxRequestLogs}
            onChange={(event) => setMaxRequestLogs(event.target.value)}
          />
        </label>
        </div>

        <div className="settings-section form-span-2">
          <div className="settings-section-head">
            <div>
              <h3>会话有效期</h3>
              <p>超过这个时间未重新登录时，需要再次输入管理员密码。</p>
            </div>
          </div>
          <label>
            管理会话有效分钟数
            <TextInput
              type="number"
              min={1}
              max={43200}
              step={1}
              value={adminSessionTtlMinutes}
              onChange={(event) => setAdminSessionTtlMinutes(event.target.value)}
            />
          </label>
        </div>
        <div className="flex justify-end">
          <ActionButton type="submit">
            <Save className="h-4 w-4" />
            保存设置
          </ActionButton>
        </div>
      </form>
    </section>
  );
}

function SummaryField(props: { label: string; value?: string | number }) {
  return (
    <div className="summary-field">
      <span>{props.label}</span>
      <strong>{props.value || "-"}</strong>
    </div>
  );
}

function LogSummaryDetail(props: { log: RequestLog }) {
  const { log } = props;
  const downstream = log.downstream || { model: log.routeName, endpoint: log.path, userAgent: log.userAgent, path: log.path };
  const routeTarget = log.routeTarget || {
    routeName: log.routeName,
    model: log.model,
    endpoint: log.endpoint,
    providerName: log.providerName
  };
  return (
    <div className="detail-block detail-wide summary-card">
      <div className="summary-card-head">
        <div>
          <div className="detail-title">总结</div>
        </div>
        <span className={`status-badge status-${log.status}`}>{log.status === "success" ? "成功" : "失败"}</span>
      </div>
      <div className="summary-flow">
        <section className="summary-node">
          <div className="summary-node-label">下游请求</div>
          <div className="summary-node-main">{downstream.model || log.routeName || "-"}</div>
          <SummaryField label="Endpoint" value={downstream.endpoint || log.path} />
          <SummaryField label="Path" value={downstream.path || log.path} />
          <SummaryField label="UA" value={downstream.userAgent || log.userAgent || "unknown ua"} />
        </section>
        <div className="summary-arrow">
          <ChevronRight className="h-4 w-4" />
        </div>
        <section className="summary-node">
          <div className="summary-node-label">路由目标</div>
          <div className="summary-node-main">{routeTarget.model || log.model || "-"}</div>
          <SummaryField label="路由" value={routeTarget.routeName || log.routeName} />
          <SummaryField label="Endpoint" value={routeTarget.endpoint || log.endpoint} />
          <SummaryField label="供应商" value={routeTarget.providerName || log.providerName} />
          <SummaryField label="UA" value={routeTarget.userAgent || "fetch default"} />
        </section>
        <div className="summary-arrow">
          <ChevronRight className="h-4 w-4" />
        </div>
        <section className="summary-node summary-result">
          <div className="summary-node-label">返回</div>
          <div className="summary-node-main">{log.statusCode}</div>
          <SummaryField label="状态" value={log.status === "success" ? "成功" : "失败"} />
          <SummaryField label="耗时" value={`${log.durationMs}ms`} />
          <SummaryField label="时间" value={formatTime(log.createdAt)} />
        </section>
      </div>
    </div>
  );
}

function DetailBlock(props: { title: string; value: unknown }) {
  return (
    <div className="detail-block">
      <div className="detail-title">{props.title}</div>
      <pre>{prettyJson(props.value)}</pre>
    </div>
  );
}

function UsageCopyRow(props: { label: string; value: string; note: string; onCopy: (value: string) => void }) {
  return (
    <div className="usage-copy-row">
      <div>
        <span>{props.label}</span>
        <code>{props.value}</code>
        <p>{props.note}</p>
      </div>
      <ActionButton tone="ghost" onClick={() => props.onCopy(props.value)} title={`复制 ${props.label}`}>
        <Copy className="h-4 w-4" />
      </ActionButton>
    </div>
  );
}

function DocsView(props: { snapshot: AppSnapshot; onCopy: (value: string) => void }) {
  const enabledRoutes = props.snapshot.routes.filter((item) => item.enabled);
  const route = enabledRoutes[0] || props.snapshot.routes[0];
  const proxyBaseUrl = `${apiOrigin()}/proxy`;
  const proxyV1BaseUrl = `${apiOrigin()}/proxy/v1`;
  const modelName = route?.name || "default-messages";
  const ccSwitchConfig = `base_url = ${proxyBaseUrl}
api_key = sk-samapi-...
model = ${modelName}`;
  const command = `curl ${apiOrigin()}/proxy \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer sk-samapi-..." \\
  -d '{"model":"${modelName}","messages":[{"role":"user","content":"hello"}]}'`;
  const modelsCommand = `curl ${apiOrigin()}/proxy/v1/models \\
  -H "Authorization: Bearer sk-samapi-..."`;
  return (
    <section className="panel usage-panel p-4">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="metric">
          <span>{props.snapshot.sites.length}</span>
          站点
        </div>
        <div className="metric">
          <span>{props.snapshot.routes.length}</span>
          路由
        </div>
        <div className="metric">
          <span>{props.snapshot.apiKeys.length}</span>
          密钥
        </div>
      </div>

      <div className="usage-hero">
        <div>
          <p>下游接入</p>
          <h2>把路由名当作模型名使用</h2>
        </div>
        <ActionButton tone="ghost" onClick={() => props.onCopy(ccSwitchConfig)}>
          <Copy className="h-4 w-4" />
          复制配置
        </ActionButton>
      </div>

      <div className="usage-config-block">
        <div className="usage-block-head">
          <span>CC-Switch / Claude 配置</span>
          <ActionButton tone="ghost" onClick={() => props.onCopy(ccSwitchConfig)} title="复制配置">
            <Copy className="h-4 w-4" />
          </ActionButton>
        </div>
        <pre>{ccSwitchConfig}</pre>
      </div>

      <div className="usage-copy-list">
        <UsageCopyRow label="base_url" value={proxyBaseUrl} note="推荐给 CC-Switch、Claude CLI 这类会自动拼接 /v1/messages 的客户端。" onCopy={props.onCopy} />
        <UsageCopyRow label="api_key" value="sk-samapi-..." note="从客户端密钥页面复制完整密钥，作为 Bearer Token 使用。" onCopy={props.onCopy} />
        <UsageCopyRow label="model" value={modelName} note="填写路由管理里的路由名称；分组路由也复制分组名称作为模型名。" onCopy={props.onCopy} />
        <UsageCopyRow label="models" value={`${proxyV1BaseUrl}/models`} note="用于下游获取可用模型列表，返回启用中的路由名称。" onCopy={props.onCopy} />
        <UsageCopyRow label="OpenAI base_url" value={proxyV1BaseUrl} note="如果客户端要求 base_url 已经包含 /v1，可以使用这个地址。" onCopy={props.onCopy} />
      </div>

      <div className="usage-example-grid">
        <div className="usage-code-block">
          <div className="usage-block-head">
            <span>模型列表</span>
            <ActionButton tone="ghost" onClick={() => props.onCopy(modelsCommand)} title="复制模型列表请求">
              <Copy className="h-4 w-4" />
            </ActionButton>
          </div>
          <pre>{modelsCommand}</pre>
        </div>
        <div className="usage-code-block">
          <div className="usage-block-head">
            <span>消息请求</span>
            <ActionButton tone="ghost" onClick={() => props.onCopy(command)} title="复制消息请求">
              <Copy className="h-4 w-4" />
            </ActionButton>
          </div>
          <pre>{command}</pre>
        </div>
      </div>

      <div className="usage-route-strip">
        <span>当前可用模型</span>
        <div>
          {(enabledRoutes.length > 0 ? enabledRoutes : props.snapshot.routes).slice(0, 12).map((item) => (
            <button key={item.id} type="button" onClick={() => props.onCopy(item.name)}>
              {item.name}
            </button>
          ))}
          {(enabledRoutes.length > 0 ? enabledRoutes : props.snapshot.routes).length > 12 ? (
            <strong>+{(enabledRoutes.length > 0 ? enabledRoutes : props.snapshot.routes).length - 12}</strong>
          ) : null}
        </div>
      </div>
    </section>
  );
}
