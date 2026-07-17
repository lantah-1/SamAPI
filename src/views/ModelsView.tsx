import { Plus, RefreshCw, Save, Search, Trash2, Wand2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import type {
  AppSnapshot,
  ProviderApiKeyGroupView,
  ProviderModelManageMode
} from "../../shared/types";
import type { ProviderApiKeyDraft, ProviderKeyGroupDraft } from "../app/types";
import { formatTime, isOfficialGrokSite } from "../app/utils";
import { ActionButton, SelectInput, TextInput } from "../components/ui";

export function ModelsView(props: {
  snapshot: AppSnapshot;
  modelDraft: ProviderKeyGroupDraft;
  modelEditorOpen: boolean;
  busy: boolean;
  modelSyncing: boolean;
  modelSyncingGroupId: string | null;
  onModelDraft: (value: ProviderKeyGroupDraft) => void;
  onSubmitModels: (event: FormEvent) => void;
  onCloseModels: () => void;
  onSyncModels: (options?: { mode?: ProviderModelManageMode | "all"; groupIds?: string[] }) => void;
  onFetchGroupModels: (groupId: string) => void;
  onModelManageModeChange: (groupId: string, mode: ProviderModelManageMode) => void;
  onEditModels: (group: ProviderApiKeyGroupView) => void;
}) {
  const groups = props.snapshot.providerApiKeyGroups;
  const modelEditorSite = props.snapshot.sites.find((site) => site.id === props.modelDraft.siteId);
  const autoGroupCount = groups.filter((group) => (group.modelManageMode || "manual") === "auto").length;

  const updateModelApiKey = (index: number, patch: Partial<ProviderApiKeyDraft>) => {
    props.onModelDraft({
      ...props.modelDraft,
      apiKeys: props.modelDraft.apiKeys.map((apiKey, itemIndex) => (itemIndex === index ? { ...apiKey, ...patch } : apiKey))
    });
  };

  return (
    <>
      {groups.length === 0 ? (
        <div className="center-empty">暂无上游密钥分组，请先在「上游密钥」中添加</div>
      ) : (
        <section className="panel p-4">
          <div className="form-head">
            <div>
              <h2>模型管理</h2>
              <div className="mt-1 text-xs font-bold text-ink/55">
                {groups.length} 个供应商 · {autoGroupCount} 个自动管理
              </div>
              <div className="mt-2 text-xs font-bold text-ink/45">
                列表仅预览。点「编辑」增删模型；「获取模型」拉取该站点；「立即同步」拉取全部站点。自动管理还会在每天约 8:00（随机偏移）自动执行。
              </div>
            </div>
            <ActionButton
              type="button"
              tone="ghost"
              disabled={props.modelSyncing || groups.length === 0}
              onClick={() => props.onSyncModels({ mode: "all" })}
            >
              <RefreshCw className={`h-4 w-4 ${props.modelSyncing && !props.modelSyncingGroupId ? "animate-spin" : ""}`} />
              立即同步
            </ActionButton>
          </div>
          <div className="site-list">
            {groups.map((group) => {
              const site = props.snapshot.sites.find((item) => item.id === group.siteId);
              const mode = (group.modelManageMode || "manual") as ProviderModelManageMode;
              const models = Array.from(new Set(group.apiKeys.flatMap((apiKey) => apiKey.models))).sort();
              const fetching = props.modelSyncingGroupId === group.id;
              const isGrokOfficial = isOfficialGrokSite(site) || group.apiKeys.some((apiKey) => apiKey.kind === "grok-official");
              return (
                <article key={group.id} className="record">
                  <div className="min-w-0 w-full">
                    <div className="form-head">
                      <div className="min-w-0">
                        <div className="record-title">{site?.name || group.groupName}</div>
                        <div className="record-meta">
                          {group.apiKeys.length} 个 Key · {models.length} 个模型
                          {group.lastModelSyncAt ? ` · 上次同步 ${formatTime(group.lastModelSyncAt)}` : ""}
                          {group.lastModelSyncStatus ? ` · ${group.lastModelSyncStatus}` : ""}
                        </div>
                        {group.lastModelSyncMessage ? (
                          <div className="mt-1 text-xs font-bold text-ink/45">{group.lastModelSyncMessage}</div>
                        ) : null}
                      </div>
                      <div className="model-card-actions">
                        <div className="model-mode-select">
                          <SelectInput
                            value={mode}
                            onChange={(event) => props.onModelManageModeChange(group.id, event.target.value === "auto" ? "auto" : "manual")}
                          >
                            <option value="manual">手动</option>
                            <option value="auto">自动</option>
                          </SelectInput>
                        </div>
                        <ActionButton type="button" tone="ghost" disabled={props.modelSyncing} onClick={() => props.onEditModels(group)} title="编辑模型">
                          <Wand2 className="h-4 w-4" />
                          编辑
                        </ActionButton>
                        {!isGrokOfficial ? (
                          <ActionButton
                            type="button"
                            tone="ghost"
                            disabled={props.modelSyncing}
                            onClick={() => props.onFetchGroupModels(group.id)}
                          >
                            <RefreshCw className={`h-4 w-4 ${fetching ? "animate-spin" : ""}`} />
                            获取
                          </ActionButton>
                        ) : null}
                      </div>
                    </div>

                    <div className="mt-4 space-y-3">
                      {group.apiKeys.map((apiKey) => (
                        <div key={apiKey.id} className="address-block">
                          <div className="text-xs font-black text-ink/55">
                            {apiKey.label}
                            {!apiKey.enabled ? " · 已停用" : ""}
                            {` · ${apiKey.models.length} 个模型`}
                          </div>
                          {apiKey.models.length > 0 ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {apiKey.models.slice(0, 24).map((model) => (
                                <span key={model} className="pill">
                                  {model}
                                </span>
                              ))}
                              {apiKey.models.length > 24 ? <span className="pill">+{apiKey.models.length - 24}</span> : null}
                            </div>
                          ) : (
                            <div className="mt-3 text-xs font-bold text-ink/40">暂无模型</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {props.modelEditorOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form onSubmit={props.onSubmitModels} className="modal-panel" role="dialog" aria-modal="true" aria-label="编辑模型列表">
            <div className="form-head">
              <div>
                <h2>编辑模型列表</h2>
                <div className="mt-1 text-xs font-bold text-ink/55">{modelEditorSite?.name || props.modelDraft.groupName || "供应商"}</div>
              </div>
              <ActionButton type="button" tone="ghost" onClick={props.onCloseModels} title="关闭">
                <X className="h-4 w-4" />
              </ActionButton>
            </div>

            <div className="mt-2 space-y-4">
              {props.modelDraft.apiKeys.map((apiKey, index) => (
                <ModelListEditor
                  key={apiKey.id || index}
                  label={apiKey.label || `API Key ${index + 1}`}
                  enabled={apiKey.enabled}
                  models={apiKey.models}
                  hint={
                    (props.modelDraft.modelManageMode || "manual") === "auto"
                      ? "自动管理模式下可临时修改，下次自动/立即同步会覆盖。"
                      : isOfficialGrokSite(modelEditorSite) || apiKey.kind === "grok-official"
                        ? "Grok 官方模型需手动维护。"
                        : "搜索定位、点删除移除、输入后点添加。"
                  }
                  onChange={(models) => updateModelApiKey(index, { models })}
                />
              ))}
            </div>

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <ActionButton type="button" tone="ghost" onClick={props.onCloseModels}>
                取消
              </ActionButton>
              <ActionButton type="submit" disabled={props.busy}>
                <Save className="h-4 w-4" />
                保存模型
              </ActionButton>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

function ModelListEditor(props: {
  label: string;
  enabled: boolean;
  models: string[];
  hint: string;
  onChange: (models: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState("");

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return props.models;
    return props.models.filter((model) => model.toLowerCase().includes(keyword));
  }, [props.models, query]);

  const addModel = () => {
    const next = pending.trim();
    if (!next) return;
    if (props.models.some((model) => model.toLowerCase() === next.toLowerCase())) {
      setPending("");
      return;
    }
    props.onChange(Array.from(new Set([...props.models, next])).sort((left, right) => left.localeCompare(right)));
    setPending("");
  };

  const removeModel = (model: string) => {
    props.onChange(props.models.filter((item) => item !== model));
  };

  return (
    <div className="address-block">
      <div className="text-xs font-black text-ink/55">
        {props.label}
        {!props.enabled ? " · 已停用" : ""}
        {` · ${props.models.length} 个模型`}
        {query.trim() ? ` · 显示 ${filtered.length}` : ""}
      </div>

      <label className="mt-3 block">
        搜索模型
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/35" />
          <TextInput
            className="pl-9"
            value={query}
            placeholder="输入关键字过滤列表"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </label>

      <div className="mt-3 max-h-56 space-y-2 overflow-y-auto rounded-xl border border-ink/10 bg-panel/40 p-2">
        {filtered.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs font-bold text-ink/40">
            {props.models.length === 0 ? "暂无模型，在下方添加" : "没有匹配的模型"}
          </div>
        ) : (
          filtered.map((model) => (
            <div key={model} className="flex items-center justify-between gap-2 rounded-lg bg-panel px-3 py-2">
              <span className="min-w-0 break-all text-sm font-bold text-ink">{model}</span>
              <ActionButton type="button" tone="danger" title="删除模型" onClick={() => removeModel(model)}>
                <Trash2 className="h-4 w-4" />
              </ActionButton>
            </div>
          ))
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="min-w-[12rem] flex-1">
          添加模型
          <TextInput
            value={pending}
            placeholder="输入模型名后点添加"
            onChange={(event) => setPending(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addModel();
              }
            }}
          />
        </label>
        <ActionButton type="button" tone="ghost" onClick={addModel} disabled={!pending.trim()}>
          <Plus className="h-4 w-4" />
          添加
        </ActionButton>
      </div>
      <span className="field-hint">{props.hint}</span>
    </div>
  );
}
