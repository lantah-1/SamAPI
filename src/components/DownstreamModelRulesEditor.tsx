import { ArrowDown, ArrowRight, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { DownstreamModelRule, HeaderTemplate, ModelRuleCondition, ModelRuleMatch, ProviderApiKeyGroupView, RouteRecord, Site, TemporaryAccountGroup } from "../../shared/types";
import { modelRuleProviderModels, PROJECT_NAME_HEADER } from "../../shared/model-rules";
import { ActionButton, SelectInput, TextInput } from "./ui";

const headerSources = ["originator", "user-agent", "x-app", PROJECT_NAME_HEADER];
const legacyRouteProvider = "__legacy_route__";

function isOfficialOpenAiSite(site?: Site) {
  return Boolean(site?.addresses.some((address) => {
    try {
      return new URL(address.baseUrl).hostname.toLowerCase() === "api.openai.com";
    } catch {
      return false;
    }
  }));
}

export function DownstreamModelRulesEditor(props: {
  rules: DownstreamModelRule[];
  routes: RouteRecord[];
  sites: Site[];
  providerApiKeyGroups: ProviderApiKeyGroupView[];
  temporaryAccountGroups?: TemporaryAccountGroup[];
  headerTemplates: HeaderTemplate[];
  disabled: boolean;
  error: string;
  embedded?: boolean;
  onChange: (rules: DownstreamModelRule[]) => void;
}) {
  const update = (id: string, patch: Partial<DownstreamModelRule>) => {
    props.onChange(props.rules.map((rule) => rule.id === id ? { ...rule, ...patch } : rule));
  };
  const add = () => props.onChange([...props.rules, {
    id: crypto.randomUUID(), name: "新规则", enabled: true,
    model: props.rules.at(-1)?.model || "", targetSiteId: "", targetModel: "",
    conditions: []
  }]);
  const move = (index: number, offset: number) => {
    const rules = [...props.rules];
    [rules[index], rules[index + offset]] = [rules[index + offset], rules[index]];
    props.onChange(rules);
  };

  return (
    <div className={`${props.embedded ? "" : "settings-section form-span-2 "}model-rules-section`}>
      <div className="settings-section-head model-rules-head">
        <div>
          {props.embedded ? <p>共 {props.rules.length} 条规则 · {props.rules.filter((rule) => rule.enabled).length} 条已启用</p> : <>
            <h3>下游模型映射</h3>
            <p>先选供应商，再选该供应商的可用模型。按客户端或项目自上而下匹配，第一条命中的规则生效。</p>
          </>}
        </div>
        <div className="model-rule-actions">
          <ActionButton type="button" tone="ghost" disabled={props.disabled} onClick={add}>
            <Plus className="h-4 w-4" />添加规则
          </ActionButton>
        </div>
      </div>

      {props.rules.length === 0 ? (
        <div className="model-rules-empty">
          <ArrowRight className="h-5 w-5" aria-hidden="true" />
          <div><strong>为客户端和项目指定模型</strong><p>添加规则后依次选择供应商和目标模型，无需预先创建路由。未匹配的请求继续使用原路由。</p></div>
        </div>
      ) : (
        <div className="model-rules-list">
          {props.rules.map((rule, index) => {
            const target = props.routes.find((route) => route.id === rule.targetRouteId);
            const legacyRoute = Boolean(rule.targetRouteId && (!target || target.type === "group"));
            const siteId = rule.targetSiteId || (target?.type === "switch" ? target.siteId : "");
            const model = rule.targetModel || (target?.type === "switch" ? target.model : "");
            const site = props.sites.find((site) => site.id === siteId);
            const providerAvailable = Boolean(site?.enabled && site.addresses.some((address) => address.enabled));
            const models = site ? modelRuleProviderModels(site.id, props.providerApiKeyGroups) : [];
            const modelUnavailable = Boolean(model && (!providerAvailable || !models.includes(model)));
            const gptAccounts = (props.temporaryAccountGroups || [])
              .filter((group) => group.siteId === site?.id && (group.providerType || "gpt") === "gpt" && group.enabled !== false)
              .flatMap((group) => group.accounts);
            const canChooseGptAccount = Boolean(!legacyRoute && isOfficialOpenAiSite(site) && model && gptAccounts.length > 1);
            const selectedGptAccount = gptAccounts.find((account) => account.id === rule.temporaryAccountId);
            const changeProvider = (nextSiteId: string) => {
              if ((!legacyRoute && nextSiteId === siteId) || nextSiteId === legacyRouteProvider) return;
              update(rule.id, { targetRouteId: undefined, targetSiteId: nextSiteId, targetModel: "", temporaryAccountId: undefined });
            };
            const changeCondition = (conditionIndex: number, next: ModelRuleCondition) => update(rule.id, {
              conditions: rule.conditions.map((condition, i) => i === conditionIndex ? next : condition)
            });
            return (
              <article key={rule.id} className={`model-rule ${rule.enabled ? "" : "model-rule-disabled"}`} aria-label={`模型映射 ${index + 1}`}>
                <div className="model-rule-head">
                  <span className="model-rule-order" aria-label={`优先级 ${index + 1}`}>{String(index + 1).padStart(2, "0")}</span>
                  <label>规则名称<TextInput aria-label={`规则 ${index + 1} 名称`} value={rule.name} disabled={props.disabled} placeholder="规则名称" onChange={(event) => update(rule.id, { name: event.target.value })} /></label>
                  <div className="model-rule-actions">
                    <label className="toggle-row"><input type="checkbox" checked={rule.enabled} disabled={props.disabled} onChange={(event) => update(rule.id, { enabled: event.target.checked })} />启用</label>
                    <ActionButton type="button" tone="ghost" title="上移规则" aria-label={`上移规则 ${index + 1}`} disabled={props.disabled || index === 0} onClick={() => move(index, -1)}><ArrowUp className="h-4 w-4" /></ActionButton>
                    <ActionButton type="button" tone="ghost" title="下移规则" aria-label={`下移规则 ${index + 1}`} disabled={props.disabled || index === props.rules.length - 1} onClick={() => move(index, 1)}><ArrowDown className="h-4 w-4" /></ActionButton>
                    <ActionButton type="button" tone="ghost" title="删除规则" aria-label={`删除规则 ${index + 1}`} disabled={props.disabled} onClick={() => props.onChange(props.rules.filter((item) => item.id !== rule.id))}><Trash2 className="h-4 w-4" /></ActionButton>
                  </div>
                </div>

                <div className="model-rule-target">
                  <label>下游请求模型<TextInput value={rule.model} disabled={props.disabled} placeholder="如 gpt-5.6-sol" onChange={(event) => update(rule.id, { model: event.target.value })} /></label>
                  <ArrowRight className="model-rule-arrow h-4 w-4" aria-hidden="true" />
                  <label>1. 供应商<SelectInput aria-label={`规则 ${index + 1} 供应商`} value={legacyRoute ? legacyRouteProvider : siteId} disabled={props.disabled} onChange={(event) => changeProvider(event.target.value)}>
                    <option value="">选择供应商</option>
                    {legacyRoute ? <option value={legacyRouteProvider}>原路由（兼容）</option> : null}
                    {siteId && !site ? <option value={siteId} disabled>原供应商已删除</option> : null}
                    {props.sites.map((provider) => <option key={provider.id} value={provider.id} disabled={!provider.enabled || !provider.addresses.some((address) => address.enabled)}>{provider.name}{!provider.enabled ? "（已停用）" : !provider.addresses.some((address) => address.enabled) ? "（无可用地址）" : ""}</option>)}
                  </SelectInput></label>
                  <label>2. 目标模型<SelectInput aria-label={`规则 ${index + 1} 目标模型`} value={legacyRoute ? rule.targetRouteId : model} disabled={props.disabled || legacyRoute || !providerAvailable || models.length === 0} onChange={(event) => {
                    if (event.target.value !== model) update(rule.id, { targetRouteId: undefined, targetSiteId: siteId, targetModel: event.target.value, temporaryAccountId: undefined });
                  }}>
                    <option value="">{!siteId ? "请先选择供应商" : !providerAvailable ? "该供应商不可用" : !models.length ? "该供应商暂无可用模型" : "选择目标模型"}</option>
                    {legacyRoute ? <option value={rule.targetRouteId}>{target ? `${target.name} · 分组路由` : "原目标路由已删除"}</option> : null}
                    {!legacyRoute && model && !models.includes(model) ? <option value={model} disabled>{model}{rule.targetRouteId ? "（原路由模型）" : "（已不可用）"}</option> : null}
                    {models.map((model) => <option key={model} value={model}>{model}</option>)}
                  </SelectInput></label>
                  {canChooseGptAccount ? <label>3. 指定 GPT 账号<SelectInput aria-label={`规则 ${index + 1} GPT 账号`} value={rule.temporaryAccountId || ""} disabled={props.disabled} onChange={(event) => update(rule.id, { temporaryAccountId: event.target.value || undefined })}>
                    <option value="">自动选择账号</option>
                    {rule.temporaryAccountId && !selectedGptAccount ? <option value={rule.temporaryAccountId} disabled>原账号已删除</option> : null}
                    {gptAccounts.map((account) => {
                      const unsupported = account.models.length > 0 && !account.models.includes(model);
                      return <option key={account.id} value={account.id} disabled={!account.enabled || account.availability === "unavailable" || unsupported}>{account.label}{account.email && account.email !== account.label ? ` · ${account.email}` : ""}{!account.enabled ? "（已停用）" : account.availability === "unavailable" ? "（不可用）" : unsupported ? "（不支持该模型）" : ""}</option>;
                    })}
                  </SelectInput></label> : null}
                  {!rule.targetRouteId ? <label>{canChooseGptAccount ? "4." : "3."} 请求头模版<SelectInput aria-label={`规则 ${index + 1} 请求头模版`} value={rule.headerTemplateId || ""} disabled={props.disabled} onChange={(event) => update(rule.id, { headerTemplateId: event.target.value || undefined })}>
                    <option value="">不使用模版</option>
                    {rule.headerTemplateId && !props.headerTemplates.some((template) => template.id === rule.headerTemplateId) ? <option value={rule.headerTemplateId} disabled>原请求头模版已删除</option> : null}
                    {props.headerTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                  </SelectInput></label> : null}
                </div>
                {target && !target.enabled ? <p className="model-rule-warning">目标路由已停用，命中的请求将无法转发。</p> : null}
                {rule.targetRouteId && !target ? <p className="model-rule-warning">原目标路由已删除，请重新选择供应商和模型，或停用规则。</p> : null}
                {rule.targetRouteId && target ? <p className="model-rules-help">当前沿用路由「{target.name}」的配置。重新选择供应商或模型后改为直接映射。</p> : null}
                {!rule.targetRouteId && rule.headerTemplateId && !props.headerTemplates.some((template) => template.id === rule.headerTemplateId) ? <p className="model-rule-warning">请求头模版已删除，请重新选择模版或清除该配置。</p> : null}
                {!legacyRoute && siteId && !providerAvailable ? <p className="model-rule-warning">目标供应商已删除、停用或没有可用地址，请重新选择供应商。</p> : null}
                {!rule.targetRouteId && providerAvailable && modelUnavailable ? <p className="model-rule-warning">原目标模型已不可用，请重新选择模型或停用规则。</p> : null}
                {rule.temporaryAccountId && !canChooseGptAccount ? <p className="model-rule-warning">指定的 GPT 账号仅适用于官方 OpenAI 供应商，请重新选择账号或清除该配置。</p> : null}
                {rule.temporaryAccountId && canChooseGptAccount && !selectedGptAccount ? <p className="model-rule-warning">原指定账号已删除，请重新选择账号或改为自动选择。</p> : null}
                {selectedGptAccount && (!selectedGptAccount.enabled || selectedGptAccount.availability === "unavailable") ? <p className="model-rule-warning">指定的 GPT 账号已停用或不可用，请重新选择账号或改为自动选择。</p> : null}
                {selectedGptAccount && selectedGptAccount.models.length > 0 && !selectedGptAccount.models.includes(model) ? <p className="model-rule-warning">指定的 GPT 账号不支持当前目标模型，请重新选择账号或改为自动选择。</p> : null}
                {!legacyRoute && providerAvailable && models.length === 0 ? <p className="model-rules-help">该供应商暂无可用模型，请在「模型管理」维护模型，并确认相应的上游密钥已启用。</p> : null}

                <div className="model-rule-conditions">
                  <span className="model-rule-caption">{rule.conditions.length ? "同时满足以下条件" : "未添加条件，仅按下游模型名匹配。"}</span>
                  {rule.conditions.map((condition, conditionIndex) => {
                    const source = condition.source === "project" ? "project" : headerSources.includes(condition.header.toLowerCase()) ? condition.header.toLowerCase() : "header";
                    return (
                      <div className={`model-rule-condition ${source === "header" ? "model-rule-condition-custom" : ""}`} key={conditionIndex}>
                        <label>匹配来源<SelectInput value={source} disabled={props.disabled} onChange={(event) => {
                          const source = event.target.value;
                          changeCondition(conditionIndex, source === "project"
                            ? { source: "project", match: "exact", value: "" }
                            : { source: "header", header: source === "header" ? "x-client" : source, match: "exact", value: "" });
                        }}>
                          <option value="originator">Originator（客户端）</option>
                          <option value="user-agent">User-Agent</option>
                          <option value="project">项目目录 / 标识</option>
                          <option value={PROJECT_NAME_HEADER}>项目名称</option>
                          <option value="x-app">X-App</option>
                          <option value="header">其他请求头</option>
                        </SelectInput></label>
                        {source === "header" && condition.source === "header" ? <label>请求头名称<TextInput value={condition.header} disabled={props.disabled} placeholder="X-Client" onChange={(event) => changeCondition(conditionIndex, { ...condition, header: event.target.value })} /></label> : null}
                        <label>匹配方式<SelectInput value={condition.match} disabled={props.disabled} onChange={(event) => changeCondition(conditionIndex, { ...condition, match: event.target.value as ModelRuleMatch })}>
                          <option value="exact">完全相同</option><option value="contains">包含</option><option value="prefix">{source === "project" ? "目录及子目录" : "开头是"}</option>
                        </SelectInput></label>
                        <label>匹配内容<TextInput value={condition.value} disabled={props.disabled} placeholder={source === "project" ? "/Users/you/project 或项目标识" : source === PROJECT_NAME_HEADER ? "如 samapi" : source === "originator" ? "如 Codex Desktop" : source === "user-agent" ? "客户端 User-Agent 的固定部分" : "请求头中的值"} onChange={(event) => changeCondition(conditionIndex, { ...condition, value: event.target.value })} /></label>
                        <ActionButton type="button" tone="ghost" title="删除条件" aria-label={`删除规则 ${index + 1} 的条件 ${conditionIndex + 1}`} disabled={props.disabled} onClick={() => update(rule.id, { conditions: rule.conditions.filter((_, i) => i !== conditionIndex) })}><Trash2 className="h-4 w-4" /></ActionButton>
                      </div>
                    );
                  })}
                  <ActionButton type="button" tone="ghost" disabled={props.disabled} onClick={() => update(rule.id, {
                    conditions: [...rule.conditions, rule.conditions.some((condition) => condition.source === "header")
                      ? { source: "project", match: "exact", value: "" }
                      : { source: "header", header: "originator", match: "exact", value: "" }]
                  })}><Plus className="h-3.5 w-3.5" />添加条件</ActionButton>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {props.sites.length === 0 ? <p className="model-rules-help">暂无供应商，请先在「站点管理」添加供应商，并在「模型管理」维护可用模型。</p> : null}
      <p className="model-rules-help">项目目录：X-Samapi-Project-Path（兼容 X-Samapi-Project 和 Codex 工作区元数据）；项目名称：X-Samapi-Project-Name。入口会将 Codex 元数据补齐为这两个字段；仍缺失时照常转发，但不会命中项目限定的规则。项目字段仅用于本地匹配和日志，不转发上游。</p>
      <p className="model-rules-help">直接映射可单独选择请求头模版；当目标是官方 OpenAI 且 GPT 账号超过一个时，还可以固定具体账号。不选择账号时沿用默认调度。旧路由映射继续使用该路由原有的模版。在「请求日志」展开请求头可查看客户端和项目值。规则修改后点击「{props.embedded ? "保存映射" : "保存设置"}」，对后续请求生效。</p>
      {props.error ? <div className="auth-error mt-3" role="alert">{props.error}</div> : null}
    </div>
  );
}
