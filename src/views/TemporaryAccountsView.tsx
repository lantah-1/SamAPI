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
  uniqueMembers,
  upstreamRequestSummary,
  upstreamRequestBody
} from "../app/utils";
import { ActionButton, SelectInput, TextInput } from "../components/ui";

const TEMPORARY_IMPORT_FILE_LIMIT = 500;
const TEMPORARY_IMPORT_TEXT_LIMIT = 20 * 1024 * 1024;
const TEMPORARY_IMPORT_ARCHIVE_LIMIT = 25 * 1024 * 1024;
const TEMPORARY_IMPORT_TEXT_FILE = /\.(?:json|jsonl|txt|csv)$/i;

const temporaryImportModeHints: Record<TemporaryAccountImportMode, string> = {
  auto: "逐个文件识别；支持 OAuth、API Key，以及含 agent_runtime_id + base64 PKCS8 Ed25519 agent_private_key 的 OpenAI Agent Identity。",
  subapi: "按 Sub2API 来源导入，支持 tokenless OpenAI Agent Identity（严格校验 PKCS8 Ed25519 私钥）。",
  "sub2api-k12": "导入 Sub2API 导出的 ChatGPT K12 OAuth 账号列表 JSON。",
  cpa: "按 CPA 来源导入，同时兼容常见账号字段。",
  "auth-json": "适合直接导入 Codex 或 Grok 的 auth.json。",
  zip: "解压后逐文件自动识别，支持 Sub2API、CPA 和 auth.json 混合包。"
};

function temporaryImportModeHint(providerType: TemporaryAccountProviderType, mode: TemporaryAccountImportMode) {
  if (providerType !== "grok") return temporaryImportModeHints[mode];
  if (mode === "cpa") return "仅导入 CLIProxyAPI / CPA 格式的单账号 xAI OAuth JSON。";
  if (mode === "subapi") return "仅导入 grok2api 格式的单账号 Grok Build OAuth JSON。";
  if (mode === "zip") return "ZIP 内可混合 CPA 与 grok2api OAuth JSON，每个 JSON 只包含一个账号。";
  return "自动识别 CPA 或 grok2api 的单账号 OAuth JSON。";
}

function isTemporaryImportZip(file: File) {
  return file.name.toLowerCase().endsWith(".zip") || ["application/zip", "application/x-zip-compressed"].includes(file.type);
}

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
  onCheckSelected: () => void;
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
  const unavailableAccountIds = visibleAccounts
    .filter((account) => (account.availability || "unknown") === "unavailable")
    .map((account) => account.id);
  const uncheckedAccountIds = visibleAccounts
    .filter((account) => (account.availability || "unknown") === "unknown")
    .map((account) => account.id);
  const checkingAccountIdSet = new Set(props.checkingAccountIds);
  const queuedAccountIdSet = new Set(props.queuedAccountIds);
  const visibleCheckingCount = props.checkingAccountIds.filter((id) => visibleAccountIdSet.has(id)).length;
  const visibleQueuedCount = props.queuedAccountIds.filter((id) => visibleAccountIdSet.has(id)).length;
  const currentTypeLabel = temporaryAccountProviderLabels[props.checkProviderType];
  const temporaryAccountStrategy = props.snapshot.settings.temporaryAccountStrategy || "sequential";
  const hasImportContent = props.draft.content.trim() || props.draft.contents.some((content) => content.trim());
  const [importFileError, setImportFileError] = useState("");
  useEffect(() => {
    if (props.editorOpen) setImportFileError("");
  }, [props.editorOpen]);
  const readImportFiles = async (files?: FileList | null) => {
    const selectedFiles = Array.from(files || []);
    if (selectedFiles.length === 0) return;
    setImportFileError("");
    try {
      const contents: string[] = [];
      const fileNames: string[] = [];
      let totalTextSize = 0;
      const appendContent = (name: string, content: string) => {
        if (!content.trim()) return;
        totalTextSize += content.length;
        if (totalTextSize > TEMPORARY_IMPORT_TEXT_LIMIT) throw new Error("解压后的账号数据不能超过 20 MB");
        if (contents.length >= TEMPORARY_IMPORT_FILE_LIMIT) throw new Error(`单次最多导入 ${TEMPORARY_IMPORT_FILE_LIMIT} 个文件`);
        contents.push(content);
        fileNames.push(name);
      };

      for (const file of selectedFiles) {
        const zipFile = isTemporaryImportZip(file);
        if (props.draft.mode === "zip" && !zipFile) throw new Error("ZIP 包模式只能选择 .zip 文件");
        if (!["auto", "zip"].includes(props.draft.mode) && zipFile) throw new Error("请切换到“自动识别”或“ZIP 混合包”后再选择 ZIP 文件");
        if (!zipFile) {
          appendContent(file.name, await file.text());
          continue;
        }
        if (file.size > TEMPORARY_IMPORT_ARCHIVE_LIMIT) throw new Error(`${file.name} 超过 25 MB`);
        const { default: JSZip } = await import("jszip");
        const archive = await JSZip.loadAsync(file);
        const entries = Object.values(archive.files).filter(
          (entry) => !entry.dir && !entry.name.startsWith("__MACOSX/") && TEMPORARY_IMPORT_TEXT_FILE.test(entry.name)
        );
        if (entries.length === 0) throw new Error(`${file.name} 中没有可导入的 JSON、JSONL、TXT 或 CSV 文件`);
        for (const entry of entries) appendContent(`${file.name} / ${entry.name}`, await entry.async("string"));
      }

      if (contents.length === 0) throw new Error("所选文件中没有可导入的账号数据");
      props.onDraft({
        ...props.draft,
        contents,
        fileNames,
        name: props.draft.name || selectedFiles[0]?.name.replace(/\.[^.]+$/, "") || ""
      });
    } catch (error) {
      setImportFileError(error instanceof Error ? error.message : "读取导入文件失败");
      props.onDraft({ ...props.draft, contents: [], fileNames: [] });
    }
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
              {props.checking !== null ? <span><strong>{visibleCheckingCount}</strong>检测中</span> : null}
              {props.checking !== null ? <span><strong>{visibleQueuedCount}</strong>等待检测</span> : null}
            </div>
          </div>
          <div className="temp-account-toolbar">
            <div className="temp-account-toolbar-controls">
              <div className="temp-account-check-provider">
                <span className="temp-account-control-label">账号类型</span>
                <div className="temp-account-provider-switch" role="group" aria-label="账号类型">
                  {(["gpt", "grok"] as const).map((providerType) => (
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
                <ActionButton className="temp-account-check-action" type="button" tone="ghost" disabled={props.checking !== null || visibleAccounts.length === 0} onClick={() => props.onCheck()}>
                  <RefreshCw className={`h-4 w-4 ${props.checking === "all" ? "animate-spin" : ""}`} />
                  检查 {currentTypeLabel}
                </ActionButton>
              </div>
            </div>
            <div className="temp-account-toolbar-actions">
              <div className="temp-account-selection-group" role="group" aria-label="选择账号">
                <ActionButton type="button" tone="ghost" disabled={props.deleting !== null || visibleAccountIds.length === 0} onClick={() => props.onSelectedAccountIds(visibleAccountIds)}>
                  全部 <strong>{visibleAccountIds.length}</strong>
                </ActionButton>
                <ActionButton type="button" tone="ghost" disabled={props.deleting !== null || unavailableAccountIds.length === 0} onClick={() => props.onSelectedAccountIds(unavailableAccountIds)}>
                  不可用 <strong>{unavailableAccountIds.length}</strong>
                </ActionButton>
                <ActionButton type="button" tone="ghost" disabled={props.deleting !== null || uncheckedAccountIds.length === 0} onClick={() => props.onSelectedAccountIds(uncheckedAccountIds)}>
                  未检查 <strong>{uncheckedAccountIds.length}</strong>
                </ActionButton>
              </div>
              <div className="temp-account-bulk-actions">
                <ActionButton type="button" disabled={props.checking !== null || props.deleting !== null || selectedVisibleAccountIds.length === 0} onClick={props.onCheckSelected}>
                  <RefreshCw className={`h-4 w-4 ${props.checking === "selected" ? "animate-spin" : ""}`} />
                  复检{selectedVisibleAccountIds.length > 0 ? ` ${selectedVisibleAccountIds.length}` : ""}
                </ActionButton>
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
                            <div className="temp-account-row-side">
                              <div className="temp-account-health">
                                <button
                                  className={`account-status account-status-${checking ? "checking" : queued ? "queued" : availability}`}
                                  type="button"
                                  disabled={props.checking !== null || props.deleting !== null}
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

      {props.editorOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form onSubmit={props.onSubmit} className="modal-panel temp-account-modal" role="dialog" aria-modal="true" aria-label="临时账号导入">
            <div className="form-head">
              <div>
                <h2>导入临时账号</h2>
                <div className="mt-1 text-xs font-bold text-ink/55">选择账号平台，文件格式可自动识别</div>
              </div>
              <ActionButton type="button" tone="ghost" onClick={props.onClose} title="关闭">
                <X className="h-4 w-4" />
              </ActionButton>
            </div>
            <div className="form-grid">
              <label>
                账号平台
                <SelectInput value={props.draft.providerType} onChange={(event) => {
                  const providerType = event.target.value as Extract<TemporaryAccountProviderType, "gpt" | "grok">;
                  props.onDraft({
                    ...props.draft,
                    providerType,
                    mode: providerType === "grok" && ["auth-json", "sub2api-k12"].includes(props.draft.mode) ? "auto" : props.draft.mode,
                    name: `${providerType === "gpt" ? "OpenAI" : "Grok"} 临时账号`
                  });
                }}>
                  <option value="gpt">OpenAI</option>
                  <option value="grok">{temporaryAccountProviderLabels.grok}</option>
                </SelectInput>
              </label>
              <label>
                导入方式
                <SelectInput value={props.draft.mode} onChange={(event) => {
                  const mode = event.target.value as TemporaryAccountImportMode;
                  setImportFileError("");
                  props.onDraft({
                    ...props.draft,
                    mode,
                    source: mode === "cpa" ? "cpa" : "subapi",
                    content: mode === "zip" ? "" : props.draft.content,
                    contents: [],
                    fileNames: []
                  });
                }}>
                  <option value="auto">自动识别（推荐）</option>
                  <option value="subapi">{props.draft.providerType === "grok" ? "grok2api OAuth JSON" : "Sub2API"}</option>
                  {props.draft.providerType === "gpt" ? <option value="sub2api-k12">Sub2API K12 JSON</option> : null}
                  <option value="cpa">{props.draft.providerType === "grok" ? "CPA OAuth JSON" : "CPA"}</option>
                  {props.draft.providerType === "gpt" ? <option value="auth-json">纯 auth.json</option> : null}
                  <option value="zip">ZIP 混合包</option>
                </SelectInput>
                <span className="field-hint">{temporaryImportModeHint(props.draft.providerType, props.draft.mode)}</span>
              </label>
              <label className="form-span-2">
                导入文件
                <input
                  className="field"
                  type="file"
                  accept={props.draft.mode === "zip" ? ".zip,application/zip" : props.draft.mode === "auto" ? ".json,.jsonl,.txt,.csv,.zip,application/zip" : ".json,.jsonl,.txt,.csv"}
                  multiple
                  onChange={(event) => void readImportFiles(event.target.files)}
                />
                {props.draft.fileNames.length > 0 ? (
                  <span className="field-hint">
                    已读取 {props.draft.fileNames.length} 个数据文件：{props.draft.fileNames.slice(0, 3).join("，")}{props.draft.fileNames.length > 3 ? ` 等 ${props.draft.fileNames.length} 个` : ""}
                  </span>
                ) : null}
                {importFileError ? <span className="temp-account-import-error" role="alert">{importFileError}</span> : null}
              </label>
              {props.draft.mode === "zip" ? (
                <div className="temp-account-import-note form-span-2">
                  {props.draft.providerType === "grok"
                    ? "ZIP 内可混合 CPA 与 grok2api OAuth JSON；暂不支持 SSO JSON 和 accounts 账号列表。"
                    : "ZIP 内可以包含多条 Sub2API、CPA、auth.json，也可以混合；目录和不支持的文件会自动忽略。"}
                </div>
              ) : (
                <label className="form-span-2">
                  账号数据
                  <textarea
                    className="field temp-account-textarea"
                    value={props.draft.content}
                    placeholder={props.draft.providerType === "grok"
                      ? "粘贴单账号 CPA 或 grok2api OAuth JSON；不支持 SSO、Cookie、纯 token 或 accounts 列表"
                      : props.draft.mode === "sub2api-k12"
                        ? "粘贴 type 为 sub2api-data、accounts 中包含 OpenAI K12 OAuth 账号的 JSON"
                        : "也可以直接粘贴 JSON、JSONL、Cookie、token 或账号字段"}
                    onChange={(event) => props.onDraft({ ...props.draft, content: event.target.value })}
                  />
                </label>
              )}
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
