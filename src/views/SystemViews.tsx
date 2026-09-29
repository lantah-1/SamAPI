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
  RequestLogAccount,
  RequestLogPhase,
  RequestLogResult,
  RequestLogStage,
  RequestLogUserAgent,
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
          已加载 {logs.length} / 共 {props.total} 条日志 / 已返回 {successCount} / 失败 {failedCount}{cancelledCount ? ` / 已取消 ${cancelledCount}` : ""}{pendingCount ? ` / 进行中 ${pendingCount}` : ""}{waitingToolsCount ? ` / 等待工具 ${waitingToolsCount}` : ""} / 2 秒刷新
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

const logStages: Record<RequestLogStage, { label: string; text: string }> = {
  "receiving-request": { label: "接收下游请求", text: "正在接收下游请求体…" },
  "preparing-upstream": { label: "准备上游请求", text: "下游请求已接收，正在准备上游请求…" },
  "waiting-upstream": { label: "等待上游响应", text: "正在请求上游，等待响应…" },
  "receiving-upstream": { label: "接收上游响应", text: "已收到上游响应，正在接收内容…" },
  "waiting-retry": { label: "等待重试", text: "上游请求未成功，等待重试…" },
  "forwarding-response": { label: "转发响应", text: "正在向下游转发响应…" }
};

function logStatusLabel(status: RequestLogStatus, stage?: RequestLogStage) {
  if (status === "success") return "成功";
  if (status === "pending") return stage ? logStages[stage]?.label || "请求中" : "请求中";
  if (status === "cancelled") return "已取消";
  return "失败";
}

function logPhaseLabel(phase: RequestLogPhase, stage?: RequestLogStage) {
  if (phase === "running" && stage) return logStages[stage]?.label || "进行中";
  return ({ running: "进行中", "waiting-tools": "等待工具回传", returned: "已返回", failed: "失败", cancelled: "已取消" })[phase];
}

function logResultPlaceholder(result: RequestLogResult) {
  if (result.status === "pending") return result.stage ? logStages[result.stage]?.text || "请求处理中…" : "请求处理中…";
  if (result.status === "failed") return "请求失败，未收到返回内容。";
  if (result.status === "cancelled") return "请求已取消，未收到返回内容。";
  return "请求已完成，未返回文本内容。";
}

function LogAccount({ account }: { account?: RequestLogAccount }) {
  return <span className="log-sub-value block truncate" title={account ? `${account.label} · ${account.id}` : undefined}>账号：{account?.label || "未记录"}</span>;
}

function logUserAgentHeaders(userAgent?: RequestLogUserAgent) {
  if (!userAgent) return { "X-Samapi-Upstream-User-Agent": "not recorded" };
  const sources = { template: "header template", downstream: "downstream request", codex: "Codex built-in", grok: "Grok OAuth built-in", default: "runtime default" };
  const template = userAgent.template?.name;
  const source = template ? userAgent.source === "downstream" ? `downstream request (matched template: ${template})` : `header template: ${template}` : sources[userAgent.source];
  return {
    "X-Samapi-Upstream-User-Agent": userAgent.value ?? "runtime default",
    "X-Samapi-Upstream-User-Agent-Source": source
  };
}

function LogSummaryRow(props: { log: RequestLogSummary; selected: boolean; onOpen: (id: string) => void; onCopy: (value: string) => void }) {
  const { log } = props;
  const models = log.kind === "models";
  const localModels = models && !log.upstream && log.result.status === "success";
  const input = models ? "获取可用模型列表" : log.msg || "无用户消息";
  return (
    <article className={`log-row ${props.selected ? "log-row-selected" : ""}`}>
      <button type="button" className="log-copy-id" title={`复制日志 ID: ${log.id}`} aria-label="复制日志 ID" onClick={() => props.onCopy(log.id)}>
        <Copy className="h-4 w-4" />
      </button>
      <button type="button" className="log-summary log-summary-card" onClick={() => props.onOpen(log.id)}>
        <span className="log-flow-cell">
          <span className="log-flow-block">
            <span className="summary-node-label">{models ? "获取模型" : "当次用户输入"}</span>
            <span className="log-main-value" title={input}>{input}</span>
            <span className="log-sub-value">{log.requestCount} 次接口调用 · {log.attemptCount} 次上游请求{log.toolCount ? ` · ${log.toolCount} 个工具` : ""}</span>
          </span>
          <span className="log-flow-block">
            <span className="summary-node-label">{models ? "模型来源" : "结果上游"}</span>
            <span className="log-main-value" title={log.upstream?.model}>{log.upstream?.model || (localModels ? "本地路由" : models ? "未请求上游" : "暂无上游信息")}</span>
            <span className="log-sub-value" title={log.upstream?.url}>{log.upstream?.provider || (localModels ? "无需请求上游" : "—")}</span>
            {log.upstream ? <LogAccount account={log.upstream.account} /> : null}
          </span>
        </span>
        <span className="log-state-cell">
          <span className="log-state-line">
            <span className={`status-badge status-${log.phase === "waiting-tools" ? "pending" : log.result.status}`}>{logPhaseLabel(log.phase, log.result.stage)}</span>
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
  const models = log?.kind === "models";
  const scrollRef = useLogAutoScroll(log?.id, log?.revision);
  const awaitingResult = log?.phase === "running" || log?.phase === "waiting-tools";
  const requesting = log?.phase === "running";
  const previousResult = requesting && !log?.result.body && log?.previousResultId
    ? log.calls.flatMap((call) => call.attempts.length ? call.attempts : [{ ...call, upstream: undefined }]).find((attempt) => attempt.id === log.previousResultId)
    : undefined;
  const displayedResult = previousResult?.result || log?.result;
  const pendingResult = log?.result.stage ? log.result : log?.calls.filter((call) => call.result.status === "pending").at(-1)?.result || log?.result;
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel log-detail-modal" role="dialog" aria-modal="true" aria-label="日志详情">
        <div className="form-head">
          <div>
            <h2>{models ? "获取模型日志" : "本次消息的调用日志"}</h2>
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
                    <div className="detail-title">{models ? "获取模型" : "当次用户输入"}</div>
                    <span className={`status-badge status-${log.phase === "waiting-tools" ? "pending" : log.result.status}`}>{logPhaseLabel(log.phase, log.result.stage)}</span>
                  </div>
                  <pre>{models ? log.upstream ? "从供应商获取可用模型列表" : log.result.status === "success" ? "从本地路由获取可用模型列表，无需请求上游" : "获取可用模型列表" : log.msg[0] || "此请求未携带用户输入"}</pre>
                </div>
                <section className="detail-block detail-wide log-final-result" aria-label={awaitingResult ? "当前结果" : "最终结果"}>
                  <div className="log-call-heading">
                    <strong>{awaitingResult ? "当前结果" : "最终结果"}</strong>
                  </div>
                  {displayedResult && (previousResult || !awaitingResult || displayedResult.body) ? (
                    <pre>{displayedResult.body || logResultPlaceholder(displayedResult)}</pre>
                  ) : null}
                  {awaitingResult ? (
                    <p className="log-sub-value mt-3" role="status">{requesting ? `请求中 · ${logResultPlaceholder(pendingResult || log.result)}` : "等待工具回传…"}</p>
                  ) : null}
                </section>
                <details className="detail-block detail-wide log-flow-details log-shared-headers">
                  <summary>下游请求头 <span className="log-sub-value">本轮首个请求</span></summary>
                  <pre>{prettyJson({ ...log.requestHeaders, ...logUserAgentHeaders(log.upstream?.userAgent) })}</pre>
                </details>
                <details className="detail-block detail-wide log-flow-details log-call-chain">
                  <summary>调用过程 <span className="log-sub-value">{log.calls.length} 次接口调用 · {log.calls.reduce((count, call) => count + call.attempts.length, 0)} 次上游请求{log.tools.length ? ` · ${log.tools.length} 个工具` : ""}</span></summary>
                  <ol className="log-call-list">
                    {log.calls.map((call, index) => (
                      <li className="log-call" key={call.id}>
                        <div className="log-call-heading">
                          <strong>接口调用 {index + 1}</strong>
                          <span>{formatTime(call.createdAt)}</span>
                          <span className={`status-badge status-${call.result.status}`}>{logStatusLabel(call.result.status, call.result.stage)}</span>
                        </div>
                        {call.attempts.map((attempt, attemptIndex) => (
                          <section className="log-upstream-attempt" key={attempt.id}>
                            <div className="log-call-heading">
                              <strong>上游请求 {attemptIndex + 1}</strong>
                              <span className={`status-badge status-${attempt.result.status}`}>{logStatusLabel(attempt.result.status, attempt.result.stage)}{attempt.result.statusCode ? ` · ${attempt.result.statusCode}` : ""}</span>
                            </div>
                            <div className="log-upstream-target">{attempt.upstream?.provider} · {attempt.upstream?.model}</div>
                            <LogAccount account={attempt.upstream?.account} />
                            <div className="log-upstream-url">{attempt.upstream?.url}</div>
                            <details className="log-flow-details">
                              <summary>上游结果</summary>
                              <pre>{attempt.result.body || logResultPlaceholder(attempt.result)}</pre>
                            </details>
                          </section>
                        ))}
                        {!call.attempts.length ? <pre>{call.result.body || logResultPlaceholder(call.result)}</pre> : null}
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
