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
import { useLogAutoScroll } from "../app/useLogAutoScroll";
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
  RequestLogPhase,
  RequestLogSummary,
  RequestLogStatus,
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
  uniqueMembers
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
  const successCount = logs.filter((log) => log.phase === "returned").length;
  const waitingToolsCount = logs.filter((log) => log.phase === "waiting-tools").length;
  const failedCount = logs.filter((log) => log.result.status === "failed").length;
  const cancelledCount = logs.filter((log) => log.result.status === "cancelled").length;
  const pendingCount = logs.filter((log) => log.result.status === "pending").length;
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
          已加载 {logs.length} / 共 {props.total} 次用户输入 / 已返回 {successCount} / 失败 {failedCount}{cancelledCount ? ` / 已取消 ${cancelledCount}` : ""}{pendingCount ? ` / 进行中 ${pendingCount}` : ""}{waitingToolsCount ? ` / 等待工具 ${waitingToolsCount}` : ""} / 2 秒刷新
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

function logStatusLabel(status: RequestLogStatus) {
  if (status === "success") return "成功";
  if (status === "pending") return "请求中";
  if (status === "cancelled") return "已取消";
  return "失败";
}

function logPhaseLabel(phase: RequestLogPhase) {
  return ({ running: "进行中", "waiting-tools": "等待工具回传", returned: "已返回", failed: "失败", cancelled: "已取消" })[phase];
}

function LogSummaryRow(props: { log: RequestLogSummary; selected: boolean; onOpen: (id: string) => void; onCopy: (value: string) => void }) {
  const { log } = props;
  return (
    <article className={`log-row ${props.selected ? "log-row-selected" : ""}`}>
      <button type="button" className="log-copy-id" title={`复制日志 ID: ${log.id}`} aria-label="复制日志 ID" onClick={() => props.onCopy(log.id)}>
        <Copy className="h-4 w-4" />
      </button>
      <button type="button" className="log-summary log-summary-card" onClick={() => props.onOpen(log.id)}>
        <span className="log-flow-cell">
          <span className="log-flow-block">
            <span className="summary-node-label">当次用户输入</span>
            <span className="log-main-value" title={log.msg}>{log.msg || "无用户消息"}</span>
            <span className="log-sub-value">{log.requestCount} 次接口调用 · {log.attemptCount} 次上游请求{log.toolCount ? ` · ${log.toolCount} 个工具` : ""}</span>
          </span>
          <span className="log-flow-block">
            <span className="summary-node-label">结果上游</span>
            <span className="log-main-value" title={log.upstream?.model}>{log.upstream?.model || "尚未转发"}</span>
            <span className="log-sub-value" title={log.upstream?.url}>{log.upstream?.provider || "—"}</span>
          </span>
        </span>
        <span className="log-state-cell">
          <span className="log-state-line">
            <span className={`status-badge status-${log.phase === "waiting-tools" ? "pending" : log.result.status}`}>{logPhaseLabel(log.phase)}</span>
            <span className="log-time-value" title={`开始：${formatTime(log.createdAt)}`}>{formatTime(log.updatedAt)}</span>
          </span>
          {log.result.status === "failed" && log.result.body ? <span className="log-error-snippet" title={log.result.body}>{log.result.body}</span> : null}
        </span>
      </button>
    </article>
  );
}

export function LogDetailModal(props: { log: RequestLog | null; loading: boolean; error: string; onClose: () => void; onDelete: (id: string) => void }) {
  const log = props.log;
  const scrollRef = useLogAutoScroll(log?.id, log?.revision);
  const awaitingResult = log?.phase === "running" || log?.phase === "waiting-tools";
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel log-detail-modal" role="dialog" aria-modal="true" aria-label="日志详情">
        <div className="form-head">
          <div>
            <h2>本次消息的调用日志</h2>
            {log ? (
              <div className="log-detail-heading-meta">
                <div className="log-detail-id" title={log.id}>ID: {log.id}</div>
                <div className="mt-1 text-xs font-bold text-ink/55">开始 {formatTime(log.createdAt)} · 更新 {formatTime(log.updatedAt)}</div>
              </div>
            ) : (
              <div className="mt-1 text-xs font-bold text-ink/55">正在获取完整日志</div>
            )}
          </div>
          <ActionButton type="button" tone="ghost" onClick={props.onClose} title="关闭">
            <X className="h-4 w-4" />
          </ActionButton>
        </div>
        <div className="log-detail-modal-body" ref={scrollRef}>
          {props.loading ? <div className="empty-state">正在加载日志详情...</div> : null}
          {props.error ? <div className="empty-state">{props.error}</div> : null}
          {log && !props.loading ? (
            <>
              <div className="detail-grid" key={log.id}>
                <div className="detail-block detail-wide">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="detail-title">当次用户输入</div>
                    <span className={`status-badge status-${log.phase === "waiting-tools" ? "pending" : log.result.status}`}>{logPhaseLabel(log.phase)}</span>
                  </div>
                  <pre>{log.msg[0] || "此请求未携带用户输入"}</pre>
                </div>
                <section className="detail-block detail-wide log-final-result" aria-label={awaitingResult ? "当前结果" : "最终结果"}>
                  <div className="log-call-heading">
                    <strong>{awaitingResult ? "当前结果" : "最终结果"}</strong>
                    <span className={`status-badge status-${log.phase === "waiting-tools" ? "pending" : log.result.status}`}>{logPhaseLabel(log.phase)}{log.result.statusCode ? ` · ${log.result.statusCode}` : ""}</span>
                  </div>
                  {log.upstream ? (
                    <div className="log-final-upstream">
                      <div className="log-upstream-target">{log.upstream.provider} · {log.upstream.model}</div>
                      <div className="log-upstream-url">{log.upstream.url}</div>
                    </div>
                  ) : null}
                  {awaitingResult ? <p className="log-sub-value">{log.phase === "waiting-tools" ? "等待工具回传，后续结果会自动更新。" : "内容随接口返回自动更新。"}</p> : null}
                  <pre>{log.result.body || (awaitingResult ? "等待上游返回…" : log.phase === "failed" ? "请求失败，未收到返回内容。" : log.phase === "cancelled" ? "请求已取消，未收到返回内容。" : "上游未返回文本内容。")}</pre>
                </section>
                <details className="detail-block detail-wide log-flow-details log-shared-headers">
                  <summary>下游请求头 <span className="log-sub-value">本轮首个请求</span></summary>
                  <pre>{prettyJson(log.requestHeaders)}</pre>
                </details>
                <details className="detail-block detail-wide log-flow-details log-call-chain">
                  <summary>调用过程 <span className="log-sub-value">{log.calls.length} 次接口调用 · {log.calls.reduce((count, call) => count + call.attempts.length, 0)} 次上游请求{log.tools.length ? ` · ${log.tools.length} 个工具` : ""}</span></summary>
                  <ol className="log-call-list">
                    {log.calls.map((call, index) => (
                      <li className="log-call" key={call.id}>
                        <div className="log-call-heading">
                          <strong>接口调用 {index + 1}</strong>
                          <span>{formatTime(call.createdAt)}</span>
                          <span className={`status-badge status-${call.result.status}`}>{logStatusLabel(call.result.status)}</span>
                        </div>
                        {call.attempts.map((attempt, attemptIndex) => (
                          <section className="log-upstream-attempt" key={attempt.id}>
                            <div className="log-call-heading">
                              <strong>上游请求 {attemptIndex + 1}</strong>
                              <span className={`status-badge status-${attempt.result.status}`}>{logStatusLabel(attempt.result.status)}{attempt.result.statusCode ? ` · ${attempt.result.statusCode}` : ""}</span>
                            </div>
                            <div className="log-upstream-target">{attempt.upstream?.provider} · {attempt.upstream?.model}</div>
                            <div className="log-upstream-url">{attempt.upstream?.url}</div>
                            <details className="log-flow-details">
                              <summary>上游结果</summary>
                              <pre>{attempt.result.body || (attempt.result.status === "pending" ? "等待上游返回…" : "无返回内容")}</pre>
                            </details>
                          </section>
                        ))}
                        {!call.attempts.length ? <pre>{call.result.body || "正在接收请求，等待转发…"}</pre> : null}
                        {log.tools.filter((tool) => tool.requestId === call.id).map((tool) => (
                          <details className="log-tool-result log-flow-details" key={tool.id}>
                            <summary>
                              <span>工具调用 · {tool.name}</span>
                              <span className={`status-badge status-${tool.status}`}>{tool.status === "pending" ? "等待回传" : tool.status === "failed" ? "工具报错" : tool.status === "cancelled" ? "未完成" : "已回传"}</span>
                            </summary>
                            {tool.resultRequestId ? <div className="log-sub-value">在接口调用 {log.calls.findIndex((item) => item.id === tool.resultRequestId) + 1} 中回传 · {formatTime(tool.updatedAt)}</div> : null}
                            <pre>{tool.result || (tool.status === "pending" ? "工具结果会在客户端回传后显示。" : "工具未返回文本内容")}</pre>
                          </details>
                        ))}
                      </li>
                    ))}
                  </ol>
                </details>
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
              <p>每次请求独立计算重试次数，所有重试追加在原会话日志中。599 包括连接失败、响应超时、空响应、错误响应及开始输出前的流错误。同一请求已发送实际内容，或客户端已取消时，不再重试。</p>
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

function DetailBlock(props: { title: string; value: unknown; wide?: boolean }) {
  return (
    <div className={`detail-block${props.wide ? " detail-wide" : ""}`}>
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
