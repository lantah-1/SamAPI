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
import type {
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
  upstreamAttemptsSummary,
  upstreamRequestBodies
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
          已加载 {logs.length} / 共 {props.total} 条 / 成功 {successCount} / 失败 {failedCount}{pendingCount ? ` / 请求中 ${pendingCount}` : ""} / 5 秒刷新
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
  return "失败";
}

function LogSummaryRow(props: { log: RequestLogSummary; selected: boolean; onOpen: (id: string) => void; onCopy: (value: string) => void }) {
  const { log } = props;
  const downstream = log.downstream;
  const routeTarget = log.routeTarget;
  const downstreamPath = downstream.path || downstream.endpoint || "-";
  const targetProvider = routeTarget.providerName || log.providerName || "-";
  const proxyLabel = log.proxy ? routeProxyModeLabels[log.proxy.mode] : "直连";
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
          <ChevronRight className="log-flow-arrow" />
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
        <span className="log-route-meta">
          <span className="log-meta-pill" title={log.headerTemplateName || "未使用"}>
            请求头: {log.headerTemplateName || "未使用"}
          </span>
          <span className="log-meta-pill" title={proxyLabel}>
            代理: {proxyLabel}
          </span>
        </span>
        <span className="log-state-cell">
          <span className={`status-badge status-${log.status}`}>{logStatusLabel(log.status)}</span>
          <span className="log-time-value">{formatTime(log.createdAt)}</span>
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
        <span className={`status-badge status-${log.status}`}>{logStatusLabel(log.status)}</span>
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

function DetailBlock(props: { title: string; value: unknown }) {
  return (
    <div className="detail-block">
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
  const summary = {
    ...(log.downstream || { model: log.routeName, endpoint: log.path, userAgent: log.userAgent }),
    method: log.method,
    path: log.path,
    clientIp: log.clientIp
  };

  return <SectionedDetailBlock title="下游请求头" summary={summary} detail={log.requestHeaders} />;
}

function ForwardingTargetDetail(props: { log: RequestLog }) {
  const log = props.log;
  const summary = {
    ...(log.routeTarget || { routeName: log.routeName, model: log.model, endpoint: log.endpoint, providerName: log.providerName }),
    routeId: log.routeId,
    upstreamUrl: log.upstreamUrl
  };

  return <SectionedDetailBlock title="转发目标" summary={summary} detail={log.proxy || { mode: "direct" }} />;
}

function UpstreamRequestDetail(props: { log: RequestLog }) {
  const log = props.log;
  return <SectionedDetailBlock title="上游请求" summary={upstreamAttemptsSummary(log)} detail={upstreamRequestBodies(log)} />;
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
