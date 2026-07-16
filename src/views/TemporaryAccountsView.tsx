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

export function TemporaryAccountsView(props: {
  snapshot: AppSnapshot;
  draft: TemporaryAccountImportDraft;
  editorOpen: boolean;
  busy: boolean;
  loading: boolean;
  error: string;
  checking: string | null;
  checkProviderType: Extract<TemporaryAccountProviderType, "gpt" | "grok">;
  onCheckProviderTypeChange: (providerType: Extract<TemporaryAccountProviderType, "gpt" | "grok">) => void;
  checkProxy: RouteProxyConfig;
  onCheckProxyChange: (proxy: RouteProxyConfig) => void;
  updating: string | null;
  deleting: string | null;
  selectedAccountIds: string[];
  onSelectedAccountIds: (ids: string[]) => void;
  onDraft: (value: TemporaryAccountImportDraft) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  onCheck: () => void;
  onRetry: () => void;
  onStrategyChange: (strategy: GroupRouteStrategy) => void;
  onCheckAccount: (id: string) => void;
  onUpdateAccount: (id: string, patch: Partial<TemporaryAccount>) => void;
  onDeleteAccount: (id: string) => void;
  onDeleteSelected: () => void;
}) {
  const groups = props.snapshot.temporaryAccountGroups || [];
  const openAiSite = props.snapshot.sites.find((site) => site.addresses.some((address) => address.baseUrl.includes("api.openai.com")));
  const grokSite = props.snapshot.sites.find((site) => site.addresses.some((address) => address.baseUrl.includes("api.x.ai")));
  const currentProviderSite = props.checkProviderType === "grok" ? grokSite : openAiSite;
  const totalAccounts = groups.reduce((total, group) => total + group.accounts.length, 0);
  const visibleGroups = groups.filter((group) => (group.providerType || "gpt") === props.checkProviderType);
  const visibleAccounts = visibleGroups.flatMap((group) => group.accounts);
  const visibleAccountIds = visibleAccounts.map((account) => account.id);
  const visibleAccountIdSet = new Set(visibleAccountIds);
  const visibleAvailabilityStats = temporaryAccountAvailabilityStats(visibleAccounts);
  const selectedVisibleAccountIds = props.selectedAccountIds.filter((id) => visibleAccountIdSet.has(id));
  const selectedAccountIdSet = new Set(selectedVisibleAccountIds);
  const currentTypeLabel = temporaryAccountProviderLabels[props.checkProviderType];
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
        <div className="center-empty center-empty-stack temp-account-empty-state">
          <div className="temp-account-empty-mark"><Upload className="h-5 w-5" /></div>
          <div>
            <div className="center-empty-title">暂无临时账号</div>
            <div className="center-empty-description">导入 GPT、Grok、Claude 或 Gemini 账号后，这里会展示可用状态和额度信息。</div>
          </div>
        </div>
      ) : (
        <section className="temp-account-panel panel p-4">
          <div className="form-head temp-account-head">
            <div>
              <h2>临时账号池</h2>
              <div className="mt-1 text-xs font-bold text-ink/55">
                当前 {currentTypeLabel} / {visibleAccounts.length} 个账号 / 全部 {totalAccounts} 个账号 / {currentProviderSite?.name || currentTypeLabel}
              </div>
            </div>
            <div className="temp-account-stats" aria-label="临时账号状态统计">
              <span><strong>{visibleAvailabilityStats.available}</strong>可用</span>
              <span><strong>{visibleAvailabilityStats.unavailable}</strong>不可用</span>
              <span><strong>{visibleAvailabilityStats.unknown}</strong>未检查</span>
            </div>
          </div>
          <div className="temp-account-toolbar">
            <label className="temp-account-check-provider">
              <span>检查账号</span>
              <SelectInput value={props.checkProviderType} onChange={(event) => props.onCheckProviderTypeChange(event.target.value as Extract<TemporaryAccountProviderType, "gpt" | "grok">)}>
                <option value="gpt">{temporaryAccountProviderLabels.gpt}</option>
                <option value="grok">{temporaryAccountProviderLabels.grok}</option>
              </SelectInput>
            </label>
            <label className="temp-account-check-proxy">
              <span>检测代理</span>
              <SelectInput
                value={props.checkProxy.mode}
                onChange={(event) => {
                  const mode = event.target.value as RouteProxyConfig["mode"];
                  props.onCheckProxyChange(mode === "custom" ? { mode, url: props.checkProxy.url || "http://127.0.0.1:7897" } : { mode });
                }}
              >
                <option value="system">{routeProxyModeLabels.system}</option>
                <option value="direct">{routeProxyModeLabels.direct}</option>
                <option value="custom">防封 Docker / 自定义代理</option>
              </SelectInput>
            </label>
            {props.checkProxy.mode === "custom" ? (
              <label className="temp-account-check-proxy temp-account-check-proxy-url">
                <span>代理地址</span>
                <TextInput
                  value={props.checkProxy.url || ""}
                  placeholder="http://127.0.0.1:7897"
                  onChange={(event) => props.onCheckProxyChange({ mode: "custom", url: event.target.value })}
                />
              </label>
            ) : null}
            <ActionButton type="button" tone="ghost" disabled={props.checking !== null || visibleAccounts.length === 0} onClick={() => props.onCheck()}>
              <RefreshCw className={`h-4 w-4 ${props.checking === "all" ? "animate-spin" : ""}`} />
              检查 {currentTypeLabel}
            </ActionButton>
            <ActionButton type="button" tone="ghost" disabled={props.deleting !== null || visibleAccountIds.length === 0} onClick={() => props.onSelectedAccountIds(visibleAccountIds)}>
              <Check className="h-4 w-4" />
              全选 {currentTypeLabel}
            </ActionButton>
            <ActionButton type="button" tone="danger" disabled={props.deleting !== null || selectedVisibleAccountIds.length === 0} onClick={props.onDeleteSelected}>
              <Trash2 className="h-4 w-4" />
              删除选中{selectedVisibleAccountIds.length > 0 ? ` ${selectedVisibleAccountIds.length}` : ""}
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
            {visibleGroups.length === 0 ? (
              <section className="center-empty center-empty-stack temp-account-empty-inline">
                <div className="temp-account-empty-mark"><Upload className="h-5 w-5" /></div>
                <div>
                  <div className="center-empty-title">暂无 {currentTypeLabel} 临时账号</div>
                  <div className="center-empty-description">切换类型或导入 {currentTypeLabel} 账号后，这里会只展示当前类型的账号。</div>
                </div>
              </section>
            ) : visibleGroups.map((group) => {
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
                                        ? Array.from(new Set([...selectedVisibleAccountIds, account.id]))
                                        : selectedVisibleAccountIds.filter((id) => id !== account.id)
                                    )
                                  }
                                  aria-label={`选择 ${account.label}`}
                                />
                                <span className={`account-status account-status-${availability}`}>
                                  {temporaryAccountAvailabilityLabels[availability]}
                                </span>
                                <span className="temp-account-name">{account.label}</span>
                                <div className="temp-account-row-actions">
                                  <button
                                    className="temp-account-icon-button"
                                    type="button"
                                    disabled={props.checking !== null || props.deleting !== null}
                                    onClick={() => props.onCheckAccount(account.id)}
                                    title="刷新账号"
                                  >
                                    <RefreshCw className={`h-4 w-4 ${props.checking === account.id ? "animate-spin" : ""}`} />
                                  </button>
                                  <label className="temp-account-enable" title={account.enabled ? "停用账号" : "启用账号"}>
                                    <input
                                      type="checkbox"
                                      checked={account.enabled}
                                      disabled={props.updating !== null || props.deleting !== null}
                                      onChange={(event) => props.onUpdateAccount(account.id, { enabled: event.target.checked })}
                                    />
                                    启用
                                  </label>
                                  <button className="temp-account-delete" type="button" disabled={props.deleting !== null} onClick={() => props.onDeleteAccount(account.id)} title="删除账号">
                                    {props.deleting === account.id ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                                  </button>
                                </div>
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
                <TextInput value="自动识别 CPA / Sub2API / Codex auth / Grok auth / Grok2API / Cookie / JSONL / 纯 token" disabled />
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
                  placeholder="支持 CPA/SubAPI/Codex auth/Grok auth/Grok2API JSON、JSONL、CSV、sso/cf_clearance Cookie 或每行一个 sk-/token/sso"
                  onChange={(event) => props.onDraft({ ...props.draft, content: event.target.value })}
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <ActionButton type="button" tone="ghost" onClick={props.onClose}>
                取消
              </ActionButton>
              <ActionButton type="submit" disabled={props.busy || !hasImportContent}>
                {props.busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {props.busy ? "正在导入..." : "导入账号"}
              </ActionButton>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
