import {
  AlertTriangle,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Database,
  Download,
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
import type {
  AppBackup,
  AppBackupImportResult,
  AppSettings,
  AppSnapshot,
  AppThemeId,
  ApiKeyCreated,
  EndpointKind,
  GroupRoute,
  GroupRouteMember,
  GroupRouteStrategy,
  HeaderTemplate,
  ProviderApiKeyGroupView,
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
  TemporaryAccountGroup,
  TemporaryAccountProviderType
} from "../../shared/types";
import {
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
  themeOptions
} from "../app/constants";
import type {
  HeaderKeyValue,
  HeaderTemplateDraft,
  ProviderApiKeyDraft,
  ProviderKeyGroupDraft,
  ProviderModelOption,
  RouteDraft,
  TemporaryAccountImportDraft
} from "../app/types";
import {
  apiOrigin,
  emptyRoute,
  emptyProviderApiKey,
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
  temporaryAccountQuotaPercent,
  temporaryAccountQuotaText,
  temporaryAccountTypeLabel,
  uniqueMembers,
  upstreamRequestSummary,
  upstreamRequestBody
} from "../app/utils";
import { ActionButton, SelectInput, TextInput } from "../components/ui";

export function LogsView(props: {
  snapshot: AppSnapshot;
  total: number;
  pageSize: number;
  autoRefresh: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  selectedLogId: string | null;
  onAutoRefresh: (enabled: boolean) => void;
  onLoadMore: () => void;
  onOpenLog: (id: string) => void;
  onCloseLog: () => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  onCopy: (value: string) => void;
}) {
  const logs = props.snapshot.requestLogs;
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const successCount = logs.filter((log) => log.status === "success").length;
  const failedCount = logs.filter((log) => log.status === "failed").length;
  const cancelledCount = logs.filter((log) => log.status === "cancelled").length;
  const pendingCount = logs.filter((log) => log.status === "pending").length;
  const hasMore = logs.length < props.total;

  useEffect(() => {
    const element = loadMoreRef.current;
    if (!element || !hasMore || props.loadingMore || props.refreshing) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) props.onLoadMore();
    }, { rootMargin: "160px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, props.loadingMore, props.refreshing, props.onLoadMore, logs.length]);

  const header = (
    <div className="form-head">
      <div>
        <h2>请求日志</h2>
        <div className="mt-1 text-xs font-bold text-ink/55">
          已加载 {logs.length} / 共 {props.total} 条 / 成功 {successCount} / 失败 {failedCount}{cancelledCount ? ` / 已取消 ${cancelledCount}` : ""}{pendingCount ? ` / 请求中 ${pendingCount}` : ""} / 5 秒刷新
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <label className="toggle-row">
          <input type="checkbox" checked={props.autoRefresh} onChange={(event) => props.onAutoRefresh(event.target.checked)} />
          自动刷新
        </label>
        {props.total > 0 ? (
          <ActionButton tone="danger" onClick={props.onClear}>
            <Trash2 className="h-4 w-4" />
            清空
          </ActionButton>
        ) : null}
      </div>
    </div>
  );

  return (
    <section className="panel p-4">
      {header}
      {logs.length === 0 ? (
        <div className="center-empty">暂无日志</div>
      ) : (
        <>
          <div className="site-list log-table">
            {logs.map((log) => (
              <LogSummaryRow key={log.id} log={log} selected={props.selectedLogId === log.id} onOpen={props.onOpenLog} onCopy={props.onCopy} />
            ))}
          </div>
          <div ref={loadMoreRef} className="logs-load-more">
            {props.loadingMore ? "正在加载更多日志..." : hasMore ? "滚动到底部自动加载更多" : "已加载全部日志"}
          </div>
        </>
      )}
    </section>
  );
}

function logStatusLabel(status: RequestLogSummary["status"]) {
  if (status === "success") return "成功";
  if (status === "pending") return "请求中";
  if (status === "cancelled") return "已取消";
  return "失败";
}

function compactFailureReason(message?: string) {
  const text = (message || "")
    .replace(/\s+/g, " ")
    .replace(/^上游地址均不可用[：:]\s*/, "")
    .trim();
  if (!text) return "";
  const firstReason = text.split(/[；;]/)[0]?.trim() || text;
  return firstReason.length > 96 ? `${firstReason.slice(0, 95)}...` : firstReason;
}

function LogContextItem(props: { label: string; value?: string }) {
  const value = props.value || "未记录";
  return (
    <span className="log-context-item" title={`${props.label}: ${value}`}>
      <span className="log-context-label">{props.label}</span>
      <span className="log-context-value">{value}</span>
    </span>
  );
}

function LogSummaryRow(props: { log: RequestLogSummary; selected: boolean; onOpen: (id: string) => void; onCopy: (value: string) => void }) {
  const { log } = props;
  const downstream = log.downstream;
  const routeTarget = log.routeTarget;
  const downstreamPath = downstream.path || downstream.endpoint || "-";
  const targetProvider = routeTarget.providerName || log.providerName || "-";
  const proxyLabel = log.proxy ? routeProxyModeLabels[log.proxy.mode] : "直连";
  const failureReason = log.status === "failed" ? compactFailureReason(log.errorMessage) : "";
  return (
    <article className={`log-row ${props.selected ? "log-row-selected" : ""}`}>
      <button type="button" className="log-copy-id" title={`复制日志 ID: ${log.id}`} aria-label="复制日志 ID" onClick={() => props.onCopy(log.id)}>
        <Copy className="h-4 w-4" />
      </button>
      <button type="button" className="log-summary log-summary-card" onClick={() => props.onOpen(log.id)}>
        <span className="log-flow-cell">
          <span className="log-flow-block">
            <span className="summary-node-label">下游请求</span>
            <span className="log-main-value" title={downstream.model || log.routeName || "-"}>
              {downstream.model || log.routeName || "-"}
            </span>
            <span className="log-sub-value" title={downstreamPath}>
              {downstreamPath}
            </span>
          </span>
          <span className="log-flow-block">
            <span className="summary-node-label">转发目标</span>
            <span className="log-main-value" title={routeTarget.model || log.model || "-"}>
              {routeTarget.model || log.model || "-"}
            </span>
            <span className="log-sub-value" title={targetProvider}>
              {targetProvider}
            </span>
          </span>
        </span>
        <span className="log-state-cell">
          <span className="log-state-line">
            <span className={`status-badge status-${log.status}`}>{logStatusLabel(log.status)}</span>
            <span className="log-time-value">{formatTime(log.createdAt)}</span>
          </span>
          {failureReason ? (
            <span className="log-error-snippet" title={log.errorMessage}>
              {failureReason}
            </span>
          ) : null}
        </span>
        <span className="log-context-row">
          <LogContextItem label="请求头" value={log.headerTemplateName || "未使用"} />
          <LogContextItem label="代理" value={proxyLabel} />
          <LogContextItem label="客户端" value={log.clientDevice || "未知客户端"} />
          <LogContextItem label="来源 IP" value={log.clientIp || "未知"} />
          <LogContextItem label="API Key" value={log.apiKeyName} />
        </span>
      </button>
    </article>
  );
}

export function LogDetailModal(props: { log: RequestLog | null; loading: boolean; error: string; onClose: () => void; onDelete: (id: string) => void }) {
  const log = props.log;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel log-detail-modal" role="dialog" aria-modal="true" aria-label="日志详情">
        <div className="form-head">
          <div>
            <h2>日志详情</h2>
            {log ? (
              <div className="log-detail-heading-meta">
                <div className="log-detail-id" title={log.id}>ID: {log.id}</div>
                <div className="mt-1 text-xs font-bold text-ink/55">{log.routeName} / {formatTime(log.createdAt)}</div>
              </div>
            ) : (
              <div className="mt-1 text-xs font-bold text-ink/55">正在获取完整日志</div>
            )}
          </div>
          <ActionButton type="button" tone="ghost" onClick={props.onClose} title="关闭">
            <X className="h-4 w-4" />
          </ActionButton>
        </div>
        <div className="log-detail-modal-body">
          {props.loading ? <div className="empty-state">正在加载日志详情...</div> : null}
          {props.error ? <div className="empty-state">{props.error}</div> : null}
          {log && !props.loading ? (
            <>
              <div className="detail-grid">
              <LogSummaryDetail log={log} />
              <DownstreamHeadersDetail log={log} />
              <DetailBlock title="下游 Body" value={log.requestBody} />
              <ForwardingTargetDetail log={log} />
              <UpstreamRequestDetail log={log} />
              <DetailBlock
                title="返回"
                wide
                value={{
                  status: log.status,
                  statusCode: log.statusCode,
                  durationMs: log.durationMs,
                  contentType: log.upstreamContentType,
                  preview: log.responsePreview,
                  error: log.errorMessage || undefined
                }}
              />
              </div>
              <div className="mt-3 flex justify-end">
                <ActionButton tone="danger" onClick={() => props.onDelete(log.id)}>
                  <Trash2 className="h-4 w-4" />
                  删除日志
                </ActionButton>
              </div>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export function SettingsView(props: {
  snapshot: AppSnapshot;
  busy: boolean;
  onRefresh: () => void;
  onSave: (settings: Partial<AppSettings>) => void;
  onPasswordChange: (currentPassword: string, nextPassword: string) => Promise<void>;
  onThemeChange: (themeId: AppThemeId) => void;
  onExportBackup: () => Promise<AppBackup>;
  onImportBackup: (backup: AppBackup) => Promise<AppBackupImportResult>;
}) {
  const [maxRequestLogs, setMaxRequestLogs] = useState(String(props.snapshot.settings.maxRequestLogs));
  const [requestTimeoutSeconds, setRequestTimeoutSeconds] = useState(String(props.snapshot.settings.requestTimeoutSeconds || 60));
  const [adminSessionTtlMinutes, setAdminSessionTtlMinutes] = useState(String(props.snapshot.settings.adminSessionTtlMinutes || 30));
  const [themeId, setThemeId] = useState<AppThemeId>(props.snapshot.settings.themeId || "fresh");
  const [retryCodeCounts, setRetryCodeCounts] = useState(props.snapshot.settings.upstreamRetryCodeCounts);
  const [retryStatusCode, setRetryStatusCode] = useState("");
  const [retryCount, setRetryCount] = useState("");
  const [retryError, setRetryError] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [backupError, setBackupError] = useState("");
  const [pendingBackup, setPendingBackup] = useState<AppBackup | null>(null);
  const backupFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setMaxRequestLogs(String(props.snapshot.settings.maxRequestLogs));
    setRequestTimeoutSeconds(String(props.snapshot.settings.requestTimeoutSeconds || 60));
    setAdminSessionTtlMinutes(String(props.snapshot.settings.adminSessionTtlMinutes || 30));
    setThemeId(props.snapshot.settings.themeId || "fresh");
    setRetryCodeCounts(props.snapshot.settings.upstreamRetryCodeCounts);
  }, [props.snapshot.settings.adminSessionTtlMinutes, props.snapshot.settings.maxRequestLogs, props.snapshot.settings.requestTimeoutSeconds, props.snapshot.settings.themeId, props.snapshot.settings.upstreamRetryCodeCounts]);

  const chooseTheme = (nextThemeId: AppThemeId) => {
    setThemeId(nextThemeId);
    props.onThemeChange(nextThemeId);
  };

  const addRetryCodeCount = () => {
    setRetryError("");
    const statusCode = Number(retryStatusCode);
    const count = Number(retryCount);
    if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
      setRetryError("状态码需要是 400-599 之间的整数");
      return;
    }
    if (!Number.isInteger(count) || count < 0) {
      setRetryError("重试次数需要是不小于 0 的整数");
      return;
    }
    setRetryCodeCounts((current) => {
      const next = current.filter((item) => item.statusCode !== statusCode);
      next.push({ statusCode, count });
      return next.sort((a, b) => a.statusCode - b.statusCode);
    });
    setRetryStatusCode("");
    setRetryCount("");
  };

  const removeRetryCodeCount = (statusCode: number) => {
    setRetryCodeCounts((current) => current.filter((item) => item.statusCode !== statusCode));
  };

  const updateRetryCount = (statusCode: number, count: number) => {
    setRetryCodeCounts((current) => current.map((item) => (item.statusCode === statusCode ? { statusCode, count } : item)));
  };

  // number 输入框的步进按钮 / 上下方向键 / 滚轮会按 step 调整值（如 500 → 499），
  // 状态码和重试次数都禁止这种隐式步进，只允许直接输入数字。
  const preventNumberStep = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") event.preventDefault();
  };

  const preventNumberWheel = (event: React.WheelEvent<HTMLInputElement>) => {
    event.currentTarget.blur();
  };

  // 只保留数字字符：去掉 e/E、+、-、小数点，避免 1e3 或 2.5 之类被 Number() 解析。
  const digitsOnlyOnChange =
    (setter: (value: string) => void) => (event: React.ChangeEvent<HTMLInputElement>) => {
      setter(event.target.value.replace(/[^\d]/g, ""));
    };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSave({
      maxRequestLogs: Number(maxRequestLogs),
      requestTimeoutSeconds: Number(requestTimeoutSeconds),
      adminSessionTtlMinutes: Number(adminSessionTtlMinutes),
      themeId,
      upstreamRetryCodeCounts: retryCodeCounts
    });
  };

  const changePassword = async () => {
    setPasswordError("");
    if (!currentPassword.trim()) {
      setPasswordError("请输入当前管理密码");
      return;
    }
    if (nextPassword.length < 4 || !nextPassword.trim()) {
      setPasswordError("新管理密码至少需要 4 个字符");
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

  const exportBackup = async () => {
    setBackupError("");
    try {
      const backup = await props.onExportBackup();
      const date = backup.exportedAt.slice(0, 10) || new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `samapi-backup-${date}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : "导出备份失败");
    }
  };

  const chooseBackupFile = async (files: FileList | null) => {
    setBackupError("");
    setPendingBackup(null);
    const file = files?.[0];
    if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("备份文件不能超过 20 MB");
      const parsed = JSON.parse(await file.text()) as Partial<AppBackup>;
      if (parsed.format !== "samapi-backup" || parsed.version !== 1 || !parsed.data) {
        throw new Error("请选择由 SamAPI 导出的有效备份文件");
      }
      const data = parsed.data as Partial<AppBackup["data"]>;
      if (
        !Array.isArray(data.sites) ||
        !Array.isArray(data.apiKeys) ||
        !Array.isArray(data.providerApiKeyGroups) ||
        !Array.isArray(data.temporaryAccountGroups) ||
        !Array.isArray(data.headerTemplates) ||
        !Array.isArray(data.routes) ||
        !Array.isArray(data.routeDisplayGroups)
      ) {
        throw new Error("备份文件结构不完整或已损坏");
      }
      setPendingBackup(parsed as AppBackup);
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : "读取备份文件失败");
    } finally {
      if (backupFileRef.current) backupFileRef.current.value = "";
    }
  };

  const importBackup = async () => {
    if (!pendingBackup) return;
    setBackupError("");
    try {
      await props.onImportBackup(pendingBackup);
      setPendingBackup(null);
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : "导入备份失败");
    }
  };

  const backupCounts = pendingBackup ? {
    sites: pendingBackup.data.sites.length,
    routes: pendingBackup.data.routes.length,
    providerKeys: pendingBackup.data.providerApiKeyGroups.length,
    temporaryAccounts: pendingBackup.data.temporaryAccountGroups.reduce((total, group) => total + group.accounts.length, 0)
  } : null;

  return (
    <>
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
              <h3>数据备份</h3>
              <p>导出或恢复全部业务配置。请求日志与管理员密码不会被导出，也不会在导入时被覆盖。</p>
            </div>
          </div>
          <div className="settings-backup-box">
            <div className="settings-backup-icon" aria-hidden="true"><Database className="h-5 w-5" /></div>
            <div className="settings-backup-copy">
              <strong>完整配置备份</strong>
              <span>包含站点、路由、上下游密钥、临时账号、请求头模板和系统设置。</span>
            </div>
            <span className="settings-backup-warning"><ShieldCheck className="h-4 w-4" />文件包含明文凭据，请存放在安全位置。</span>
            <div className="settings-backup-actions">
              <ActionButton type="button" tone="ghost" disabled={props.busy} onClick={() => void exportBackup()}>
                <Download className="h-4 w-4" />
                导出备份
              </ActionButton>
              <ActionButton type="button" tone="ghost" disabled={props.busy} onClick={() => backupFileRef.current?.click()}>
                <Upload className="h-4 w-4" />
                导入备份
              </ActionButton>
              <input
                ref={backupFileRef}
                className="settings-backup-file"
                type="file"
                accept=".json,application/json"
                onChange={(event) => void chooseBackupFile(event.target.files)}
              />
            </div>
          </div>
          {backupError ? <div className="auth-error mt-3" role="alert">{backupError}</div> : null}
        </div>

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
        <div className="settings-section form-span-2">
          <div className="settings-section-head">
            <div>
              <h3>上游请求超时</h3>
              <p>等待上游响应头的最长时间；流式响应开始后不会被此设置中断。</p>
            </div>
          </div>
          <label>
            超时秒数
            <TextInput
              type="number"
              min={1}
              max={600}
              step={1}
              value={requestTimeoutSeconds}
              onChange={(event) => setRequestTimeoutSeconds(event.target.value)}
            />
          </label>
        </div>
        <div className="settings-section form-span-2">
          <div className="settings-section-head">
            <div>
              <h3>上游错误码重试配置</h3>
              <p>上游返回对应状态码时，在换下一个目标地址之前重试的次数。只有在这里配置过的错误码才会重试；未配置的错误码不重试。配置 0 表示禁用该错误码的重试（立即换下一个目标地址）。</p>
            </div>
          </div>
          <div className="settings-retry-add-row">
            <label>
              状态码
              <TextInput
                type="number"
                min={400}
                max={599}
                step={1}
                placeholder="如 502"
                value={retryStatusCode}
                onChange={digitsOnlyOnChange(setRetryStatusCode)}
                onKeyDown={preventNumberStep}
                onWheel={preventNumberWheel}
              />
            </label>
            <label>
              重试次数
              <TextInput
                type="number"
                min={0}
                step={1}
                placeholder="不设上限"
                value={retryCount}
                onChange={digitsOnlyOnChange(setRetryCount)}
                onKeyDown={preventNumberStep}
                onWheel={preventNumberWheel}
              />
            </label>
            <ActionButton type="button" tone="ghost" disabled={props.busy} onClick={addRetryCodeCount}>
              <Plus className="h-4 w-4" />
              添加
            </ActionButton>
          </div>
          {retryError ? <div className="auth-error mt-3" role="alert">{retryError}</div> : null}
          {retryCodeCounts.length > 0 ? (
            <div className="settings-retry-list">
              {retryCodeCounts.map((item) => (
                <div key={item.statusCode} className="settings-retry-row">
                  <span className="settings-retry-code">HTTP {item.statusCode}</span>
                  <label className="settings-retry-count-label">
                    重试次数
                    <TextInput
                      type="number"
                      min={0}
                      step={1}
                      value={String(item.count)}
                      onChange={digitsOnlyOnChange((value) => {
                        const count = Number(value);
                        if (value === "" || Number.isInteger(count)) {
                          updateRetryCount(item.statusCode, value === "" ? 0 : count);
                        }
                      })}
                      onKeyDown={preventNumberStep}
                      onWheel={preventNumberWheel}
                    />
                  </label>
                  <button
                    type="button"
                    className="action action-ghost settings-retry-remove"
                    title="删除配置"
                    aria-label={`删除 HTTP ${item.statusCode} 的重试配置`}
                    onClick={() => removeRetryCodeCount(item.statusCode)}
                  >
                    <Trash2 className="h-4 w-4" />
                    删除
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="settings-retry-empty">还没有配置错误码重试次数。</p>
          )}
        </div>
        <div className="flex justify-end">
          <ActionButton type="submit">
            <Save className="h-4 w-4" />
            保存设置
          </ActionButton>
        </div>
      </form>
    </section>
    {pendingBackup && backupCounts ? (
      <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !props.busy) setPendingBackup(null);
      }}>
        <section className="modal-panel settings-import-modal" role="dialog" aria-modal="true" aria-label="确认导入备份">
          <div className="settings-import-symbol" aria-hidden="true"><AlertTriangle className="h-6 w-6" /></div>
          <div>
            <h2>确认覆盖现有配置？</h2>
            <p className="settings-import-description">导入会用备份中的业务配置替换当前配置，此操作无法在页面中撤销。当前请求日志和管理员密码将保留。</p>
          </div>
          <div className="settings-import-summary">
            <span><strong>{backupCounts.sites}</strong> 个站点</span>
            <span><strong>{backupCounts.routes}</strong> 条路由</span>
            <span><strong>{backupCounts.providerKeys}</strong> 个上游密钥分组</span>
            <span><strong>{backupCounts.temporaryAccounts}</strong> 个临时账号</span>
          </div>
          <div className="settings-import-meta">备份时间：{new Date(pendingBackup.exportedAt).toLocaleString("zh-CN")}</div>
          {backupError ? <div className="auth-error" role="alert">{backupError}</div> : null}
          <div className="settings-import-actions">
            <ActionButton type="button" tone="ghost" disabled={props.busy} onClick={() => setPendingBackup(null)}>取消</ActionButton>
            <ActionButton type="button" tone="danger" disabled={props.busy} onClick={() => void importBackup()}>
              <Upload className="h-4 w-4" />
              {props.busy ? "正在导入..." : "确认导入并覆盖"}
            </ActionButton>
          </div>
        </section>
      </div>
    ) : null}
    </>
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
        <span className={`status-badge status-${log.status}`}>{logStatusLabel(log.status)}</span>
      </div>
      <div className="summary-flow">
        <section className="summary-node">
          <div className="summary-node-label">下游请求</div>
          <div className="summary-node-main">{downstream.model || log.routeName || "-"}</div>
          <SummaryField label="Path" value={downstream.path || log.path} />
          <SummaryField label="UA" value={downstream.userAgent || log.userAgent || "unknown ua"} />
          <SummaryField label="客户端" value={log.clientDevice} />
          <SummaryField label="IP" value={log.clientIp} />
          <SummaryField label="API Key" value={log.apiKeyName} />
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
          <SummaryField label="代理" value={log.proxy ? routeProxyModeLabels[log.proxy.mode] : "直连"} />
        </section>
        <div className="summary-arrow">
          <ChevronRight className="h-4 w-4" />
        </div>
        <section className="summary-node summary-result">
          <div className="summary-node-label">返回</div>
          <div className="summary-node-main">{log.statusCode}</div>
          <SummaryField label="状态" value={logStatusLabel(log.status)} />
          <SummaryField label="耗时" value={`${log.durationMs}ms`} />
          <SummaryField label="时间" value={formatTime(log.createdAt)} />
        </section>
      </div>
    </div>
  );
}

function DetailBlock(props: { title: string; value: unknown; wide?: boolean }) {
  return (
    <div className={`detail-block${props.wide ? " detail-wide" : ""}`}>
      <div className="detail-title">{props.title}</div>
      <pre>{prettyJson(props.value)}</pre>
    </div>
  );
}

function SectionedDetailBlock(props: { title: string; summary: unknown; detail: unknown }) {
  return (
    <div className="detail-block detail-wide sectioned-detail">
      <div className="detail-title">{props.title}</div>
      <section className="detail-section">
        <div className="detail-section-title">总结</div>
        <pre>{prettyJson(props.summary)}</pre>
      </section>
      <section className="detail-section">
        <div className="detail-section-title">详细</div>
        <pre>{prettyJson(props.detail)}</pre>
      </section>
    </div>
  );
}

function DownstreamHeadersDetail(props: { log: RequestLog }) {
  const log = props.log;
  const downstream = log.downstream || { model: log.routeName, userAgent: log.userAgent };
  const { endpoint: _endpoint, ...downstreamWithoutEndpoint } = downstream;
  const summary = {
    ...downstreamWithoutEndpoint,
    method: log.method,
    path: log.path,
    clientIp: log.clientIp
  };

  return <SectionedDetailBlock title="下游请求头" summary={summary} detail={log.requestHeaders} />;
}

function ForwardingTargetDetail(props: { log: RequestLog }) {
  const log = props.log;
  const forwardingTarget = {
    ...(log.routeTarget || { routeName: log.routeName, model: log.model, endpoint: log.endpoint, providerName: log.providerName }),
    upstreamUrl: log.upstreamUrl,
    proxy_mode: log.proxy?.mode || "direct"
  };

  return <DetailBlock title="转发目标" value={forwardingTarget} wide />;
}

function UpstreamRequestDetail(props: { log: RequestLog }) {
  const log = props.log;
  return <SectionedDetailBlock title="上游请求" summary={upstreamRequestSummary(log)} detail={upstreamRequestBody(log)} />;
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

export function DocsView(props: { snapshot: AppSnapshot; onCopy: (value: string) => void }) {
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
      <div className="form-head">
        <div>
          <h2>接入配置</h2>
          <div className="mt-1 text-xs font-bold text-ink/55">下游客户端使用本地代理地址，把路由名当作模型名调用。</div>
        </div>
        <ActionButton tone="ghost" onClick={() => props.onCopy(ccSwitchConfig)}>
          <Copy className="h-4 w-4" />
          复制配置
        </ActionButton>
      </div>

      <div className="usage-summary-grid">
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

      <div className="usage-config-grid">
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
          <UsageCopyRow label="base_url" value={proxyBaseUrl} note="推荐给会自动拼接 /v1/messages 的客户端。" onCopy={props.onCopy} />
          <UsageCopyRow label="api_key" value="sk-samapi-..." note="从客户端密钥页面复制完整密钥，作为 Bearer Token 使用。" onCopy={props.onCopy} />
          <UsageCopyRow label="model" value={modelName} note="填写模型路由里的路由名称；分组路由也复制分组名称作为模型名。" onCopy={props.onCopy} />
          <UsageCopyRow label="models" value={`${proxyV1BaseUrl}/models`} note="用于下游获取可用模型列表，返回启用中的路由名称。" onCopy={props.onCopy} />
          <UsageCopyRow label="OpenAI base_url" value={proxyV1BaseUrl} note="如果客户端要求 base_url 已包含 /v1，可以使用这个地址。" onCopy={props.onCopy} />
        </div>
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
