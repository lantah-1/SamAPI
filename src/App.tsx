import {
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Database,
  KeyRound,
  LockKeyhole,
  Map,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
  Wand2,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
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
  ProviderApiKeyKind,
  ProviderModelGroupOption,
  RequestLog,
  RequestLogSummary,
  RouteProxyConfig,
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

import { AuthLanding } from "./components/AuthLanding";
import { NavButton } from "./components/NavButton";
import { ActionButton, SelectInput, TextInput } from "./components/ui";
import {
  DocsView,
  HeadersView,
  KeysView,
  LogDetailModal,
  LogsView,
  ProviderKeysView,
  RoutesView,
  SettingsView,
  SitesView,
  TemporaryAccountsView
} from "./views";
import { updateSiteChromeFromTheme } from "./app/chrome";
import {
  LOGS_PAGE_SIZE,
  allNavItems,
  blankAddress,
  blankHeaderRow,
  endpointLabels,
  groupStrategyLabels,
  routeProxyModeLabels,
  routeTypeLabels,
  siteTypeLabels,
  temporaryAccountAvailabilityLabels,
  temporaryAccountProviderLabels,
  temporaryAccountSourceLabels,
  navItems,
  settingsNavItem,
  themeOptions
} from "./app/constants";
import type {
  AuthStatus,
  HeaderKeyValue,
  HeaderTemplateDraft,
  ProviderApiKeyDraft,
  ProviderKeyGroupDraft,
  ProviderModelOption,
  RouteDraft,
  Section,
  TemporaryAccountImportDraft
} from "./app/types";
import {
  apiOrigin,
  emptyHeader,
  emptyProviderApiKey,
  emptyProviderKeyGroup,
  emptyRoute,
  emptySite,
  emptyTemporaryAccountImport,
  formatQuotaPercent,
  formatTime,
  groupMemberKey,
  groupRouteMemberGroups,
  groupRouteOrderedMembers,
  groupRouteStats,
  isOfficialOpenAiSite,
  mergeModelOptions,
  modelMatchesRule,
  normalizedRouteProxy,
  optionToMember,
  parseHeaderRows,
  parseModelText,
  prettyJson,
  providerModelOptions,
  routeProxyConfigsEqual,
  serializeHeaderRows,
  serializeModelText,
  siteModels,
  smartModelMatches,
  temporaryAccountAvailabilityStats,
  temporaryAccountCheckSummary,
  temporaryAccountQuotaPercent,
  temporaryAccountQuotaText,
  temporaryAccountTypeLabel,
  toastDurationMs,
  uniqueMembers,
  upstreamAttemptsSummary,
  upstreamRequestBodies
} from "./app/utils";

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
  const [keyModelsText, setKeyModelsText] = useState("");
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [keyEditorOpen, setKeyEditorOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<ApiKeyCreated | null>(null);
  const [toast, setToast] = useState<string>("");
  const [appScrollbarVisible, setAppScrollbarVisible] = useState(false);
  const [appScrollbarThumb, setAppScrollbarThumb] = useState({ height: 0, scrollable: false, top: 0 });
  const [logsAutoRefresh, setLogsAutoRefresh] = useState(true);
  const [logsRefreshing, setLogsRefreshing] = useState(false);
  const [logsLoadingMore, setLogsLoadingMore] = useState(false);
  const [logsTotal, setLogsTotal] = useState(0);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [selectedLogDetail, setSelectedLogDetail] = useState<RequestLog | null>(null);
  const [selectedLogLoading, setSelectedLogLoading] = useState(false);
  const [selectedLogError, setSelectedLogError] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelSyncing, setModelSyncing] = useState(false);
  const [modelDiscoveringIndex, setModelDiscoveringIndex] = useState<number | null>(null);
  const [providerModelGroupOptions, setProviderModelGroupOptions] = useState<Record<number, ProviderModelGroupOption[]>>({});
  const [temporaryAccountChecking, setTemporaryAccountChecking] = useState<string | null>(null);
  const [temporaryAccountCheckProviderType, setTemporaryAccountCheckProviderType] = useState<Extract<TemporaryAccountProviderType, "gpt" | "grok">>("gpt");
  const [temporaryAccountCheckProxy, setTemporaryAccountCheckProxy] = useState<RouteProxyConfig>({ mode: "system" });
  const [temporaryAccountUpdating, setTemporaryAccountUpdating] = useState<string | null>(null);
  const [temporaryAccountDeleting, setTemporaryAccountDeleting] = useState<string | null>(null);
  const [selectedTemporaryAccountIds, setSelectedTemporaryAccountIds] = useState<string[]>([]);
  const appScrollRef = useRef<HTMLDivElement | null>(null);
  const appScrollContentRef = useRef<HTMLDivElement | null>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);
  const toastStartedAtRef = useRef(0);
  const toastRemainingMsRef = useRef(0);
  const appScrollbarTimerRef = useRef<number | undefined>(undefined);
  const appScrollbarDragRef = useRef<{
    maxScrollTop: number;
    maxThumbTop: number;
    pointerId: number;
    startScrollTop: number;
    startY: number;
  } | null>(null);

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
    if (appScrollbarDragRef.current) return;
    appScrollbarTimerRef.current = window.setTimeout(() => {
      setAppScrollbarVisible(false);
      appScrollbarTimerRef.current = undefined;
    }, 2000);
  };

  const hideAppScrollbar = () => {
    if (appScrollbarDragRef.current) return;
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

  const startAppScrollbarDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const element = appScrollRef.current;
    if (!element || !appScrollbarThumb.scrollable) return;
    const maxScrollTop = Math.max(1, element.scrollHeight - element.clientHeight);
    const trackHeight = Math.max(0, element.clientHeight - 16);
    const maxThumbTop = Math.max(1, trackHeight - appScrollbarThumb.height);
    appScrollbarDragRef.current = {
      maxScrollTop,
      maxThumbTop,
      pointerId: event.pointerId,
      startScrollTop: element.scrollTop,
      startY: event.clientY
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
    setAppScrollbarVisible(true);
    clearAppScrollbarTimer();
  };

  const moveAppScrollbarDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = appScrollbarDragRef.current;
    const element = appScrollRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !element) return;
    const deltaY = event.clientY - drag.startY;
    const nextScrollTop = Math.min(
      drag.maxScrollTop,
      Math.max(0, drag.startScrollTop + (deltaY / drag.maxThumbTop) * drag.maxScrollTop)
    );
    element.scrollTop = nextScrollTop;
    updateAppScrollbar();
    event.preventDefault();
  };

  const stopAppScrollbarDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = appScrollbarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    appScrollbarDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
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
          ? api.listLogs(LOGS_PAGE_SIZE, 0).then((result) => {
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

  const loadInitialLogs = async (showSuccess = false) => {
    setLogsRefreshing(true);
    try {
      const result = await api.listLogs(LOGS_PAGE_SIZE, 0);
      setSnapshot((current) => (current ? { ...current, requestLogs: result.items } : current));
      setLogsTotal(result.total);
      if (showSuccess) setToast("日志已刷新");
    } catch (error) {
      if (!handleUnauthorized(error)) setToast(error instanceof Error ? error.message : "日志刷新失败");
    } finally {
      setLogsRefreshing(false);
    }
  };

  const loadMoreLogs = async () => {
    const offset = snapshot?.requestLogs.length || 0;
    if (logsLoadingMore || offset >= logsTotal) return;
    setLogsLoadingMore(true);
    try {
      const result = await api.listLogs(LOGS_PAGE_SIZE, offset);
      setSnapshot((current) => {
        if (!current) return current;
        const existingIds = new Set(current.requestLogs.map((log) => log.id));
        return { ...current, requestLogs: [...current.requestLogs, ...result.items.filter((log) => !existingIds.has(log.id))] };
      });
      setLogsTotal(result.total);
    } catch (error) {
      if (!handleUnauthorized(error)) setToast(error instanceof Error ? error.message : "日志加载失败");
    } finally {
      setLogsLoadingMore(false);
    }
  };

  const refreshLogs = async (showSuccess = false) => {
    setLogsRefreshing(true);
    try {
      const latestCreatedAt = snapshot?.requestLogs[0]?.createdAt;
      if (!latestCreatedAt) {
        const result = await api.listLogs(LOGS_PAGE_SIZE, 0);
        setSnapshot((current) => (current ? { ...current, requestLogs: result.items } : current));
        setLogsTotal(result.total);
        if (showSuccess) setToast("日志已刷新");
        return;
      }
      const [result, latestPage] = await Promise.all([
        api.listNewLogs(latestCreatedAt),
        api.listLogs(LOGS_PAGE_SIZE, 0)
      ]);
      const mergedLatest = [...result.items, ...latestPage.items].filter((log, index, items) => items.findIndex((item) => item.id === log.id) === index);
      if (mergedLatest.length > 0) {
        setSnapshot((current) => {
          if (!current) return current;
          const existingIds = new Set(current.requestLogs.map((log) => log.id));
          const latestIds = new Set(mergedLatest.map((log) => log.id));
          const newItems = mergedLatest.filter((log) => !existingIds.has(log.id));
          const updatedItems = current.requestLogs.map((log) => mergedLatest.find((item) => item.id === log.id) || log);
          return { ...current, requestLogs: [...newItems, ...updatedItems.filter((log) => !latestIds.has(log.id) || existingIds.has(log.id))] };
        });
      }
      setLogsTotal(latestPage.total);
      if (showSuccess) setToast(result.items.length > 0 ? `日志已刷新，新增 ${result.items.length} 条` : "日志已刷新");
    } catch (error) {
      if (!handleUnauthorized(error)) setToast(error instanceof Error ? error.message : "日志刷新失败");
    } finally {
      setLogsRefreshing(false);
    }
  };

  const openLogDetail = async (id: string) => {
    setSelectedLogId(id);
    setSelectedLogDetail(null);
    setSelectedLogError("");
    setSelectedLogLoading(true);
    try {
      setSelectedLogDetail(await api.getLog(id));
    } catch (error) {
      if (!handleUnauthorized(error)) setSelectedLogError(error instanceof Error ? error.message : "日志详情加载失败");
    } finally {
      setSelectedLogLoading(false);
    }
  };

  const closeLogDetail = () => {
    setSelectedLogId(null);
    setSelectedLogDetail(null);
    setSelectedLogError("");
    setSelectedLogLoading(false);
  };

  const deleteLog = async (id: string) => {
    await mutate(async () => {
      await api.deleteLog(id);
      setSnapshot((current) => (current ? { ...current, requestLogs: current.requestLogs.filter((log) => log.id !== id) } : current));
      setLogsTotal((current) => Math.max(0, current - 1));
      if (selectedLogId === id) closeLogDetail();
    }, "日志已删除");
  };

  const clearLogs = async () => {
    await mutate(async () => {
      await api.clearLogs();
      setSnapshot((current) => (current ? { ...current, requestLogs: [] } : current));
      setLogsTotal(0);
      closeLogDetail();
    }, "日志已清空");
  };

  useEffect(() => {
    bootstrap();
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    const mobileQuery = window.matchMedia("(max-width: 767px)");
    const keyboardInputTypes = new Set(["", "email", "number", "password", "search", "tel", "text", "url"]);

    const hasKeyboardInputFocus = () => {
      const element = document.activeElement;
      if (element instanceof HTMLTextAreaElement) return true;
      if (!(element instanceof HTMLInputElement)) return false;
      return keyboardInputTypes.has(element.type);
    };

    const updateKeyboardState = () => {
      const visualHeight = viewport?.height ?? window.innerHeight;
      const viewportOffsetTop = viewport?.offsetTop ?? 0;
      const keyboardInset = Math.max(0, window.innerHeight - visualHeight - viewportOffsetTop);
      const screenHeight = window.screen?.height || window.innerHeight;
      const viewportCompressed = screenHeight - visualHeight > 160;
      const keyboardVisible = mobileQuery.matches && hasKeyboardInputFocus() && (keyboardInset > 80 || viewportCompressed);

      document.documentElement.classList.toggle("keyboard-visible", keyboardVisible);
    };

    updateKeyboardState();
    viewport?.addEventListener("resize", updateKeyboardState);
    viewport?.addEventListener("scroll", updateKeyboardState);
    mobileQuery.addEventListener("change", updateKeyboardState);
    window.addEventListener("resize", updateKeyboardState);
    window.addEventListener("focusin", updateKeyboardState);
    window.addEventListener("focusout", updateKeyboardState);

    return () => {
      viewport?.removeEventListener("resize", updateKeyboardState);
      viewport?.removeEventListener("scroll", updateKeyboardState);
      mobileQuery.removeEventListener("change", updateKeyboardState);
      window.removeEventListener("resize", updateKeyboardState);
      window.removeEventListener("focusin", updateKeyboardState);
      window.removeEventListener("focusout", updateKeyboardState);
      document.documentElement.classList.remove("keyboard-visible");
    };
  }, []);

  useEffect(() => {
    const themeId = snapshot?.settings.themeId || "fresh";
    document.documentElement.dataset.theme = themeId;
    document.documentElement.style.colorScheme = themeId === "midnight" ? "dark" : "light";
    updateSiteChromeFromTheme();
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
    loadInitialLogs();
  }, [authStatus, section]);

  useEffect(() => {
    if (authStatus !== "signed-in" || section !== "logs" || !logsAutoRefresh) return;
    const interval = window.setInterval(() => {
      refreshLogs();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [authStatus, section, logsAutoRefresh, snapshot?.requestLogs[0]?.createdAt]);

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
    }, "上游密钥分组已保存");
  };

  const importTemporaryAccounts = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    (async () => {
      const result = await api.importTemporaryAccounts({
        name: temporaryAccountDraft.name,
        providerType: temporaryAccountDraft.providerType,
        content: temporaryAccountDraft.content,
        contents: temporaryAccountDraft.contents,
        checkProxy: temporaryAccountCheckProxy
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
      const result = await api.checkTemporaryAccounts({ providerType: temporaryAccountCheckProviderType, proxy: temporaryAccountCheckProxy });
      const temporaryAccountGroups = await api.listTemporaryAccountGroups();
      setSnapshot((current) => (current ? { ...current, temporaryAccountGroups } : current));
      setTemporaryAccountsLoaded(true);
      setTemporaryAccountsLoading(false);
      setToast(`${temporaryAccountProviderLabels[temporaryAccountCheckProviderType]} 账号检查完成：${temporaryAccountCheckSummary(result)}`);
    } catch (error) {
      if (!handleUnauthorized(error)) setToast(error instanceof Error ? error.message : "临时账号检查失败");
    } finally {
      setTemporaryAccountChecking(null);
    }
  };

  const checkTemporaryAccount = async (id: string) => {
    if (temporaryAccountChecking) return;
    setTemporaryAccountChecking(id);
    try {
      const result = await api.checkTemporaryAccount(id, { proxy: temporaryAccountCheckProxy });
      const temporaryAccountGroups = await api.listTemporaryAccountGroups();
      setSnapshot((current) => (current ? { ...current, temporaryAccountGroups } : current));
      setTemporaryAccountsLoaded(true);
      setTemporaryAccountsLoading(false);
      setToast(`GPT 账号刷新完成：${temporaryAccountCheckSummary(result)}`);
    } catch (error) {
      if (!handleUnauthorized(error)) setToast(error instanceof Error ? error.message : "临时账号刷新失败");
    } finally {
      setTemporaryAccountChecking(null);
    }
  };

  const updateTemporaryAccount = async (id: string, patch: Partial<TemporaryAccount>) => {
    if (temporaryAccountUpdating) return;
    setTemporaryAccountUpdating(id);
    try {
      await api.updateTemporaryAccount(id, patch);
      const temporaryAccountGroups = await api.listTemporaryAccountGroups();
      setSnapshot((current) => (current ? { ...current, temporaryAccountGroups } : current));
      setTemporaryAccountsLoaded(true);
      setTemporaryAccountsLoading(false);
      setToast("临时账号已更新");
    } catch (error) {
      if (!handleUnauthorized(error)) setToast(error instanceof Error ? error.message : "临时账号更新失败");
    } finally {
      setTemporaryAccountUpdating(null);
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
    const currentTypeAccountIds = new Set(
      (snapshot?.temporaryAccountGroups || [])
        .filter((group) => (group.providerType || "gpt") === temporaryAccountCheckProviderType)
        .flatMap((group) => group.accounts.map((account) => account.id))
    );
    const idsToDelete = selectedTemporaryAccountIds.filter((id) => currentTypeAccountIds.has(id));
    if (temporaryAccountDeleting || idsToDelete.length === 0) return;
    setTemporaryAccountDeleting("batch");
    try {
      await api.deleteTemporaryAccounts(idsToDelete);
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
    }, "请求头模板已保存");
  };

  const apiKeyModelOptions = useMemo(() => (snapshot?.routes || []).filter((route) => route.enabled).map((route) => route.name).sort(), [snapshot?.routes]);

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
        kind: apiKey.kind || "api-key",
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
      const result = await api.discoverProviderModels(providerKeyDraft.siteId, apiKey?.secret || "", apiKey?.label || "", apiKey?.kind);
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
    setKeyModelsText("");
    setEditingKeyId(null);
    setCreatedKey(null);
    setKeyEditorOpen(true);
  };

  const openEditKey = (key: AppSnapshot["apiKeys"][number]) => {
    setKeyName(key.name);
    setKeyModelsText(serializeModelText(key.models || []));
    setEditingKeyId(key.id);
    setCreatedKey(null);
    setKeyEditorOpen(true);
  };

  const closeKeyEditor = () => {
    setKeyEditorOpen(false);
    setEditingKeyId(null);
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
                onDelete={(id) => mutate(async () => api.deleteProviderKeyGroup(id), "上游密钥分组已删除")}
              />
            )}
            {section === "temporaryAccounts" && (
              <TemporaryAccountsView
                snapshot={snapshot}
                draft={temporaryAccountDraft}
                editorOpen={temporaryAccountEditorOpen}
                busy={busy}
                checking={temporaryAccountChecking}
                checkProviderType={temporaryAccountCheckProviderType}
                onCheckProviderTypeChange={(providerType) => {
                  setTemporaryAccountCheckProviderType(providerType);
                  setSelectedTemporaryAccountIds([]);
                }}
                checkProxy={temporaryAccountCheckProxy}
                onCheckProxyChange={setTemporaryAccountCheckProxy}
                updating={temporaryAccountUpdating}
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
                onCheckAccount={checkTemporaryAccount}
                onUpdateAccount={updateTemporaryAccount}
                onDeleteAccount={deleteTemporaryAccount}
                onDeleteSelected={deleteSelectedTemporaryAccounts}
              />
            )}
            {section === "keys" && (
              <KeysView
                snapshot={snapshot}
                keyName={keyName}
                keyModelsText={keyModelsText}
                modelOptions={apiKeyModelOptions}
                editorOpen={keyEditorOpen}
                editingKeyId={editingKeyId}
                createdKey={createdKey}
                onKeyName={setKeyName}
                onKeyModelsText={setKeyModelsText}
                onSubmit={() =>
                  mutate(async () => {
                    const models = parseModelText(keyModelsText);
                    if (editingKeyId) {
                      await api.updateKey(editingKeyId, { name: keyName, models });
                      setKeyEditorOpen(false);
                    } else {
                      const key = await api.createKey(keyName, models);
                      setCreatedKey(key);
                    }
                  }, editingKeyId ? "密钥已更新" : "密钥已生成")
                }
                onClose={closeKeyEditor}
                onEdit={openEditKey}
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
                onDelete={(id) => mutate(async () => api.deleteHeader(id), "请求头模板已删除")}
              />
            )}
            {section === "logs" && (
              <LogsView
                snapshot={snapshot}
                total={logsTotal}
                pageSize={LOGS_PAGE_SIZE}
                autoRefresh={logsAutoRefresh}
                refreshing={logsRefreshing}
                loadingMore={logsLoadingMore}
                selectedLogId={selectedLogId}
                onAutoRefresh={setLogsAutoRefresh}
                onLoadMore={loadMoreLogs}
                onOpenLog={openLogDetail}
                onCloseLog={closeLogDetail}
                onDelete={deleteLog}
                onClear={clearLogs}
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
            {selectedLogId ? (
              <LogDetailModal
                log={selectedLogDetail}
                loading={selectedLogLoading}
                error={selectedLogError}
                onClose={closeLogDetail}
                onDelete={deleteLog}
              />
            ) : null}
            <div className={`app-scrollbar-float ${appScrollbarVisible && appScrollbarThumb.scrollable ? "app-scrollbar-float-visible" : ""}`}>
              <div
                className="app-scrollbar-thumb"
                onPointerCancel={stopAppScrollbarDrag}
                onPointerDown={startAppScrollbarDrag}
                onPointerMove={moveAppScrollbarDrag}
                onPointerUp={stopAppScrollbarDrag}
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
