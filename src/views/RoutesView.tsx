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

export function RoutesView(props: {
  snapshot: AppSnapshot;
  draft: RouteDraft;
  editorOpen: boolean;
  selectedSite?: Site;
  selectedSiteModels: string[];
  onDraft: (value: RouteDraft) => void;
  onSite: (siteId: string) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  onDelete: (id: string) => void;
  onEdit: (route: RouteRecord) => void;
  onQuickSave: (route: Partial<SwitchRoute>) => Promise<void>;
  onCopy: (value: string) => void;
}) {
  const switchRoutes = props.snapshot.routes.filter((route): route is SwitchRoute => route.type === "switch");
  const groupRoutes = props.snapshot.routes.filter((route): route is GroupRoute => route.type === "group");
  const routeCount = switchRoutes.length + groupRoutes.length;
  const modelOptions = providerModelOptions(props.snapshot);
  const enabledModelOptions = modelOptions.filter((option) => option.enabled);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [quickDrafts, setQuickDrafts] = useState<Record<string, Partial<SwitchRoute>>>({});
  const routeDraft = (route: SwitchRoute) => ({ ...route, ...(quickDrafts[route.id] || {}) });
  const updateRouteDraft = (route: SwitchRoute, patch: Partial<SwitchRoute>) => {
    setQuickDrafts((current) => ({
      ...current,
      [route.id]: {
        ...(current[route.id] || route),
        ...patch
      }
    }));
  };
  const updateRouteSite = (route: SwitchRoute, siteId: string) => {
    const site = props.snapshot.sites.find((item) => item.id === siteId);
    const models = siteModels(site);
    updateRouteDraft(route, {
      siteId,
      model: models[0] || ""
    });
  };
  const updateRouteProxy = (route: SwitchRoute, mode: RouteProxyConfig["mode"]) => {
    const currentProxy = routeDraft(route).proxy;
    const customUrl = currentProxy?.mode === "custom" ? currentProxy.url : route.proxy?.mode === "custom" ? route.proxy.url : currentProxy?.url;
    updateRouteDraft(route, {
      proxy: mode === "custom" ? { mode, url: customUrl } : { mode }
    });
  };
  const saveQuickRoute = async (route: SwitchRoute) => {
    const next = routeDraft(route);
    await props.onQuickSave(next);
    setQuickDrafts((current) => {
      const { [route.id]: _saved, ...rest } = current;
      return rest;
    });
  };
  const toggleRouteEnabled = async (route: SwitchRoute) => {
    const enabled = !route.enabled;
    await props.onQuickSave({ ...route, enabled });
    setQuickDrafts((current) => {
      const draft = current[route.id];
      return draft ? { ...current, [route.id]: { ...draft, enabled } } : current;
    });
  };
  const draftType = props.draft.type || "switch";
  const changeDraftType = (type: RouteType) => {
    if (type === draftType) return;
    const next = emptyRoute(props.snapshot, type);
    props.onDraft({
      ...next,
      id: props.draft.id,
      name: props.draft.name || next.name,
      endpoint: props.draft.endpoint || next.endpoint,
      headerTemplateId: props.draft.headerTemplateId || next.headerTemplateId,
      enabled: props.draft.enabled ?? true
    });
  };
  const switchModelOptions = mergeModelOptions([props.draft.model], props.selectedSiteModels);
  const draftMembers = props.draft.members || [];
  const selectedGroupKeys = new Set(draftMembers.map(groupMemberKey));
  const selectedAvailableCount = modelOptions.filter((option) => selectedGroupKeys.has(groupMemberKey(option))).length;
  const groupedModelOptions = props.snapshot.providerApiKeyGroups
    .map((group) => {
      const site = props.snapshot.sites.find((item) => item.id === group.siteId);
      const apiKeys = group.apiKeys
        .map((apiKey) => ({
          apiKey,
          options: modelOptions.filter((option) => option.siteId === group.siteId && option.apiKeyId === apiKey.id)
        }))
        .filter((item) => item.options.length > 0);
      return {
        siteId: group.siteId,
        siteName: site?.name || group.groupName,
        apiKeys
      };
    })
    .filter((group) => group.apiKeys.length > 0);
  const updateGroupMembers = (members: GroupRouteMember[]) => {
    props.onDraft({ ...props.draft, type: "group", members: uniqueMembers(members) });
  };
  const toggleGroupMember = (option: ProviderModelOption, checked: boolean) => {
    const optionKey = groupMemberKey(option);
    updateGroupMembers(checked ? [...draftMembers, optionToMember(option)] : draftMembers.filter((member) => groupMemberKey(member) !== optionKey));
  };
  const applyRuleSelection = () => {
    const rule = (props.draft.matchRule || props.draft.name || "").trim();
    const matched = enabledModelOptions.filter((option) => modelMatchesRule(option.model, rule)).map(optionToMember);
    props.onDraft({ ...props.draft, type: "group", matchRule: rule, members: uniqueMembers([...draftMembers, ...matched]) });
  };
  const applySmartSelection = () => {
    const query = (props.draft.matchRule || props.draft.name || "").trim();
    const matched = enabledModelOptions.filter((option) => smartModelMatches(option.model, query)).map(optionToMember);
    props.onDraft({ ...props.draft, type: "group", matchRule: props.draft.matchRule || query, members: uniqueMembers([...draftMembers, ...matched]) });
  };
  const clearGroupSelection = () => updateGroupMembers([]);
  const moveGroupMember = (index: number, delta: number) => {
    const next = [...draftMembers];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    updateGroupMembers(next);
  };
  const removeGroupMember = (index: number) => {
    updateGroupMembers(draftMembers.filter((_, position) => position !== index));
  };
  const memberOptionLookup = new globalThis.Map(modelOptions.map((option) => [groupMemberKey(option), option] as const));
  const canSaveRoute = draftType !== "group" || selectedAvailableCount > 0;
  return (
    <>
      {routeCount === 0 ? (
        <div className="center-empty">暂无路由</div>
      ) : (
        <div className="grid gap-4">
        {switchRoutes.length > 0 ? (
        <section className="panel p-4">
          <div className="form-head">
            <div>
              <h2>切换型路由</h2>
              <div className="mt-1 text-xs font-bold text-ink/55">{switchRoutes.length} 条路由</div>
            </div>
          </div>
          <div className="site-list">
            {switchRoutes.map((route) => {
              const site = props.snapshot.sites.find((item) => item.id === route.siteId);
              const quick = routeDraft(route);
              const quickSite = props.snapshot.sites.find((item) => item.id === quick.siteId) || site;
              const models = siteModels(quickSite);
              const modelOptions = mergeModelOptions([quick.model], models);
              const quickProxy = normalizedRouteProxy(quick.proxy);
              const hasCustomProxyOption = Boolean(route.proxy?.mode === "custom" && route.proxy.url?.trim());
              const isOpen = Boolean(expanded[route.id]);
              const hasChanges =
                quick.siteId !== route.siteId ||
                quick.model !== route.model ||
                quick.endpoint !== route.endpoint ||
                quick.headerTemplateId !== route.headerTemplateId ||
                !routeProxyConfigsEqual(quick.proxy, route.proxy) ||
                quick.enabled !== route.enabled;
              const toggleRoute = () => setExpanded((current) => ({ ...current, [route.id]: !isOpen }));
              return (
                <article
                  key={route.id}
                  className={`record route-record switch-route-record ${isOpen ? "route-record-open" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  onClick={toggleRoute}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    toggleRoute();
                  }}
                >
                  <div className="route-record-main">
                    <div className="min-w-0">
                      <div className="route-title-line">
                        <span className="route-expand-indicator">
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </span>
                        <span className="record-title">{route.name}</span>
                      </div>
                      <div className="record-meta">
                        {site?.name} / 目标模型 {route.model} / {endpointLabels[route.endpoint]}
                      </div>
                    </div>
                  </div>
                  <div
                    className="record-actions route-record-actions"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <ActionButton
                      tone="ghost"
                      className={`route-enable-action ${route.enabled ? "route-enable-action-on" : "route-enable-action-off"}`}
                      aria-pressed={route.enabled}
                      title={route.enabled ? "当前已启用，点击停用" : "当前已停用，点击启用"}
                      onClick={() => toggleRouteEnabled(route)}
                    >
                      <span className="route-enable-dot" aria-hidden="true" />
                      <span>{route.enabled ? "启用" : "停用"}</span>
                    </ActionButton>
                    <ActionButton tone="ghost" title="复制模型名" onClick={() => props.onCopy(route.name)}>
                      <Copy className="h-4 w-4" />
                    </ActionButton>
                    <ActionButton tone="ghost" onClick={() => props.onEdit(route)} title="编辑">
                      <Wand2 className="h-4 w-4" />
                    </ActionButton>
                    <ActionButton tone="danger" onClick={() => props.onDelete(route.id)} title="删除">
                      <Trash2 className="h-4 w-4" />
                    </ActionButton>
                  </div>
                  {isOpen ? (
                    <div
                      className="route-quick-panel"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <div className="route-quick-grid">
                        <label className="route-quick-control">
                          <span className="route-quick-label">供应商</span>
                          <SelectInput value={quick.siteId || ""} onChange={(event) => updateRouteSite(route, event.target.value)}>
                            <option value="">选择供应商</option>
                            {props.snapshot.sites.map((siteOption) => (
                              <option key={siteOption.id} value={siteOption.id}>
                                {siteOption.name}
                              </option>
                            ))}
                          </SelectInput>
                        </label>
                        <label className="route-quick-control">
                          <span className="route-quick-label">快捷切换模型</span>
                          <SelectInput
                            value={quick.model || ""}
                            disabled={modelOptions.length === 0}
                            onChange={(event) => updateRouteDraft(route, { model: event.target.value })}
                          >
                            {modelOptions.length === 0 ? <option value="">暂无可选模型</option> : null}
                            {modelOptions.map((model) => (
                              <option key={model} value={model}>
                                {model}
                              </option>
                            ))}
                          </SelectInput>
                        </label>
                        <label className="route-quick-control">
                          <span className="route-quick-label">代理模式</span>
                          <SelectInput
                            value={quickProxy.mode}
                            onChange={(event) => updateRouteProxy(route, event.target.value as RouteProxyConfig["mode"])}
                          >
                            <option value="direct">{routeProxyModeLabels.direct}</option>
                            <option value="system">{routeProxyModeLabels.system}</option>
                            {hasCustomProxyOption ? <option value="custom">{routeProxyModeLabels.custom}</option> : null}
                          </SelectInput>
                        </label>
                        <label className="route-quick-control">
                          <span className="route-quick-label">Endpoint</span>
                          <SelectInput
                            value={quick.endpoint || route.endpoint}
                            onChange={(event) => updateRouteDraft(route, { endpoint: event.target.value as EndpointKind })}
                          >
                            {props.snapshot.endpoints.map((endpoint) => (
                              <option key={endpoint} value={endpoint}>
                                {endpointLabels[endpoint]}
                              </option>
                            ))}
                          </SelectInput>
                        </label>
                        <label className="route-quick-control">
                          <span className="route-quick-label">请求头模板</span>
                          <SelectInput
                            value={quick.headerTemplateId || ""}
                            onChange={(event) => updateRouteDraft(route, { headerTemplateId: event.target.value || undefined })}
                          >
                            <option value="">不使用</option>
                            {props.snapshot.headerTemplates.map((template) => (
                              <option key={template.id} value={template.id}>
                                {template.name}
                              </option>
                            ))}
                          </SelectInput>
                        </label>
                      </div>
                      <div className="route-quick-actions">
                        <ActionButton
                          tone="ghost"
                          disabled={!hasChanges}
                          onClick={() =>
                            setQuickDrafts((current) => {
                              const { [route.id]: _discarded, ...rest } = current;
                              return rest;
                            })
                          }
                        >
                          还原
                        </ActionButton>
                        <ActionButton disabled={!hasChanges || !quick.model} onClick={() => saveQuickRoute(route)}>
                          <Save className="h-4 w-4" />
                          保存切换
                        </ActionButton>
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
        ) : null}
        {groupRoutes.length > 0 ? (
          <section className="panel p-4">
            <div className="form-head">
              <div>
                <h2>分组型路由</h2>
                <div className="mt-1 text-xs font-bold text-ink/55">{groupRoutes.length} 条路由</div>
              </div>
            </div>
            <div className="site-list">
              {groupRoutes.map((route) => {
                const stats = groupRouteStats(props.snapshot, route);
                const memberGroups = groupRouteMemberGroups(props.snapshot, route);
                const orderedMembers = route.strategy === "priority" ? groupRouteOrderedMembers(props.snapshot, route) : [];
                const headerTemplate = route.headerTemplateId
                  ? props.snapshot.headerTemplates.find((template) => template.id === route.headerTemplateId)
                  : undefined;
                const isOpen = Boolean(expanded[route.id]);
                const toggleRoute = () => setExpanded((current) => ({ ...current, [route.id]: !isOpen }));
                return (
                  <article
                    key={route.id}
                    className={`record route-record group-route-record ${isOpen ? "route-record-open" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-expanded={isOpen}
                    onClick={toggleRoute}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      toggleRoute();
                    }}
                  >
                    <div className="route-record-main">
                      <div className="min-w-0">
                        <div className="route-title-line">
                          <span className="route-expand-indicator">
                            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </span>
                          <span className="record-title">{route.name}</span>
                        </div>
                        <div className="record-meta">
                          关键词 {route.matchRule || "-"} / {groupStrategyLabels[route.strategy]} / {endpointLabels[route.endpoint]}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <span className="pill">{stats.providerCount} 个供应商</span>
                          <span className="pill">{stats.keyCount} 个 Key</span>
                          <span className="pill">{stats.modelCount} 个模型</span>
                          <span className="pill">{route.enabled ? "已启用" : "已停用"}</span>
                        </div>
                        {stats.models.length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {stats.models.slice(0, 6).map((model) => (
                              <span key={model} className="pill pill-muted">
                                {model}
                              </span>
                            ))}
                            {stats.models.length > 6 ? <span className="pill pill-muted">+{stats.models.length - 6}</span> : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <div
                      className="record-actions route-record-actions"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <ActionButton tone="ghost" title="复制模型名" onClick={() => props.onCopy(route.name)}>
                        <Copy className="h-4 w-4" />
                      </ActionButton>
                      <ActionButton tone="ghost" onClick={() => props.onEdit(route)} title="编辑">
                        <Wand2 className="h-4 w-4" />
                      </ActionButton>
                      <ActionButton tone="danger" onClick={() => props.onDelete(route.id)} title="删除">
                        <Trash2 className="h-4 w-4" />
                      </ActionButton>
                    </div>
                    {isOpen ? (
                      <div
                        className="route-detail-panel group-route-detail"
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <div className="group-route-summary">
                          <div>
                            <span>匹配关键词</span>
                            <strong>{route.matchRule || "-"}</strong>
                          </div>
                          <div>
                            <span>调用策略</span>
                            <strong>{groupStrategyLabels[route.strategy]}</strong>
                          </div>
                          <div>
                            <span>请求头模板</span>
                            <strong>{headerTemplate?.name || "不使用"}</strong>
                          </div>
                          <div>
                            <span>Endpoint</span>
                            <strong>{endpointLabels[route.endpoint]}</strong>
                          </div>
                        </div>
                        <div className="group-route-members">
                          <div className="group-route-members-head">
                            <strong>组内模型详情</strong>
                            <span>
                              {stats.providerCount} 个供应商 / {stats.keyCount} 个 Key / {stats.modelCount} 个模型
                            </span>
                          </div>
                          {memberGroups.length === 0 ? (
                            <div className="group-route-empty">暂无可用组内模型</div>
                          ) : route.strategy === "priority" ? (
                            <ol className="group-route-priority-list">
                              {orderedMembers.map((member, index) => (
                                <li key={member.key} className="group-route-priority-item">
                                  <span className="group-priority-rank">{index + 1}</span>
                                  <div className="group-priority-info">
                                    <strong>{member.model}</strong>
                                    <span>
                                      {member.siteName}
                                      {member.apiKeyLabel ? ` · ${member.apiKeyLabel}` : ""}
                                      {member.resolved ? "" : "（已失效）"}
                                    </span>
                                  </div>
                                </li>
                              ))}
                            </ol>
                          ) : (
                            <div className="group-route-member-list">
                              {memberGroups.map((provider) => (
                                <div key={provider.siteId} className="group-route-member-provider">
                                  <div className="group-route-provider-name">{provider.siteName}</div>
                                  {provider.apiKeys.map((apiKey) => (
                                    <div key={apiKey.apiKeyId} className="group-route-member-key">
                                      <div className="group-route-key-name">{apiKey.apiKeyLabel}</div>
                                      <div className="group-route-models">
                                        {apiKey.models.map((model) => (
                                          <span key={model} className="pill pill-muted">
                                            {model}
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}
        </div>
      )}

      {props.editorOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form onSubmit={props.onSubmit} className="modal-panel route-modal-panel" role="dialog" aria-modal="true" aria-label="路由编辑">
            <div className="form-head route-modal-head">
              <h2>{props.draft.id ? "编辑路由" : "新增路由"}</h2>
              <ActionButton type="button" tone="ghost" onClick={props.onClose} title="关闭">
                <X className="h-4 w-4" />
              </ActionButton>
            </div>
            <div className="route-modal-body">
              <div className="form-grid">
                <label>
                  路由名称
                  <TextInput value={props.draft.name || ""} onChange={(event) => props.onDraft({ ...props.draft, name: event.target.value })} />
                </label>
                <label>
                  路由类型
                  <SelectInput value={draftType} onChange={(event) => changeDraftType(event.target.value as RouteType)}>
                    <option value="switch">{routeTypeLabels.switch}</option>
                    <option value="group">{routeTypeLabels.group}</option>
                  </SelectInput>
                </label>
                {draftType === "switch" ? (
                  <>
                    <label>
                      供应商
                      <SelectInput value={props.draft.siteId || ""} onChange={(event) => props.onSite(event.target.value)}>
                        <option value="">选择供应商</option>
                        {props.snapshot.sites.map((site) => (
                          <option key={site.id} value={site.id}>
                            {site.name}
                          </option>
                        ))}
                      </SelectInput>
                    </label>
                    <label>
                      模型
                      <SelectInput
                        value={props.draft.model || ""}
                        disabled={switchModelOptions.length === 0}
                        onChange={(event) => props.onDraft({ ...props.draft, model: event.target.value })}
                      >
                        {switchModelOptions.length === 0 ? <option value="">请先选择供应商</option> : null}
                        {switchModelOptions.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </SelectInput>
                    </label>
                  </>
                ) : (
                  <>
                    <label className="form-span-2">
                      匹配关键词
                      <div className="group-rule-row">
                        <TextInput
                          value={props.draft.matchRule || ""}
                          placeholder="请输入关键词"
                          onChange={(event) => props.onDraft({ ...props.draft, type: "group", matchRule: event.target.value })}
                        />
                        <ActionButton type="button" tone="ghost" disabled={!props.draft.matchRule?.trim()} onClick={applyRuleSelection}>
                          前缀勾选
                        </ActionButton>
                        <ActionButton
                          type="button"
                          tone="ghost"
                          disabled={!(props.draft.matchRule || props.draft.name)?.trim()}
                          onClick={applySmartSelection}
                        >
                          <Wand2 className="h-4 w-4" />
                          智能勾选
                        </ActionButton>
                      </div>
                    </label>
                    <label>
                      调用策略
                      <SelectInput
                        value={props.draft.strategy || "stable-first"}
                        onChange={(event) => props.onDraft({ ...props.draft, type: "group", strategy: event.target.value as GroupRouteStrategy })}
                      >
                        <option value="stable-first">{groupStrategyLabels["stable-first"]}</option>
                        <option value="sequential">{groupStrategyLabels.sequential}</option>
                        <option value="random">{groupStrategyLabels.random}</option>
                        <option value="priority">{groupStrategyLabels.priority}</option>
                      </SelectInput>
                    </label>
                    <div className="group-model-picker form-span-2">
                      <div className="group-model-head">
                        <div>
                          <strong>组内模型</strong>
                          <span>
                            已选 {selectedAvailableCount} / 可用 {enabledModelOptions.length}
                          </span>
                        </div>
                        <ActionButton type="button" tone="ghost" disabled={selectedAvailableCount === 0} onClick={clearGroupSelection}>
                          清空
                        </ActionButton>
                      </div>
                      {modelOptions.length === 0 ? (
                        <div className="group-model-empty">暂无可选模型</div>
                      ) : (
                        <div className="group-model-list">
                          {groupedModelOptions.map((provider) => (
                            <div key={provider.siteId} className="group-model-provider">
                              <div className="group-model-provider-title">{provider.siteName}</div>
                              {provider.apiKeys.map(({ apiKey, options }) => (
                                <div key={apiKey.id} className="group-model-key">
                                  <div className="group-model-key-title">
                                    <span>{apiKey.label}</span>
                                    {!apiKey.enabled ? <span>已停用</span> : null}
                                  </div>
                                  <div className="group-model-options">
                                    {options.map((option) => {
                                      const optionKey = groupMemberKey(option);
                                      const checked = selectedGroupKeys.has(optionKey);
                                      return (
                                        <label
                                          key={optionKey}
                                          className={`group-model-option ${checked ? "group-model-option-checked" : ""} ${
                                            option.enabled ? "" : "group-model-option-disabled"
                                          }`}
                                        >
                                          <input
                                            type="checkbox"
                                            checked={checked}
                                            disabled={!option.enabled}
                                            onChange={(event) => toggleGroupMember(option, event.target.checked)}
                                          />
                                          <span>{option.model}</span>
                                        </label>
                                      );
                                    })}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {props.draft.strategy === "priority" ? (
                      <div className="group-priority-picker form-span-2">
                        <div className="group-priority-head">
                          <div>
                            <strong>优先级顺序</strong>
                            <span>按顺序调用，第 1 个优先，不可用时依次向下</span>
                          </div>
                        </div>
                        {draftMembers.length === 0 ? (
                          <div className="group-priority-empty">请先在上方勾选组内模型</div>
                        ) : (
                          <ol className="group-priority-list">
                            {draftMembers.map((member, index) => {
                              const option = memberOptionLookup.get(groupMemberKey(member));
                              return (
                                <li key={groupMemberKey(member)} className="group-priority-item">
                                  <span className="group-priority-rank">{index + 1}</span>
                                  <div className="group-priority-info">
                                    <strong>{option?.model || member.model}</strong>
                                    <span>
                                      {option?.siteName || member.siteId}
                                      {option?.apiKeyLabel ? ` · ${option.apiKeyLabel}` : ""}
                                      {option ? "" : "（已失效）"}
                                    </span>
                                  </div>
                                  <div className="group-priority-actions">
                                    <ActionButton
                                      type="button"
                                      tone="ghost"
                                      title="上移"
                                      disabled={index === 0}
                                      onClick={() => moveGroupMember(index, -1)}
                                    >
                                      <ChevronUp className="h-4 w-4" />
                                    </ActionButton>
                                    <ActionButton
                                      type="button"
                                      tone="ghost"
                                      title="下移"
                                      disabled={index === draftMembers.length - 1}
                                      onClick={() => moveGroupMember(index, 1)}
                                    >
                                      <ChevronDown className="h-4 w-4" />
                                    </ActionButton>
                                    <ActionButton type="button" tone="danger" title="移除" onClick={() => removeGroupMember(index)}>
                                      <Trash2 className="h-4 w-4" />
                                    </ActionButton>
                                  </div>
                                </li>
                              );
                            })}
                          </ol>
                        )}
                      </div>
                    ) : null}
                  </>
                )}
                <label>
                  请求头模板
                  <SelectInput
                    value={props.draft.headerTemplateId || ""}
                    onChange={(event) => props.onDraft({ ...props.draft, headerTemplateId: event.target.value || undefined })}
                  >
                    <option value="">不使用模板</option>
                    {props.snapshot.headerTemplates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </SelectInput>
                </label>
                <label>
                  Endpoint
                  <SelectInput
                    value={props.draft.endpoint || "messages"}
                    onChange={(event) => props.onDraft({ ...props.draft, endpoint: event.target.value as EndpointKind })}
                  >
                    {props.snapshot.endpoints.map((endpoint) => (
                      <option key={endpoint} value={endpoint}>
                        {endpointLabels[endpoint]}
                      </option>
                    ))}
                  </SelectInput>
                </label>
                <label>
                  代理模式
                  <SelectInput
                    value={props.draft.proxy?.mode || "direct"}
                    onChange={(event) => {
                      const mode = event.target.value as RouteProxyConfig["mode"];
                      props.onDraft({
                        ...props.draft,
                        proxy: mode === "direct" ? { mode } : { mode, url: props.draft.proxy?.url }
                      });
                    }}
                  >
                    <option value="direct">{routeProxyModeLabels.direct}</option>
                    <option value="system">{routeProxyModeLabels.system}</option>
                    <option value="custom">{routeProxyModeLabels.custom}</option>
                  </SelectInput>
                </label>
                {props.draft.proxy?.mode === "custom" ? (
                  <label>
                    代理地址
                    <TextInput
                      value={props.draft.proxy.url || ""}
                      placeholder="http://127.0.0.1:7890"
                      onChange={(event) => props.onDraft({ ...props.draft, proxy: { mode: "custom", url: event.target.value } })}
                    />
                  </label>
                ) : null}
              </div>
              <label className="toggle-row mt-3">
                <input
                  type="checkbox"
                  checked={props.draft.enabled ?? true}
                  onChange={(event) => props.onDraft({ ...props.draft, enabled: event.target.checked })}
                />
                启用
              </label>
            </div>
            <div className="route-modal-actions">
              <ActionButton type="button" tone="ghost" onClick={props.onClose}>
                取消
              </ActionButton>
              <ActionButton type="submit" disabled={!canSaveRoute}>
                <Save className="h-4 w-4" />
                保存路由
              </ActionButton>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

