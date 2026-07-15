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

export function KeysView(props: {
  snapshot: AppSnapshot;
  keyName: string;
  keyModelsText: string;
  modelOptions: string[];
  editorOpen: boolean;
  editingKeyId: string | null;
  createdKey: ApiKeyCreated | null;
  onKeyName: (value: string) => void;
  onKeyModelsText: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  onEdit: (key: AppSnapshot["apiKeys"][number]) => void;
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
                    <div className="record-meta break-all">{fullKey || `${key.prefix}...（完整密钥仅生成时显示）`}</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {key.models.length > 0 ? key.models.map((model) => <span key={model} className="pill pill-muted">{model}</span>) : <span className="pill pill-muted">全部模型</span>}
                    </div>
                  </div>
                  <div className="record-actions">
                    <label className="toggle-row">
                      <input type="checkbox" checked={key.enabled} onChange={(event) => props.onToggle(key.id, event.target.checked)} />
                      启用
                    </label>
                    <ActionButton tone="ghost" onClick={() => props.onEdit(key)} title="编辑名称和可用模型">
                      <Pencil className="h-4 w-4" />
                    </ActionButton>
                    <ActionButton tone="ghost" disabled={!fullKey} onClick={() => props.onCopy(fullKey)} title={fullKey ? "复制密钥" : "完整密钥仅生成时显示，无法从前缀还原"}>
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
                <h2>{props.editingKeyId ? "编辑密钥" : "生成密钥"}</h2>
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
            <label className="mt-3 block">
              可用模型
              <textarea
                className="field min-h-24"
                value={props.keyModelsText}
                placeholder="留空表示允许全部模型；也可以每行/逗号填写一个路由模型名"
                onChange={(event) => props.onKeyModelsText(event.target.value)}
              />
              <span className="field-hint">这里限制的是对外 model/路由名。留空则不限制。</span>
            </label>
            {props.modelOptions.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {props.modelOptions.map((model) => (
                  <button
                    key={model}
                    type="button"
                    className="pill pill-muted"
                    onClick={() => props.onKeyModelsText(Array.from(new Set([...parseModelText(props.keyModelsText), model])).join("\n"))}
                  >
                    + {model}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <ActionButton type="button" tone="ghost" onClick={props.onClose}>
                取消
              </ActionButton>
              <ActionButton type="button" onClick={props.onSubmit}>
                {props.editingKeyId ? <Save className="h-4 w-4" /> : <Wand2 className="h-4 w-4" />}
                {props.editingKeyId ? "保存" : "生成"}
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

