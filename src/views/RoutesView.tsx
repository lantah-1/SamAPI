import {
  Braces,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Database,
  GripVertical,
  KeyRound,
  LockKeyhole,
  Map,
  MoreHorizontal,
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
import * as Popover from "@radix-ui/react-popover";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, FormEvent, PointerEvent as ReactPointerEvent } from "react";
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

type ActionDropTarget = {
  index: number;
  edge: "before" | "after";
};

function priorityInsertionIndex(fromIndex: number, target: ActionDropTarget) {
  let toIndex = target.index + (target.edge === "after" ? 1 : 0);
  if (fromIndex < toIndex) toIndex -= 1;
  return toIndex;
}

function priorityDropTargetForElement(element: HTMLElement, clientY: number): ActionDropTarget {
  const index = Number(element.dataset.groupPriorityIndex);
  const rect = element.getBoundingClientRect();
  return {
    index,
    edge: clientY < rect.top + rect.height / 2 ? "before" : "after"
  };
}

function priorityDropTargetAtPoint(clientX: number, clientY: number) {
  const element = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-group-priority-index]");
  return element ? priorityDropTargetForElement(element, clientY) : null;
}

function createPriorityDragPreview(item: HTMLElement) {
  const rect = item.getBoundingClientRect();
  const preview = item.cloneNode(true) as HTMLElement;
  preview.classList.remove("group-priority-item-dragging", "group-priority-item-drop-before", "group-priority-item-drop-after");
  preview.classList.add("group-priority-drag-preview");
  preview.removeAttribute("data-group-priority-index");
  preview.style.width = `${rect.width}px`;
  preview.style.left = `${rect.left}px`;
  preview.style.top = `${rect.top}px`;
  document.body.appendChild(preview);
  return { preview, rect };
}

function configureNativePriorityDrag(event: ReactDragEvent<HTMLButtonElement>, itemKey: string) {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", itemKey);
  const item = event.currentTarget.closest<HTMLElement>("[data-group-priority-index]");
  if (!item) return;
  const { preview, rect } = createPriorityDragPreview(item);
  event.dataTransfer.setDragImage(
    preview,
    Math.max(0, event.clientX - rect.left),
    Math.max(0, event.clientY - rect.top)
  );
  window.setTimeout(() => preview.remove(), 0);
}

function beginPointerPriorityDrag(
  event: ReactPointerEvent<HTMLButtonElement>,
  index: number,
  handlers: {
    onStart: (index: number) => void;
    onTargetChange: (target: ActionDropTarget | null) => void;
    onDrop: (target: ActionDropTarget | null) => void;
    onCancel: () => void;
  }
) {
  if (event.pointerType === "mouse") return;
  const item = event.currentTarget.closest<HTMLElement>("[data-group-priority-index]");
  if (!item) return;
  event.preventDefault();
  handlers.onStart(index);
  const { preview, rect } = createPriorityDragPreview(item);
  const pointerOffsetX = event.clientX - rect.left;
  const pointerOffsetY = event.clientY - rect.top;
  const pointerId = event.pointerId;
  let finishPointerDrag: (upEvent: PointerEvent) => void;
  let cancelPointerDrag: (cancelEvent: PointerEvent) => void;
  const movePointerDrag = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== pointerId) return;
    moveEvent.preventDefault();
    preview.style.left = `${moveEvent.clientX - pointerOffsetX}px`;
    preview.style.top = `${moveEvent.clientY - pointerOffsetY}px`;
    handlers.onTargetChange(priorityDropTargetAtPoint(moveEvent.clientX, moveEvent.clientY));
  };
  const cleanupPointerDrag = () => {
    preview.remove();
    window.removeEventListener("pointermove", movePointerDrag);
    window.removeEventListener("pointerup", finishPointerDrag);
    window.removeEventListener("pointercancel", cancelPointerDrag);
  };
  finishPointerDrag = (upEvent) => {
    if (upEvent.pointerId !== pointerId) return;
    const target = priorityDropTargetAtPoint(upEvent.clientX, upEvent.clientY);
    cleanupPointerDrag();
    handlers.onDrop(target);
  };
  cancelPointerDrag = (cancelEvent) => {
    if (cancelEvent.pointerId !== pointerId) return;
    cleanupPointerDrag();
    handlers.onCancel();
  };
  window.addEventListener("pointermove", movePointerDrag, { passive: false });
  window.addEventListener("pointerup", finishPointerDrag);
  window.addEventListener("pointercancel", cancelPointerDrag);
}

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
  onQuickSave: (route: Partial<RouteRecord>) => Promise<void>;
  onCopy: (value: string) => void;
}) {
  const switchRoutes = props.snapshot.routes.filter((route): route is SwitchRoute => route.type === "switch");
  const groupRoutes = props.snapshot.routes.filter((route): route is GroupRoute => route.type === "group");
  const routeCount = switchRoutes.length + groupRoutes.length;
  const modelOptions = providerModelOptions(props.snapshot);
  const enabledModelOptions = modelOptions.filter((option) => option.enabled);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [quickDrafts, setQuickDrafts] = useState<Record<string, Partial<RouteRecord>>>({});
  const [groupModelSearch, setGroupModelSearch] = useState("");
  const [draftDragIndex, setDraftDragIndex] = useState<number | null>(null);
  const [draftDropTarget, setDraftDropTarget] = useState<ActionDropTarget | null>(null);
  const [activeRouteMenuId, setActiveRouteMenuId] = useState<string | null>(null);
  const [routeActionEditor, setRouteActionEditor] = useState<{ routeId: string; mode: "strategy" | "proxy" } | null>(null);
  const [actionDragIndex, setActionDragIndex] = useState<number | null>(null);
  const [actionDropTarget, setActionDropTarget] = useState<ActionDropTarget | null>(null);
  const draftDragIndexRef = useRef<number | null>(null);
  const draftDropTargetRef = useRef<ActionDropTarget | null>(null);
  const actionDragIndexRef = useRef<number | null>(null);
  const actionDropTargetRef = useRef<ActionDropTarget | null>(null);
  const routeDraft = <T extends RouteRecord>(route: T): T => ({ ...route, ...(quickDrafts[route.id] || {}) } as T);
  const updateRouteDraft = <T extends RouteRecord>(route: T, patch: Partial<T>) => {
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
  const updateRouteProxy = (route: RouteRecord, mode: RouteProxyConfig["mode"]) => {
    const currentProxy = routeDraft(route).proxy;
    const customUrl = currentProxy?.mode === "custom" ? currentProxy.url : route.proxy?.mode === "custom" ? route.proxy.url : currentProxy?.url;
    updateRouteDraft(route, {
      proxy: mode === "custom" ? { mode, url: customUrl } : { mode }
    });
  };
  const saveQuickRoute = async (route: RouteRecord) => {
    const next = routeDraft(route);
    await props.onQuickSave(next);
    setQuickDrafts((current) => {
      const { [route.id]: _saved, ...rest } = current;
      return rest;
    });
  };
  const toggleRouteEnabled = async (route: RouteRecord) => {
    const enabled = !route.enabled;
    await props.onQuickSave({ ...route, enabled });
    setQuickDrafts((current) => {
      const draft = current[route.id];
      return draft ? { ...current, [route.id]: { ...draft, enabled } } : current;
    });
  };
  const draftType = props.draft.type || "switch";
  useEffect(() => {
    if (!props.editorOpen || draftType !== "group") setGroupModelSearch("");
  }, [props.editorOpen, draftType]);
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
  const groupModelSearchText = groupModelSearch.trim();
  const visibleModelOptions = groupModelSearchText
    ? modelOptions.filter(
        (option) =>
          smartModelMatches(option.model, groupModelSearchText) ||
          smartModelMatches(option.siteName, groupModelSearchText) ||
          smartModelMatches(option.apiKeyLabel, groupModelSearchText)
      )
    : modelOptions;
  const groupedModelOptions = props.snapshot.providerApiKeyGroups
    .map((group) => {
      const site = props.snapshot.sites.find((item) => item.id === group.siteId);
      const apiKeys = group.apiKeys
        .map((apiKey) => ({
          apiKey,
          options: visibleModelOptions.filter((option) => option.siteId === group.siteId && option.apiKeyId === apiKey.id)
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
    const rule = (props.draft.matchRule || "").trim();
    if (!rule) return;
    const matched = enabledModelOptions.filter((option) => modelMatchesRule(option.model, rule)).map(optionToMember);
    props.onDraft({ ...props.draft, type: "group", matchRule: rule, members: uniqueMembers([...draftMembers, ...matched]) });
  };
  const applySmartSelection = () => {
    const query = (props.draft.matchRule || "").trim();
    if (!query) return;
    const matched = enabledModelOptions.filter((option) => smartModelMatches(option.model, query)).map(optionToMember);
    props.onDraft({ ...props.draft, type: "group", matchRule: query, members: uniqueMembers([...draftMembers, ...matched]) });
  };
  const clearGroupSelection = () => updateGroupMembers([]);
  const moveGroupMember = (index: number, delta: number) => {
    const next = [...draftMembers];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    updateGroupMembers(next);
  };
  const setDraftDragPosition = (index: number | null) => {
    draftDragIndexRef.current = index;
    setDraftDragIndex(index);
  };
  const setDraftDropPosition = (target: ActionDropTarget | null) => {
    const current = draftDropTargetRef.current;
    if (current?.index === target?.index && current?.edge === target?.edge) return;
    draftDropTargetRef.current = target;
    setDraftDropTarget(target);
  };
  const clearDraftDrag = () => {
    setDraftDragPosition(null);
    setDraftDropPosition(null);
  };
  const reorderDraftGroupMember = (fromIndex: number | null, target: ActionDropTarget | null) => {
    if (fromIndex === null || !target) {
      clearDraftDrag();
      return;
    }
    const toIndex = priorityInsertionIndex(fromIndex, target);
    if (fromIndex === toIndex) {
      clearDraftDrag();
      return;
    }
    const next = [...draftMembers];
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) {
      clearDraftDrag();
      return;
    }
    next.splice(toIndex, 0, moved);
    updateGroupMembers(next);
    clearDraftDrag();
  };
  const removeGroupMember = (index: number) => {
    updateGroupMembers(draftMembers.filter((_, position) => position !== index));
  };
  const memberOptionLookup = new globalThis.Map(modelOptions.map((option) => [groupMemberKey(option), option] as const));
  const canSaveRoute = draftType !== "group" || selectedAvailableCount > 0;
  const actionRoute = routeActionEditor ? props.snapshot.routes.find((route) => route.id === routeActionEditor.routeId) : undefined;
  const actionDraft = actionRoute ? routeDraft(actionRoute) : undefined;
  const actionProxy = actionDraft ? normalizedRouteProxy(actionDraft.proxy) : { mode: "direct" as const };
  const actionMembersChanged =
    actionRoute?.type === "group" &&
    actionDraft?.type === "group" &&
    (actionRoute.members || []).map(groupMemberKey).join("\n") !== (actionDraft.members || []).map(groupMemberKey).join("\n");
  const actionHasChanges = !routeActionEditor || !actionRoute || !actionDraft
    ? false
    : routeActionEditor.mode === "strategy"
      ? actionRoute.type === "group" && ((actionDraft as GroupRoute).strategy !== actionRoute.strategy || actionMembersChanged)
      : !routeProxyConfigsEqual(actionDraft.proxy, actionRoute.proxy);
  const actionGroupMembers = actionRoute?.type === "group" && actionDraft?.type === "group" ? actionDraft.members || [] : [];
  const moveActionGroupMember = (index: number, delta: number) => {
    if (!actionRoute || actionRoute.type !== "group" || !actionDraft || actionDraft.type !== "group") return;
    const next = [...actionGroupMembers];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    updateRouteDraft(actionRoute, { members: next });
  };
  const setActionDragPosition = (index: number | null) => {
    actionDragIndexRef.current = index;
    setActionDragIndex(index);
  };
  const setActionDropPosition = (target: ActionDropTarget | null) => {
    const current = actionDropTargetRef.current;
    if (current?.index === target?.index && current?.edge === target?.edge) return;
    actionDropTargetRef.current = target;
    setActionDropTarget(target);
  };
  const clearActionDrag = () => {
    setActionDragPosition(null);
    setActionDropPosition(null);
  };
  const reorderActionGroupMember = (fromIndex: number | null, target: ActionDropTarget | null) => {
    if (fromIndex === null || !target || !actionRoute || actionRoute.type !== "group" || !actionDraft || actionDraft.type !== "group") {
      clearActionDrag();
      return;
    }
    const toIndex = priorityInsertionIndex(fromIndex, target);
    if (fromIndex === toIndex) {
      clearActionDrag();
      return;
    }
    const next = [...actionGroupMembers];
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) return;
    next.splice(toIndex, 0, moved);
    updateRouteDraft(actionRoute, { members: next });
    clearActionDrag();
  };
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
                    <RouteActionMenu
                      route={route}
                      open={activeRouteMenuId === route.id}
                      onOpenChange={(open) => setActiveRouteMenuId(open ? route.id : null)}
                      onToggle={() => toggleRouteEnabled(route)}
                      onCopy={() => props.onCopy(route.name)}
                      onEdit={() => props.onEdit(route)}
                      onDelete={() => props.onDelete(route.id)}
                      onProxy={() => setRouteActionEditor({ routeId: route.id, mode: "proxy" })}
                    />
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
                              <option key={siteOption.id} value={siteOption.id} disabled={siteOption.enabled === false}>
                                {siteOption.name}{siteOption.enabled === false ? "（已停用）" : ""}
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
                const quick = routeDraft(route);
                const orderedMembers = quick.strategy === "priority" ? groupRouteOrderedMembers(props.snapshot, quick) : [];
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
                          <span className="record-title">{route.name}</span>
                        </div>
                        <div className="record-meta">
                          关键词 {route.matchRule || "-"} / {groupStrategyLabels[quick.strategy]} / {endpointLabels[route.endpoint]}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <span className="pill">{stats.providerCount} 个供应商</span>
                          <span className="pill">{stats.keyCount} 个 Key</span>
                          <span className="pill">{stats.modelCount} 个模型</span>
                          <span className="pill">{route.enabled ? "已启用" : "已停用"}</span>
                        </div>
                      </div>
                    </div>
                    <div
                      className="record-actions route-record-actions"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <RouteActionMenu
                        route={route}
                        open={activeRouteMenuId === route.id}
                        onOpenChange={(open) => setActiveRouteMenuId(open ? route.id : null)}
                        onToggle={() => toggleRouteEnabled(route)}
                        onCopy={() => props.onCopy(route.name)}
                        onEdit={() => props.onEdit(route)}
                        onDelete={() => props.onDelete(route.id)}
                        onStrategy={() => setRouteActionEditor({ routeId: route.id, mode: "strategy" })}
                        onProxy={() => setRouteActionEditor({ routeId: route.id, mode: "proxy" })}
                      />
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
                            <strong>{groupStrategyLabels[quick.strategy]}</strong>
                          </div>
                          <div>
                            <span>请求头模板</span>
                            <strong>{props.snapshot.headerTemplates.find((template) => template.id === route.headerTemplateId)?.name || "不使用"}</strong>
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
                          ) : quick.strategy === "priority" ? (
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

      {routeActionEditor && actionRoute && actionDraft ? (
        <div className="modal-backdrop" role="presentation">
          <form
            className="modal-panel route-action-modal"
            role="dialog"
            aria-modal="true"
            aria-label={routeActionEditor.mode === "strategy" ? "更改调用策略" : "切换代理"}
            onSubmit={(event) => {
              event.preventDefault();
              saveQuickRoute(actionRoute).then(() => setRouteActionEditor(null));
            }}
          >
            <div className="form-head route-action-modal-head">
              <div>
                <h2>{routeActionEditor.mode === "strategy" ? "更改调用策略" : "切换代理"}</h2>
                <div className="mt-1 text-xs font-bold text-ink/55">{actionRoute.name}</div>
              </div>
              <ActionButton type="button" tone="ghost" onClick={() => setRouteActionEditor(null)} title="关闭">
                <X className="h-4 w-4" />
              </ActionButton>
            </div>
            <div className="route-action-modal-body">
              {routeActionEditor.mode === "strategy" && actionRoute.type === "group" ? (
                <>
                  <label>
                    调用策略
                    <SelectInput
                      value={(actionDraft as GroupRoute).strategy || "stable-first"}
                      onChange={(event) => updateRouteDraft(actionRoute, { strategy: event.target.value as GroupRouteStrategy })}
                    >
                      <option value="stable-first">{groupStrategyLabels["stable-first"]}</option>
                      <option value="sequential">{groupStrategyLabels.sequential}</option>
                      <option value="random">{groupStrategyLabels.random}</option>
                      <option value="priority">{groupStrategyLabels.priority}</option>
                    </SelectInput>
                  </label>
                  {(actionDraft as GroupRoute).strategy === "priority" ? (
                    <div className="route-action-priority">
                      <div className="group-priority-head">
                        <div>
                          <strong>优先级顺序</strong>
                          <span>按顺序调用，第 1 个优先</span>
                        </div>
                      </div>
                      {actionGroupMembers.length === 0 ? (
                        <div className="group-priority-empty">暂无组内模型</div>
                      ) : (
                        <ol
                          className="group-priority-list"
                          onDragLeave={(event) => {
                            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActionDropPosition(null);
                          }}
                        >
                          {actionGroupMembers.map((member, index) => {
                            const option = memberOptionLookup.get(groupMemberKey(member));
                            const dropClass =
                              actionDropTarget?.index === index ? `group-priority-item-drop-${actionDropTarget.edge}` : "";
                            return (
                              <li
                                key={groupMemberKey(member)}
                                className={`group-priority-item ${actionDragIndex === index ? "group-priority-item-dragging" : ""} ${dropClass}`}
                                data-group-priority-index={index}
                                onDragOver={(event) => {
                                  event.preventDefault();
                                  event.dataTransfer.dropEffect = "move";
                                  setActionDropPosition(priorityDropTargetForElement(event.currentTarget, event.clientY));
                                }}
                                onDrop={(event) => {
                                  event.preventDefault();
                                  const target = priorityDropTargetForElement(event.currentTarget, event.clientY);
                                  reorderActionGroupMember(actionDragIndexRef.current, target);
                                }}
                              >
                                <button
                                  type="button"
                                  className="group-priority-drag-handle"
                                  draggable
                                  title="拖动排序"
                                  aria-label="拖动排序"
                                  onDragStart={(event) => {
                                    setActionDragPosition(index);
                                    configureNativePriorityDrag(event, groupMemberKey(member));
                                  }}
                                  onDragEnd={clearActionDrag}
                                  onPointerDown={(event) =>
                                    beginPointerPriorityDrag(event, index, {
                                      onStart: setActionDragPosition,
                                      onTargetChange: setActionDropPosition,
                                      onDrop: (target) => reorderActionGroupMember(actionDragIndexRef.current, target),
                                      onCancel: clearActionDrag
                                    })
                                  }
                                >
                                  <GripVertical className="h-4 w-4" />
                                </button>
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
                                  <ActionButton type="button" tone="ghost" title="上移" disabled={index === 0} onClick={() => moveActionGroupMember(index, -1)}>
                                    <ChevronUp className="h-4 w-4" />
                                  </ActionButton>
                                  <ActionButton
                                    type="button"
                                    tone="ghost"
                                    title="下移"
                                    disabled={index === actionGroupMembers.length - 1}
                                    onClick={() => moveActionGroupMember(index, 1)}
                                  >
                                    <ChevronDown className="h-4 w-4" />
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
              ) : (
                <div className="form-grid">
                  <label className="form-span-2">
                    代理模式
                    <SelectInput
                      value={actionProxy.mode}
                      onChange={(event) => updateRouteProxy(actionRoute, event.target.value as RouteProxyConfig["mode"])}
                    >
                      <option value="direct">{routeProxyModeLabels.direct}</option>
                      <option value="system">{routeProxyModeLabels.system}</option>
                      <option value="custom">{routeProxyModeLabels.custom}</option>
                    </SelectInput>
                  </label>
                  {actionProxy.mode === "custom" ? (
                    <label className="form-span-2">
                      代理地址
                      <TextInput
                        value={actionProxy.url || ""}
                        placeholder="http://127.0.0.1:7890"
                        onChange={(event) => updateRouteDraft(actionRoute, { proxy: { mode: "custom", url: event.target.value } })}
                      />
                    </label>
                  ) : null}
                </div>
              )}
            </div>
            <div className="route-action-modal-actions">
              <ActionButton
                type="button"
                tone="ghost"
                disabled={!actionHasChanges}
                onClick={() => {
                  setQuickDrafts((current) => {
                    const { [actionRoute.id]: _discarded, ...rest } = current;
                    return rest;
                  });
                }}
              >
                还原
              </ActionButton>
              <ActionButton type="submit" disabled={!actionHasChanges}>
                <Save className="h-4 w-4" />
                保存
              </ActionButton>
            </div>
          </form>
        </div>
      ) : null}

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
                          <option key={site.id} value={site.id} disabled={site.enabled === false}>
                            {site.name}{site.enabled === false ? "（已停用）" : ""}
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
                          disabled={!props.draft.matchRule?.trim()}
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
                    {props.draft.strategy === "priority" ? (
                      <div className="group-priority-picker form-span-2">
                        <div className="group-priority-head">
                          <div>
                            <strong>优先级顺序</strong>
                            <span>按顺序调用，第 1 个优先，不可用时依次向下</span>
                          </div>
                        </div>
                        {draftMembers.length === 0 ? (
                          <div className="group-priority-empty">请先在下方勾选组内模型</div>
                        ) : (
                          <ol
                            className="group-priority-list"
                            onDragLeave={(event) => {
                              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraftDropPosition(null);
                            }}
                          >
                            {draftMembers.map((member, index) => {
                              const option = memberOptionLookup.get(groupMemberKey(member));
                              const dropClass =
                                draftDropTarget?.index === index ? `group-priority-item-drop-${draftDropTarget.edge}` : "";
                              return (
                                <li
                                  key={groupMemberKey(member)}
                                  className={`group-priority-item ${draftDragIndex === index ? "group-priority-item-dragging" : ""} ${dropClass}`}
                                  data-group-priority-index={index}
                                  onDragOver={(event) => {
                                    event.preventDefault();
                                    event.dataTransfer.dropEffect = "move";
                                    setDraftDropPosition(priorityDropTargetForElement(event.currentTarget, event.clientY));
                                  }}
                                  onDrop={(event) => {
                                    event.preventDefault();
                                    const target = priorityDropTargetForElement(event.currentTarget, event.clientY);
                                    reorderDraftGroupMember(draftDragIndexRef.current, target);
                                  }}
                                >
                                  <button
                                    type="button"
                                    className="group-priority-drag-handle"
                                    draggable
                                    title="拖动排序"
                                    aria-label="拖动排序"
                                    onDragStart={(event) => {
                                      setDraftDragPosition(index);
                                      configureNativePriorityDrag(event, groupMemberKey(member));
                                    }}
                                    onDragEnd={clearDraftDrag}
                                    onPointerDown={(event) =>
                                      beginPointerPriorityDrag(event, index, {
                                        onStart: setDraftDragPosition,
                                        onTargetChange: setDraftDropPosition,
                                        onDrop: (target) => reorderDraftGroupMember(draftDragIndexRef.current, target),
                                        onCancel: clearDraftDrag
                                      })
                                    }
                                  >
                                    <GripVertical className="h-4 w-4" />
                                  </button>
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
                {draftType === "group" ? (
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
                    <TextInput
                      className="group-model-search"
                      value={groupModelSearch}
                      placeholder="搜索模型、供应商或 Key"
                      onChange={(event) => setGroupModelSearch(event.target.value)}
                    />
                    {modelOptions.length === 0 ? (
                      <div className="group-model-empty">暂无可选模型</div>
                    ) : groupedModelOptions.length === 0 ? (
                      <div className="group-model-empty">没有匹配的模型</div>
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

function RouteActionMenu(props: {
  route: RouteRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onStrategy?: () => void;
  onProxy: () => void;
}) {
  const closeTimerRef = useRef<number | null>(null);
  const supportsHoverMenu = () =>
    typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const openFromHover = () => {
    if (!supportsHoverMenu()) return;
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    props.onOpenChange(true);
  };
  const closeFromHover = () => {
    if (!supportsHoverMenu()) return;
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      props.onOpenChange(false);
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && activeElement.classList.contains("route-more-action")) activeElement.blur();
    }, 120);
  };
  const keepHoverOpen = () => {
    if (!supportsHoverMenu()) return;
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  };
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  return (
    <Popover.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Popover.Trigger asChild>
        <ActionButton
          type="button"
          tone="ghost"
          className="route-more-action"
          title="更多操作"
          aria-label="更多操作"
          onMouseEnter={openFromHover}
          onMouseLeave={closeFromHover}
          onClick={(event) => {
            if (supportsHoverMenu()) event.preventDefault();
          }}
        >
          <MoreHorizontal className="h-4 w-4" />
        </ActionButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="route-action-menu" align="end" sideOffset={8} onMouseEnter={keepHoverOpen} onMouseLeave={closeFromHover}>
          <Popover.Close asChild>
            <button type="button" onClick={props.onToggle}>
              {props.route.enabled ? "停用路由" : "启用路由"}
            </button>
          </Popover.Close>
          {props.onStrategy ? (
            <Popover.Close asChild>
              <button type="button" onClick={props.onStrategy}>
                更改策略
              </button>
            </Popover.Close>
          ) : null}
          <Popover.Close asChild>
            <button type="button" onClick={props.onProxy}>
              切换代理
            </button>
          </Popover.Close>
          <Popover.Close asChild>
            <button type="button" onClick={props.onCopy}>
              复制名称
            </button>
          </Popover.Close>
          <Popover.Close asChild>
            <button type="button" onClick={props.onEdit}>
              编辑
            </button>
          </Popover.Close>
          <Popover.Close asChild>
            <button type="button" className="route-action-menu-danger" onClick={props.onDelete}>
              删除
            </button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
