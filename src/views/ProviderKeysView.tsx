import {
  Plus,
  Save,
  Trash2,
  Wand2,
  X
} from "lucide-react";
import type { FormEvent } from "react";
import type {
  AppSnapshot,
  ProviderApiKeyGroupView
} from "../../shared/types";
import type {
  ProviderApiKeyDraft,
  ProviderKeyGroupDraft
} from "../app/types";
import {
  emptyProviderApiKey,
  isOfficialGrokSite,
  isOfficialOpenAiSite
} from "../app/utils";
import { ActionButton, SecretTextInput, SelectInput, TextInput } from "../components/ui";

export function ProviderKeysView(props: {
  snapshot: AppSnapshot;
  draft: ProviderKeyGroupDraft;
  editorOpen: boolean;
  onDraft: (value: ProviderKeyGroupDraft) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
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
      apiKeys: [...props.draft.apiKeys, emptyProviderApiKey(selectedSite, props.draft.apiKeys.length)]
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
                  props.onDraft({
                    ...props.draft,
                    siteId: event.target.value,
                    groupName: site?.name || "",
                    apiKeys: [emptyProviderApiKey(site)]
                  });
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
                          <span className="field-hint">固定使用已导入的 Grok OAuth 临时账号池；模型请到「模型管理」页维护。</span>
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
                          {!hasApiKey && selectedSiteIsOfficialOpenAi ? (
                            <span className="field-hint">当前为空，将按 ChatGPT 官方账号池处理。</span>
                          ) : null}
                        </label>
                      )}
                    </div>
                    <div className="mt-3">
                      <label className="toggle-row">
                        <input type="checkbox" checked={apiKey.enabled} onChange={(event) => updateApiKey(index, { enabled: event.target.checked })} />
                        启用
                      </label>
                    </div>
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
  return (
    <article className="record">
      <div className="min-w-0">
        <div className="record-title">{props.siteName}</div>
        <div className="record-meta">
          {props.group.apiKeys.length} 个 Key · {(props.group.modelManageMode || "manual") === "auto" ? "自动管理模型" : "手动管理模型"}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {props.group.apiKeys.map((apiKey) => (
            <span key={apiKey.id} className="pill">
              {apiKey.label}: {apiKey.prefix}...{apiKey.enabled ? "" : " · 停用"}
            </span>
          ))}
        </div>
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
