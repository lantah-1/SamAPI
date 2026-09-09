import {
  Braces,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock3,
  Copy,
  Database,
  KeyRound,
  LockKeyhole,
  LogIn,
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
  RouteRecord,
  RouteType,
  Site,
  SiteAddress,
  SiteType,
  SwitchRoute,
  TemporaryAccount,
  TemporaryAccountGroup,
  TemporaryAccountImportMode,
  TemporaryAccountProviderType
} from "../../shared/types";
import {
  blankAddress,
  blankHeaderRow,
  endpointLabels,
  groupStrategyLabels,
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
  uniqueMembers
} from "../app/utils";
import { ActionButton, SelectInput, TextInput } from "../components/ui";
import { AccountImportDialog } from "../components/AccountImportDialog";

function TemporaryAccountStatusIcon(props: { availability: TemporaryAccount["availability"]; checking: boolean }) {
  if (props.checking) return <RefreshCw className="h-3.5 w-3.5 animate-spin" />;
  if (props.availability === "available") return <CircleCheck className="h-3.5 w-3.5" />;
  if (props.availability === "unavailable") return <CircleX className="h-3.5 w-3.5" />;
  return <CircleHelp className="h-3.5 w-3.5" />;
}

export function TemporaryAccountsView(props: {
  snapshot: AppSnapshot;
  draft: TemporaryAccountImportDraft;
  editorOpen: boolean;
  busy: boolean;
  loading: boolean;
  error: string;
  checking: string | null;
  checkingAccountIds: string[];
  queuedAccountIds: string[];
  checkProviderType: Extract<TemporaryAccountProviderType, "gpt" | "grok">;
  onCheckProviderTypeChange: (providerType: Extract<TemporaryAccountProviderType, "gpt" | "grok">) => void;
  updating: string | null;
  resetting: string | null;
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
  onResetAccount: (id: string) => void;
  onCheckSelected: () => void;
  onUpdateAccount: (id: string, patch: Partial<TemporaryAccount>) => void;
  onDeleteAccount: (id: string) => void;
  onDeleteSelected: () => void;
}) {
  const groups = (props.snapshot.temporaryAccountGroups || []).filter((group) => group.providerType === "grok");
  const openAiSite = props.snapshot.sites.find((site) => site.addresses.some((address) => address.baseUrl.includes("api.openai.com")));
  const grokSite = props.snapshot.sites.find((site) => site.addresses.some((address) => address.baseUrl.includes("api.x.ai")));
  const currentProviderSite = props.checkProviderType === "grok" ? grokSite : openAiSite;
  const totalAccounts = groups.reduce((total, group) => total + group.accounts.length, 0);
  const visibleGroups = groups.filter((group) => (group.providerType || "gpt") === props.checkProviderType);
  const visibleAccounts = visibleGroups.flatMap((group) => group.accounts);
  const visibleAccountIds = visibleAccounts.map((account) => account.id);
  const visibleAccountIdSet = new Set(visibleAccountIds);
  const selectedVisibleAccountIds = props.selectedAccountIds.filter((id) => visibleAccountIdSet.has(id));
  const selectedAccountIdSet = new Set(selectedVisibleAccountIds);
  const availableAccountIds = visibleAccounts
    .filter((account) => (account.availability || "unknown") === "available")
    .map((account) => account.id);
  const unavailableAccountIds = visibleAccounts
    .filter((account) => (account.availability || "unknown") === "unavailable")
    .map((account) => account.id);
  const uncheckedAccountIds = visibleAccounts
    .filter((account) => (account.availability || "unknown") === "unknown")
    .map((account) => account.id);
  const checkingAccountIdSet = new Set(props.checkingAccountIds);
  const queuedAccountIdSet = new Set(props.queuedAccountIds);
  const pendingCheckAccountIdSet = new Set([...props.checkingAccountIds, ...props.queuedAccountIds]);
  const visibleAvailabilityStats = temporaryAccountAvailabilityStats(
    visibleAccounts.filter((account) => !pendingCheckAccountIdSet.has(account.id))
  );
  const visibleCheckingCount = props.checkingAccountIds.filter((id) => visibleAccountIdSet.has(id)).length;
  const visibleQueuedCount = props.queuedAccountIds.filter((id) => visibleAccountIdSet.has(id)).length;
  const currentTypeLabel = temporaryAccountProviderLabels[props.checkProviderType];
  const temporaryAccountStrategy = props.snapshot.settings.temporaryAccountStrategy || "sequential";
  const [selectedStatusGroup, setSelectedStatusGroup] = useState<"all" | "available" | "unavailable" | "unknown" | null>(null);
  const selectionMatches = (ids: string[]) =>
    ids.length > 0 && ids.length === selectedVisibleAccountIds.length && ids.every((id) => selectedAccountIdSet.has(id));
  const selectAccountGroup = (group: Exclude<typeof selectedStatusGroup, null>, ids: string[]) => {
    const active = selectedStatusGroup === group && selectionMatches(ids);
    setSelectedStatusGroup(active ? null : group);
    props.onSelectedAccountIds(active ? [] : ids);
  };
  useEffect(() => {
    setSelectedStatusGroup(null);
  }, [props.checkProviderType]);
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
            <div className="center-empty-description">导入 Grok OAuth 账号后，这里会展示可用状态和额度信息。GPT、Claude、DeepSeek 等账号请到「账号管理」维护。</div>
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
            <div className="temp-account-stats" role="group" aria-label="按状态选择账号">
              <button type="button" className={selectedStatusGroup === "all" && selectionMatches(visibleAccountIds) ? "temp-account-stat-active" : ""} disabled={props.deleting !== null || visibleAccountIds.length === 0} aria-pressed={selectedStatusGroup === "all" && selectionMatches(visibleAccountIds)} onClick={() => selectAccountGroup("all", visibleAccountIds)}>
                <strong>{visibleAccountIds.length}</strong>全部
              </button>
              <button type="button" className={selectedStatusGroup === "available" && selectionMatches(availableAccountIds) ? "temp-account-stat-active" : ""} disabled={props.deleting !== null || availableAccountIds.length === 0} aria-pressed={selectedStatusGroup === "available" && selectionMatches(availableAccountIds)} onClick={() => selectAccountGroup("available", availableAccountIds)}>
                <strong>{visibleAvailabilityStats.available}</strong>可用
              </button>
              <button type="button" className={selectedStatusGroup === "unavailable" && selectionMatches(unavailableAccountIds) ? "temp-account-stat-active" : ""} disabled={props.deleting !== null || unavailableAccountIds.length === 0} aria-pressed={selectedStatusGroup === "unavailable" && selectionMatches(unavailableAccountIds)} onClick={() => selectAccountGroup("unavailable", unavailableAccountIds)}>
                <strong>{visibleAvailabilityStats.unavailable}</strong>不可用
              </button>
              <button type="button" className={selectedStatusGroup === "unknown" && selectionMatches(uncheckedAccountIds) ? "temp-account-stat-active" : ""} disabled={props.deleting !== null || uncheckedAccountIds.length === 0} aria-pressed={selectedStatusGroup === "unknown" && selectionMatches(uncheckedAccountIds)} onClick={() => selectAccountGroup("unknown", uncheckedAccountIds)}>
                <strong>{visibleAvailabilityStats.unknown}</strong>未检查
              </button>
              {props.checking !== null ? <span><strong>{visibleCheckingCount}</strong>检测中</span> : null}
              {props.checking !== null ? <span><strong>{visibleQueuedCount}</strong>等待检测</span> : null}
            </div>
          </div>
          <div className="temp-account-toolbar">
            <div className="temp-account-toolbar-controls">
              <div className="temp-account-check-provider">
                <span className="temp-account-control-label">账号类型</span>
                <div className="temp-account-provider-switch" role="group" aria-label="账号类型">
                  {(["grok"] as const).map((providerType) => (
                    <button
                      key={providerType}
                      type="button"
                      className={`temp-account-provider-option ${props.checkProviderType === providerType ? "temp-account-provider-option-active" : ""}`}
                      aria-pressed={props.checkProviderType === providerType}
                      onClick={() => props.onCheckProviderTypeChange(providerType)}
                    >
                      {temporaryAccountProviderLabels[providerType]}
                    </button>
                  ))}
                </div>
              </div>
              <label className="temp-account-strategy">
                <span>全局复用策略</span>
                <SelectInput value={temporaryAccountStrategy} onChange={(event) => props.onStrategyChange(event.target.value as GroupRouteStrategy)}>
                  <option value="stable-first">{groupStrategyLabels["stable-first"]}</option>
                  <option value="sequential">{groupStrategyLabels.sequential}</option>
                  <option value="random">{groupStrategyLabels.random}</option>
                </SelectInput>
              </label>
              <div className="temp-account-check-control">
                <span className="temp-account-control-label temp-account-control-label-placeholder" aria-hidden="true">检查</span>
                <ActionButton
                  className="temp-account-check-action"
                  type="button"
                  tone="ghost"
                  disabled={props.checking !== null || visibleAccounts.length === 0}
                  onClick={selectedVisibleAccountIds.length > 0 ? props.onCheckSelected : () => props.onCheck()}
                >
                  <RefreshCw className={`h-4 w-4 ${props.checking !== null ? "animate-spin" : ""}`} />
                  {selectedVisibleAccountIds.length > 0 ? `检查已选 ${selectedVisibleAccountIds.length}` : `检查 ${currentTypeLabel}`}
                </ActionButton>
              </div>
            </div>
            <div className="temp-account-toolbar-actions">
              <div className="temp-account-bulk-actions">
                <ActionButton type="button" tone="danger" disabled={props.deleting !== null || selectedVisibleAccountIds.length === 0} onClick={props.onDeleteSelected}>
                  <Trash2 className="h-4 w-4" />
                  删除{selectedVisibleAccountIds.length > 0 ? ` ${selectedVisibleAccountIds.length}` : ""}
                </ActionButton>
              </div>
            </div>
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
              const groupIsGrok = (group.providerType || "gpt") === "grok";
              return (
                <article key={group.id} className="temp-account-group-card">
                  <div className="temp-account-group-head">
                    <div>
                      <div className="record-title">{temporaryAccountProviderLabels[group.providerType || "gpt"]}</div>
                      <div className="record-meta">
                        {group.accounts.length} 个账号 / {availabilityStats.available} 可用 / {availabilityStats.unavailable} 不可用 / {availabilityStats.unknown} 未检查
                      </div>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="temp-account-list">
                      {group.accounts.map((account) => {
                        const availability = account.availability || "unknown";
                        const checking = checkingAccountIdSet.has(account.id);
                        const queued = queuedAccountIdSet.has(account.id);
                        const accountKind = groupIsGrok
                          ? account.grokOAuthFormat === "grok2api-oauth" ? "grok2api" : "CPA"
                          : temporaryAccountSourceLabels[group.source];
                        const displayedQuotaStages = account.quotaStages.slice(0, 5);
                        const resetQuotaStage = account.quotaStages.find((stage) => {
                          const count = Number(stage.remaining);
                          return stage.label === "主动重置次数" && Number.isFinite(count) && count > 0;
                        });
                        if (resetQuotaStage && !displayedQuotaStages.includes(resetQuotaStage)) displayedQuotaStages.push(resetQuotaStage);
                        const hiddenQuotaStageCount = Math.max(0, account.quotaStages.length - displayedQuotaStages.length);
                        return (
                          <div key={account.id} className={`temp-account-row temp-account-row-${availability} ${groupIsGrok ? "temp-account-row-status-only" : ""}`}>
                            <label className="temp-account-row-select" title={`选择 ${account.label}`}>
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
                            </label>
                            <div className="temp-account-row-main">
                              <div className="temp-account-identity">
                                <span className="temp-account-name" title={account.label}>{account.label}</span>
                                <span className="temp-account-kind">{accountKind}</span>
                              </div>
                              {!groupIsGrok && account.quotaStages.length > 0 ? (
                                <div className="temp-account-quota-list">
                                  {displayedQuotaStages.map((stage, index) => {
                                    const percent = temporaryAccountQuotaPercent(stage);
                                    const resetCount = Number(stage.remaining);
                                    const isResetCreditStage = stage.label === "主动重置次数";
                                    const canReset = isResetCreditStage && Number.isFinite(resetCount) && resetCount > 0;
                                    const resetCreditExpiryTimes = stage.resetCreditExpiresAt || [];
                                    return (
                                      <div key={`${account.id}-${stage.label}-${index}`} className={`temp-account-quota temp-account-quota-${availability}`} title={temporaryAccountQuotaText(stage)}>
                                        <div className="temp-account-quota-head">
                                          <span>{stage.label}</span>
                                          <div className="temp-account-quota-value">
                                            <strong>{isResetCreditStage && Number.isFinite(resetCount) ? `${resetCount} 次` : formatQuotaPercent(percent)}</strong>
                                            {canReset ? (
                                              <button
                                                type="button"
                                                className="temp-account-reset"
                                                disabled={props.resetting !== null || props.checking !== null || props.deleting !== null}
                                                onClick={() => props.onResetAccount(account.id)}
                                                title="重置额度"
                                                aria-label={`重置 ${account.label} 的额度`}
                                              >
                                                {props.resetting === account.id ? <RefreshCw className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                                                重置
                                              </button>
                                            ) : null}
                                          </div>
                                        </div>
                                        {!isResetCreditStage ? (
                                          <div className="temp-account-quota-track" aria-label={temporaryAccountQuotaText(stage)}>
                                            <div className="temp-account-quota-fill" style={{ width: `${percent ?? 0}%` }} />
                                          </div>
                                        ) : null}
                                        {resetCreditExpiryTimes.length > 0 ? (
                                          <div className="temp-account-reset-expiries">
                                            {resetCreditExpiryTimes.slice(0, 3).map((expiresAt, creditIndex) => (
                                              <span key={`${expiresAt}-${creditIndex}`}>{creditIndex === 0 ? "最早到期" : `第 ${creditIndex + 1} 张`} · {formatTime(expiresAt)}</span>
                                            ))}
                                            {resetCreditExpiryTimes.length > 3 ? <span>另有 {resetCreditExpiryTimes.length - 3} 张，悬停查看全部</span> : null}
                                          </div>
                                        ) : (
                                          <div className="temp-account-quota-text">{temporaryAccountQuotaText(stage)}</div>
                                        )}
                                      </div>
                                    );
                                  })}
                                  {hiddenQuotaStageCount > 0 ? <span className="temp-account-quota-more">+{hiddenQuotaStageCount} 项</span> : null}
                                </div>
                              ) : null}
                              {account.lastCheckError ? <div className="temp-account-error">{account.lastCheckError}</div> : null}
                            </div>
                            <div className="temp-account-row-side">
                              <div className="temp-account-health">
                                <button
                                  className={`account-status account-status-${checking ? "checking" : queued ? "queued" : availability}`}
                                  type="button"
                                  disabled={checking || queued || props.deleting !== null || (props.checking !== null && props.checking !== "individual")}
                                  onClick={() => props.onCheckAccount(account.id)}
                                  title={checking ? "正在检测账号" : queued ? "账号等待检测" : "重新检查账号"}
                                  aria-label={`${checking ? "正在检测" : queued ? "等待检测" : "重新检查"} ${account.label}`}
                                >
                                  {queued ? <Clock3 className="h-3.5 w-3.5" /> : <TemporaryAccountStatusIcon availability={availability} checking={checking} />}
                                  {checking ? "检测中" : queued ? "等待检测" : temporaryAccountAvailabilityLabels[availability]}
                                </button>
                                <span className="temp-account-last-check">
                                  <Clock3 className="h-3.5 w-3.5" />
                                  {account.lastQuotaCheckedAt ? formatTime(account.lastQuotaCheckedAt) : "尚未检测"}
                                </span>
                                {account.lastCheckStatusCode ? <span className="temp-account-http-status">HTTP {account.lastCheckStatusCode}</span> : null}
                              </div>
                              <div className="temp-account-row-actions">
                                <label className="temp-account-enable" title={account.enabled ? "停用账号" : "启用账号"}>
                                  <input
                                    type="checkbox"
                                    checked={account.enabled}
                                    disabled={props.updating !== null || props.deleting !== null}
                                    onChange={(event) => props.onUpdateAccount(account.id, { enabled: event.target.checked })}
                                    aria-label={account.enabled ? `停用 ${account.label}` : `启用 ${account.label}`}
                                  />
                                  <span className="temp-account-enable-track" aria-hidden="true"><span /></span>
                                </label>
                                <button className="temp-account-delete" type="button" disabled={props.deleting !== null} onClick={() => props.onDeleteAccount(account.id)} title="删除账号" aria-label={`删除 ${account.label}`}>
                                  {props.deleting === account.id ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                                </button>
                              </div>
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

      <AccountImportDialog draft={props.draft} editorOpen={props.editorOpen} busy={props.busy} onDraft={props.onDraft} onSubmit={props.onSubmit} onClose={props.onClose} />
    </>
  );
}
