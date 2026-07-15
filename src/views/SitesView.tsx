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

export function SitesView(props: {
  snapshot: AppSnapshot;
  draft: Partial<Site>;
  editorOpen: boolean;
  onDraft: (value: Partial<Site>) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  onEdit: (site: Site) => void;
  onDelete: (id: string) => void;
}) {
  const addresses = props.draft.addresses || [{ ...blankAddress }];
  const updateAddress = (index: number, patch: Partial<SiteAddress>) => {
    props.onDraft({
      ...props.draft,
      addresses: addresses.map((address, itemIndex) => (itemIndex === index ? { ...address, ...patch } : address))
    });
  };
  const removeAddress = (index: number) => {
    if (addresses.length <= 1) return;
    props.onDraft({
      ...props.draft,
      addresses: addresses.filter((_address, itemIndex) => itemIndex !== index)
    });
  };
  return (
    <>
      {props.snapshot.sites.length === 0 ? (
        <div className="center-empty">暂无站点</div>
      ) : (
        <section className="panel p-4">
          <div className="form-head">
            <div>
              <h2>站点列表</h2>
              <div className="mt-1 text-xs font-bold text-ink/55">{props.snapshot.sites.length} 个站点</div>
            </div>
          </div>
        <div className="site-list">
          {props.snapshot.sites.map((site) => (
            <article key={site.id} className="record">
              <div>
                <div className="record-title">{site.name}</div>
                <div className="record-meta">
                  {siteTypeLabels[site.siteType || "unknown"]} / {site.addresses.length} 个地址
                </div>
              </div>
              <div className="record-actions">
                <ActionButton tone="ghost" onClick={() => props.onEdit(site)} title="编辑">
                  <Wand2 className="h-4 w-4" />
                </ActionButton>
                <ActionButton tone="danger" onClick={() => props.onDelete(site.id)} title="删除">
                  <Trash2 className="h-4 w-4" />
                </ActionButton>
              </div>
            </article>
          ))}
        </div>
        </section>
      )}

      {props.editorOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form onSubmit={props.onSubmit} className="modal-panel" role="dialog" aria-modal="true" aria-label="站点编辑">
            <div className="form-head">
              <h2>{props.draft.id ? "编辑站点" : "新增站点"}</h2>
              <ActionButton type="button" tone="ghost" onClick={props.onClose} title="关闭">
                <X className="h-4 w-4" />
              </ActionButton>
            </div>
            <div className="form-grid">
              <label>
                名称
                <TextInput value={props.draft.name || ""} onChange={(event) => props.onDraft({ ...props.draft, name: event.target.value })} />
              </label>
              <label>
                网站类型
                <SelectInput
                  value={props.draft.siteType || "unknown"}
                  onChange={(event) => props.onDraft({ ...props.draft, siteType: event.target.value as SiteType })}
                >
                  <option value="newapi">NewApi</option>
                  <option value="unknown">未知</option>
                </SelectInput>
              </label>
            </div>
            <div className="mt-4 space-y-3">
              {addresses.map((address, index) => (
                <div key={address.id || index} className="address-block">
                  <div className="address-block-head">
                    <div className="text-xs font-black text-ink/55">地址 {index + 1}</div>
                    <ActionButton
                      type="button"
                      tone="danger"
                      title="删除地址"
                      disabled={addresses.length <= 1}
                      onClick={() => removeAddress(index)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </ActionButton>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label>
                      地址名称
                      <TextInput value={address.label} onChange={(event) => updateAddress(index, { label: event.target.value })} />
                    </label>
                    <label>
                      Base URL
                      <TextInput
                        type="url"
                        inputMode="url"
                        placeholder="https://api.example.com/v1"
                        value={address.baseUrl}
                        onChange={(event) => updateAddress(index, { baseUrl: event.target.value })}
                      />
                    </label>
                  </div>
                  <label className="toggle-row mt-3">
                    <input type="checkbox" checked={address.enabled} onChange={(event) => updateAddress(index, { enabled: event.target.checked })} />
                    启用地址
                  </label>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap justify-between gap-2">
              <ActionButton
                type="button"
                tone="ghost"
                onClick={() => props.onDraft({ ...props.draft, addresses: [...addresses, { ...blankAddress, id: "" }] })}
              >
                <Plus className="h-4 w-4" />
                地址
              </ActionButton>
              <div className="flex gap-2">
                <ActionButton type="button" tone="ghost" onClick={props.onClose}>
                  取消
                </ActionButton>
                <ActionButton type="submit">
                  <Save className="h-4 w-4" />
                  保存站点
                </ActionButton>
              </div>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

