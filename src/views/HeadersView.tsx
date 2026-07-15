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

export function HeadersView(props: {
  snapshot: AppSnapshot;
  draft: HeaderTemplateDraft;
  editorOpen: boolean;
  onDraft: (value: HeaderTemplateDraft) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  onEdit: (template: HeaderTemplate) => void;
  onDelete: (id: string) => void;
}) {
  const updateHeaderRow = (index: number, patch: Partial<HeaderKeyValue>) => {
    props.onDraft({
      ...props.draft,
      headerRows: props.draft.headerRows.map((row, itemIndex) => (itemIndex === index ? { ...row, ...patch } : row))
    });
  };
  const addHeaderRow = () => {
    props.onDraft({
      ...props.draft,
      headerRows: [...props.draft.headerRows, { ...blankHeaderRow }]
    });
  };
  const removeHeaderRow = (index: number) => {
    const nextRows = props.draft.headerRows.filter((_row, itemIndex) => itemIndex !== index);
    props.onDraft({
      ...props.draft,
      headerRows: nextRows.length > 0 ? nextRows : [{ ...blankHeaderRow }]
    });
  };

  return (
    <>
      {props.snapshot.headerTemplates.length === 0 ? (
        <div className="center-empty">暂无请求头模板</div>
      ) : (
        <section className="panel p-4">
          <div className="form-head">
            <div>
              <h2>请求头模板</h2>
              <div className="mt-1 text-xs font-bold text-ink/55">{props.snapshot.headerTemplates.length} 个模板</div>
            </div>
          </div>
          <div className="site-list">
            {props.snapshot.headerTemplates.map((template) => {
              const rows = parseHeaderRows(template.headersText).filter((row) => row.key || row.value);
              return (
                <article key={template.id} className="record">
                  <div className="min-w-0">
                    <div className="record-title">{template.name}</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {rows.length > 0 ? (
                        rows.map((row, index) => (
                          <span key={`${row.key}-${index}`} className="pill">
                            {row.key || "-"}: {row.value || "-"}
                          </span>
                        ))
                      ) : (
                        <span className="pill">空模板</span>
                      )}
                    </div>
                  </div>
                  <div className="record-actions">
                    <ActionButton tone="ghost" onClick={() => props.onEdit(template)} title="编辑">
                      <Wand2 className="h-4 w-4" />
                    </ActionButton>
                    <ActionButton tone="danger" onClick={() => props.onDelete(template.id)} title="删除">
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
          <form onSubmit={props.onSubmit} className="modal-panel" role="dialog" aria-modal="true" aria-label="请求头模板编辑">
            <div className="form-head">
              <h2>{props.draft.id ? "编辑请求头模板" : "新增请求头模板"}</h2>
              <ActionButton type="button" tone="ghost" onClick={props.onClose} title="关闭">
                <X className="h-4 w-4" />
              </ActionButton>
            </div>
            <label>
              名称
              <TextInput value={props.draft.name || ""} onChange={(event) => props.onDraft({ ...props.draft, name: event.target.value })} />
            </label>
            <div className="mt-4 space-y-3">
              {props.draft.headerRows.map((row, index) => (
                <div key={index} className="address-block">
                  <div className="address-block-head">
                    <div className="text-xs font-black text-ink/55">请求头 {index + 1}</div>
                    <ActionButton type="button" tone="danger" title="删除请求头" onClick={() => removeHeaderRow(index)}>
                      <Trash2 className="h-4 w-4" />
                    </ActionButton>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label>
                      Key
                      <TextInput
                        value={row.key}
                        placeholder="请输入请求头名称"
                        onChange={(event) => updateHeaderRow(index, { key: event.target.value })}
                      />
                    </label>
                    <label>
                      Value
                      <TextInput
                        value={row.value}
                        placeholder="请输入请求头值"
                        onChange={(event) => updateHeaderRow(index, { value: event.target.value })}
                      />
                    </label>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap justify-between gap-2">
              <ActionButton type="button" tone="ghost" onClick={addHeaderRow}>
                <Plus className="h-4 w-4" />
                请求头
              </ActionButton>
              <div className="flex gap-2">
                <ActionButton type="button" tone="ghost" onClick={props.onClose}>
                  取消
                </ActionButton>
                <ActionButton type="submit">
                  <Save className="h-4 w-4" />
                  保存模板
                </ActionButton>
              </div>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

