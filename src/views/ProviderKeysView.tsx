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
  isOfficialGrokSite,
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
import { ActionButton, SecretTextInput, SelectInput, TextInput } from "../components/ui";

export function ProviderKeysView(props: {
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
  const selectedSiteIsOfficialOpenAi = isOfficialOpenAiSite(selectedSite);
  const selectedSiteIsOfficialGrok = isOfficialGrokSite(selectedSite);
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
        emptyProviderApiKey(selectedSite, props.draft.apiKeys.length)
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
        <div className="center-empty">暂无上游密钥分组</div>
      ) : (
        <section className="panel p-4">
          <div className="form-head">
            <div>
              <h2>上游密钥分组</h2>
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
          <form onSubmit={props.onSubmit} className="modal-panel" role="dialog" aria-modal="true" aria-label="上游密钥分组编辑">
            <div className="form-head">
              <div>
                <h2>{props.draft.id ? "编辑上游密钥分组" : "新增上游密钥分组"}</h2>
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
                  props.onDraft({ ...props.draft, siteId: event.target.value, groupName: site?.name || "", apiKeys: [emptyProviderApiKey(site)] });
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
              {props.draft.apiKeys.map((apiKey, index) => {
                const hasApiKey = apiKey.secret.trim().length > 0;
                const isChatGptOfficialKey = apiKey.kind === "chatgpt-official" || (selectedSiteIsOfficialOpenAi && !hasApiKey);
                const isGrokOfficialKey = selectedSiteIsOfficialGrok || apiKey.kind === "grok-official";
                const useOpenAiApiKeyInput = selectedSiteIsOfficialOpenAi && hasApiKey;
                return (
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
                    {selectedSiteIsOfficialGrok ? (
                      <label>
                        账号来源
                        <span className="field-hint">固定使用已导入的 Grok OAuth 临时账号池；这里仅维护模型配置。</span>
                      </label>
                    ) : (
                      <label>
                        API Key
                        <SecretTextInput
                          value={apiKey.secret}
                          placeholder={selectedSiteIsOfficialOpenAi ? "可留空，或填写 sk-..." : "sk-..."}
                          onChange={(event) => {
                            const secret = event.target.value;
                            const kind = secret.trim()
                              ? "api-key"
                              : selectedSiteIsOfficialOpenAi
                                ? "chatgpt-official"
                                : apiKey.kind;
                            updateApiKey(index, { secret, kind });
                          }}
                        />
                        {selectedSiteIsOfficialOpenAi ? (
                          <span className="field-hint">不填则使用 ChatGPT 官方账号池；填写 sk-... 则走 OpenAI API。</span>
                        ) : null}
                      </label>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <label className="toggle-row">
                      <input type="checkbox" checked={apiKey.enabled} onChange={(event) => updateApiKey(index, { enabled: event.target.checked })} />
                      启用
                    </label>
                    {!isGrokOfficialKey ? (
                      <ActionButton
                        type="button"
                        tone="ghost"
                        disabled={props.modelDiscoveringIndex !== null}
                        onClick={() => props.onDiscoverModels(index)}
                      >
                        <RefreshCw className={`h-4 w-4 ${props.modelDiscoveringIndex === index ? "animate-spin" : ""}`} />
                        {useOpenAiApiKeyInput ? "获取 OpenAI 模型" : isChatGptOfficialKey ? "同步 ChatGPT 模型" : "获取模型"}
                      </ActionButton>
                    ) : null}
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
                      placeholder={isGrokOfficialKey ? "手动填写，例如：\ngrok-4\ngrok-3-mini" : "自动获取失败时可手动填写，例如：\ngpt-4.1\ngpt-4.1-mini"}
                      onChange={(event) => updateApiKey(index, { models: parseModelText(event.target.value) })}
                    />
                    <span className="field-hint">
                      {isChatGptOfficialKey
                        ? "从已导入的 GPT 官方临时账号同步后，模型会同步到 OpenAI 供应商供路由选择。"
                        : isGrokOfficialKey
                          ? "支持换行、逗号、空格分隔；保存后会同步到 Grok 供应商，并由 Grok 临时账号池执行。"
                          : "支持换行、逗号、空格分隔；保存后会同步到该供应商的可选模型。"}
                    </span>
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
                );
              })}
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
