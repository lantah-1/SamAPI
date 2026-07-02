import {
  Activity,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  KeyRound,
  Map,
  Plus,
  RefreshCw,
  Route,
  Save,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
  Wand2,
  X
} from "lucide-react";
import { Children, FormEvent, isValidElement, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type {
  ApiKeyCreated,
  AppSnapshot,
  EndpointKind,
  HeaderTemplate,
  ProviderApiKeyGroupView,
  RequestLog,
  Site,
  SiteAddress,
  SiteType,
  SwitchRoute
} from "../shared/types";

type Section = "routes" | "sites" | "providerKeys" | "keys" | "headers" | "logs" | "settings" | "docs";

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

interface HeaderKeyValue {
  key: string;
  value: string;
}

interface HeaderTemplateDraft extends Partial<HeaderTemplate> {
  headerRows: HeaderKeyValue[];
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

const navItems = [
  { id: "routes", label: "路由管理", icon: Route },
  { id: "sites", label: "站点管理", icon: Server },
  { id: "providerKeys", label: "API Key 管理", icon: KeyRound },
  { id: "keys", label: "客户端密钥", icon: ShieldCheck },
  { id: "headers", label: "Header 模版", icon: Braces },
  { id: "logs", label: "日志管理", icon: Activity },
  { id: "docs", label: "接入", icon: Map }
] satisfies Array<{ id: Section; label: string; icon: typeof Route }>;

const settingsNavItem = { id: "settings", label: "设置", icon: Settings } satisfies { id: Section; label: string; icon: typeof Route };
const allNavItems = [...navItems, settingsNavItem];

function emptyRoute(snapshot?: AppSnapshot): Partial<SwitchRoute> {
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
    onChange?.({
      target: { value: nextValue, name },
      currentTarget: { value: nextValue, name }
    } as unknown as React.ChangeEvent<HTMLSelectElement>);
    setOpen(false);
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
    <span ref={rootRef} className={`select-shell ${open ? "select-shell-open" : ""} ${disabled ? "select-shell-disabled" : ""}`}>
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
                onClick={() => commitValue(option.value)}
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

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [section, setSection] = useState<Section>("routes");
  const [routeDraft, setRouteDraft] = useState<Partial<SwitchRoute>>({});
  const [routeEditorOpen, setRouteEditorOpen] = useState(false);
  const [siteDraft, setSiteDraft] = useState<Partial<Site>>(emptySite());
  const [siteEditorOpen, setSiteEditorOpen] = useState(false);
  const [providerKeyDraft, setProviderKeyDraft] = useState<ProviderKeyGroupDraft>(emptyProviderKeyGroup());
  const [providerKeyEditorOpen, setProviderKeyEditorOpen] = useState(false);
  const [headerDraft, setHeaderDraft] = useState<HeaderTemplateDraft>(emptyHeader());
  const [headerEditorOpen, setHeaderEditorOpen] = useState(false);
  const [keyName, setKeyName] = useState("client-app");
  const [keyEditorOpen, setKeyEditorOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<ApiKeyCreated | null>(null);
  const [toast, setToast] = useState<string>("");
  const [appScrollbarVisible, setAppScrollbarVisible] = useState(false);
  const [logsAutoRefresh, setLogsAutoRefresh] = useState(true);
  const [busy, setBusy] = useState(false);
  const [modelSyncing, setModelSyncing] = useState(false);
  const [modelDiscoveringIndex, setModelDiscoveringIndex] = useState<number | null>(null);
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

  const load = async () => {
    const next = await api.snapshot();
    setSnapshot(next);
    setRouteDraft((current) => (current.name ? current : emptyRoute(next)));
  };

  useEffect(() => {
    load().catch((error) => setToast(error.message));
  }, []);

  useEffect(() => {
    if (!toast) return;
    startToastTimer(toastDurationMs(toast));
    return clearToastTimer;
  }, [toast]);

  useEffect(() => clearAppScrollbarTimer, []);

  useEffect(() => {
    if (section !== "logs" || !logsAutoRefresh) return;
    const interval = window.setInterval(() => {
      load().catch((error) => setToast(error instanceof Error ? error.message : "日志自动刷新失败"));
    }, 5000);
    return () => window.clearInterval(interval);
  }, [section, logsAutoRefresh]);

  const selectedSite = useMemo(
    () => snapshot?.sites.find((site) => site.id === routeDraft.siteId),
    [routeDraft.siteId, snapshot]
  );
  const selectedSiteModels = useMemo(() => siteModels(selectedSite), [selectedSite]);

  const mutate = async (work: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await work();
      await load();
      setToast(message);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const saveRoute = (event: FormEvent) => {
    event.preventDefault();
    mutate(async () => {
      await api.saveRoute(routeDraft);
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

  const openEditRoute = (route: SwitchRoute) => {
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
      setToast(`已获取 ${result.models.length} 个模型`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "模型获取失败");
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
      setToast(error instanceof Error ? error.message : "模型同步失败");
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
    if (section === "keys") openNewKey();
    if (section === "headers") openNewHeader();
  };

  const canAddInSection = ["routes", "sites", "providerKeys", "keys", "headers"].includes(section);

  const setRouteSite = (siteId: string) => {
    const site = snapshot?.sites.find((item) => item.id === siteId);
    const models = siteModels(site);
    setRouteDraft((current) => ({
      ...current,
      siteId,
      addressId: undefined,
      model: models[0] || ""
    }));
  };

  const copyText = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setToast("已复制");
  };

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
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-ink text-citron">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div className="app-brand-copy hidden lg:block">
              <div className="font-display text-lg font-black tracking-normal">SamAPI</div>
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
          <NavButton item={settingsNavItem} active={section === settingsNavItem.id} onClick={setSection} className="app-settings-nav" />
        </aside>

        <section className="app-content flex min-w-0 flex-1 flex-col gap-4">
          <header className="app-header panel flex min-h-16 items-center justify-between gap-4 px-4 py-3">
            <div className="app-header-title">
              <div className="text-xs font-bold uppercase tracking-[0.24em] text-rust">Control Plane</div>
              <h1 className="font-display text-2xl font-black tracking-normal md:text-3xl">
                {allNavItems.find((item) => item.id === section)?.label}
              </h1>
            </div>
            <div className="app-header-actions flex items-center gap-2">
              <ActionButton tone="ghost" onClick={load} disabled={busy} title="刷新">
                <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
              </ActionButton>
              {canAddInSection ? (
                <ActionButton type="button" onClick={openNewForSection}>
                  <Plus className="h-4 w-4" />
                  添加
                </ActionButton>
              ) : null}
            </div>
          </header>

          <div
            className={`app-scroll ${appScrollbarVisible ? "app-scroll-visible" : ""}`}
            onMouseEnter={showAppScrollbar}
            onMouseMove={showAppScrollbar}
            onMouseLeave={hideAppScrollbar}
            onScroll={showAppScrollbar}
          >
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
                onDraft={setProviderKeyDraft}
                onSubmit={saveProviderKeyGroup}
                onClose={() => setProviderKeyEditorOpen(false)}
                onDiscoverModels={discoverProviderModels}
                onSyncModels={syncProviderModels}
                onEdit={openEditProviderKeyGroup}
                onDelete={(id) => mutate(async () => api.deleteProviderKeyGroup(id), "API Key 分组已删除")}
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
                autoRefresh={logsAutoRefresh}
                onAutoRefresh={setLogsAutoRefresh}
                onDelete={(id) => mutate(async () => api.deleteLog(id), "日志已删除")}
                onClear={() => mutate(async () => api.clearLogs(), "日志已清空")}
              />
            )}
            {section === "settings" && (
              <SettingsView
                snapshot={snapshot}
                onSave={(maxRequestLogs) => mutate(async () => api.updateSettings({ maxRequestLogs }), "设置已保存")}
              />
            )}
            {section === "docs" && <DocsView snapshot={snapshot} onCopy={copyText} />}
          </div>
        </section>
      </div>
    </main>
  );
}

function RoutesView(props: {
  snapshot: AppSnapshot;
  draft: Partial<SwitchRoute>;
  editorOpen: boolean;
  selectedSite?: Site;
  selectedSiteModels: string[];
  onDraft: (value: Partial<SwitchRoute>) => void;
  onSite: (siteId: string) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  onDelete: (id: string) => void;
  onEdit: (route: SwitchRoute) => void;
  onQuickSave: (route: Partial<SwitchRoute>) => Promise<void>;
  onCopy: (value: string) => void;
}) {
  const routes = props.snapshot.routes.filter((route): route is SwitchRoute => route.type === "switch");
  const proxyOrigin = apiOrigin();
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
  return (
    <>
      {routes.length === 0 ? (
        <div className="center-empty">暂无路由</div>
      ) : (
        <section className="panel p-4">
          <div className="form-head">
            <div>
              <h2>切换型路由</h2>
              <div className="mt-1 text-xs font-bold text-ink/55">{routes.length} 条路由</div>
            </div>
          </div>
          <div className="site-list">
            {routes.map((route) => {
              const site = props.snapshot.sites.find((item) => item.id === route.siteId);
              const quick = routeDraft(route);
              const quickSite = props.snapshot.sites.find((item) => item.id === quick.siteId) || site;
              const models = siteModels(quickSite);
              const modelOptions = Array.from(new Set([quick.model, ...models].filter(Boolean))).sort();
              const isOpen = Boolean(expanded[route.id]);
              const hasChanges = quick.siteId !== route.siteId || quick.model !== route.model || quick.enabled !== route.enabled;
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
                      <div className="mt-3 grid gap-2">
                        <code className="block truncate rounded-md bg-ink px-3 py-2 text-xs text-citron">base_url: {proxyOrigin}/proxy</code>
                        <code className="block truncate rounded-md bg-ink px-3 py-2 text-xs text-citron">model: {route.name}</code>
                      </div>
                    </div>
                  </div>
                  <div
                    className="record-actions route-record-actions"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <ActionButton tone="ghost" title="复制 Base URL" onClick={() => props.onCopy(`${proxyOrigin}/proxy`)}>
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
                          <SelectInput value={quick.model || ""} onChange={(event) => updateRouteDraft(route, { model: event.target.value })}>
                            <option value="">选择模型</option>
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
                        <div className="route-quick-control">
                          <span className="route-quick-label">Endpoint</span>
                          <div className="route-quick-body route-quick-stat route-quick-endpoint">
                            <strong>{endpointLabels[route.endpoint]}</strong>
                          </div>
                        </div>
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
      )}

      {props.editorOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form onSubmit={props.onSubmit} className="modal-panel" role="dialog" aria-modal="true" aria-label="路由编辑">
            <div className="form-head">
              <h2>{props.draft.id ? "编辑路由" : "新增路由"}</h2>
              <ActionButton type="button" tone="ghost" onClick={props.onClose} title="关闭">
                <X className="h-4 w-4" />
              </ActionButton>
            </div>
            <div className="form-grid">
              <label>
                路由名称
                <TextInput value={props.draft.name || ""} onChange={(event) => props.onDraft({ ...props.draft, name: event.target.value })} />
              </label>
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
                <SelectInput value={props.draft.model || ""} onChange={(event) => props.onDraft({ ...props.draft, model: event.target.value })}>
                  <option value="">选择模型</option>
                  {props.selectedSiteModels.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </SelectInput>
              </label>
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
            <div className="mt-4 flex justify-end gap-2">
              <ActionButton type="button" tone="ghost" onClick={props.onClose}>
                取消
              </ActionButton>
              <ActionButton type="submit">
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
                    <div className="record-meta break-all">{fullKey || `${key.prefix}...`}</div>
                  </div>
                  <div className="record-actions">
                    <label className="toggle-row">
                      <input type="checkbox" checked={key.enabled} onChange={(event) => props.onToggle(key.id, event.target.checked)} />
                      启用
                    </label>
                    <ActionButton
                      tone="ghost"
                      disabled={!fullKey}
                      onClick={() => props.onCopy(fullKey)}
                      title={fullKey ? "复制完整密钥" : "历史密钥未保存完整值"}
                    >
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
  autoRefresh: boolean;
  onAutoRefresh: (enabled: boolean) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const logs = props.snapshot.requestLogs;
  const successCount = logs.filter((log) => log.status === "success").length;
  const failedCount = logs.length - successCount;
  const header = (
    <div className="form-head">
      <div>
        <h2>请求日志</h2>
        <div className="mt-1 text-xs font-bold text-ink/55">
          {logs.length} 条 / 成功 {successCount} / 失败 {failedCount} / 5 秒刷新
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <label className="toggle-row">
          <input type="checkbox" checked={props.autoRefresh} onChange={(event) => props.onAutoRefresh(event.target.checked)} />
          自动刷新
        </label>
        {logs.length > 0 ? (
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
      <>
        <section className="panel p-4">{header}</section>
        <div className="center-empty">暂无日志</div>
      </>
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

function SettingsView(props: { snapshot: AppSnapshot; onSave: (maxRequestLogs: number) => void }) {
  const [maxRequestLogs, setMaxRequestLogs] = useState(String(props.snapshot.settings.maxRequestLogs));

  useEffect(() => {
    setMaxRequestLogs(String(props.snapshot.settings.maxRequestLogs));
  }, [props.snapshot.settings.maxRequestLogs]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSave(Number(maxRequestLogs));
  };

  return (
    <section className="panel p-4">
      <div className="form-head">
        <div>
          <h2>系统设置</h2>
          <div className="mt-1 text-xs font-bold text-ink/55">当前日志 {props.snapshot.requestLogs.length} 条</div>
        </div>
      </div>
      <form onSubmit={submit} className="form-grid">
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

function DocsView(props: { snapshot: AppSnapshot; onCopy: (value: string) => void }) {
  const route = props.snapshot.routes.find((item) => item.type === "switch");
  const command = `curl ${apiOrigin()}/proxy \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer sk-samapi-..." \\
  -d '{"model":"${route?.name || "default-messages"}","messages":[{"role":"user","content":"hello"}]}'`;
  return (
    <section className="panel p-4">
      <div className="form-head">
        <h2>本地调用</h2>
        <ActionButton tone="ghost" onClick={() => props.onCopy(command)}>
          <Copy className="h-4 w-4" />
        </ActionButton>
      </div>
      <pre className="overflow-auto rounded-lg bg-ink p-4 text-sm text-citron">{command}</pre>
      <div className="mt-4 grid gap-2 rounded-lg border border-ink/10 bg-white p-3 text-sm font-bold text-ink/65">
        <div className="grid gap-1 md:grid-cols-[88px_1fr]">
          <span>base_url</span>
          <code className="break-all text-ink">{apiOrigin()}/proxy</code>
        </div>
        <div className="grid gap-1 md:grid-cols-[88px_1fr]">
          <span>model</span>
          <code className="break-all text-ink">{route?.name || "default-messages"}</code>
        </div>
        <div className="grid gap-1 md:grid-cols-[88px_1fr]">
          <span>api_key</span>
          <code className="break-all text-ink">sk-samapi-...</code>
        </div>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
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
    </section>
  );
}
