import { RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { Site } from "../../shared/types";
import type { ModelPrice, ModelPriceInput, ModelPriceRule, ModelPriceSyncReport, UsageFilters, UsageReport, UsageTotals } from "../../shared/usage";
import { api } from "../api";
import { ActionButton, SelectInput, TextInput } from "../components/ui";

const integer = (value: number) => (value ?? 0).toLocaleString("zh-CN");
const dollars = (value: number) => `$${(value ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "加载失败";

export function usageDateFilters(apiKeyId: string, from: string, to: string): UsageFilters {
  const start = from ? new Date(`${from}T00:00:00`) : undefined;
  const end = to ? new Date(`${to}T00:00:00`) : undefined;
  if (end) end.setDate(end.getDate() + 1);
  return { apiKeyId: apiKeyId || undefined, from: start?.toISOString(), to: end?.toISOString(), timezoneOffsetMinutes: -new Date().getTimezoneOffset() };
}

export function UsageSummary({ totals }: { totals: UsageTotals }) {
  return <>
    <div className="consumption-metrics">
      <div className="metric">总 Token{totals.estimatedRequests > 0 && "（含估算）"}<span>{integer(totals.totalTokens)}</span><small>输入 {integer(totals.inputTokens)} · 输出 {integer(totals.outputTokens)}</small>{totals.estimatedRequests > 0 && <small>其中估算 {integer(totals.estimatedTotalTokens)} Token</small>}</div>
      <div className="metric">缓存命中<span>{integer(totals.cachedInputTokens)}</span><small>缓存写入 {integer(totals.cacheWriteInputTokens)} · 已包含在输入中</small>{totals.estimatedCachedInputTokens > 0 && <small>其中估算 {integer(totals.estimatedCachedInputTokens)} Token</small>}</div>
      <div className="metric">估算消费 · USD<span>{dollars(totals.estimatedCostUsd)}</span><small>按调用时的模型定价计算</small>{totals.estimatedRequests > 0 && <small>含估算用量费用 {dollars(totals.estimatedUsageCostUsd)}</small>}</div>
      <div className="metric">客户端请求<span>{integer(totals.downstreamRequests)}</span><small>上游调用 {integer(totals.requests)} · 失败 {integer(totals.failedRequests)}</small></div>
    </div>
    <p className="field-hint" role="status">上游实报 {integer(totals.reportedRequests)} 次；估算 {integer(totals.estimatedRequests)} 次{totals.historicalEstimatedRequests > 0 && `（含历史补算 ${integer(totals.historicalEstimatedRequests)} 次）`}；处理中 {integer(totals.pendingRequests)} 次；{integer(totals.missingUsageRequests)} 次未返回完整用量且缺少估算依据；{integer(totals.unpricedRequests)} 次用量未定价。未定价部分不包含在估算消费中。</p>
    {totals.estimatedRequests > 0 && <details className="field-hint mt-2"><summary>估算方式与范围</summary><p>有实际用量时优先使用。缺失的文本用量使用本地分词器估算，消息结构及其他供应商的分词仍有偏差。缓存缺失时参考同客户端、同供应商、同模型的实报比例，并标记为估算；没有足够样本的金额保留为未定价。历史补算参考附近实报，未观察到生成内容的失败请求按 0 估算。图片、音频及不可见推理无法完整计入，金额仅供参考。</p></details>}
  </>;
}

function UsageTable({ rows, title }: { title: string; rows: Array<UsageTotals & { id: string; label: string; detail?: string }> }) {
  return <section className="panel p-4">
    <div className="form-head"><h2>{title}</h2></div>
    {rows.length === 0 ? <div className="center-empty">该范围内暂无用量</div> : <div className="consumption-table-scroll"><table className="consumption-table">
      <thead><tr><th>名称</th><th>调用</th><th>输入 Token</th><th>缓存命中</th><th>输出 Token</th><th>总 Token</th><th>估算 USD</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id}><th scope="row">{row.label}{row.detail && <small>{row.detail}</small>}</th><td>{integer(row.requests)}{row.pendingRequests > 0 && <small>{row.pendingRequests} 次处理中</small>}</td><td>{integer(row.inputTokens)}</td><td>{integer(row.cachedInputTokens)}</td><td>{integer(row.outputTokens)}</td><td>{integer(row.totalTokens)}{row.estimatedRequests > 0 && <small>含估算 {integer(row.estimatedTotalTokens)}</small>}</td><td>{dollars(row.estimatedCostUsd)}{row.estimatedRequests > 0 && <small>{row.estimatedRequests} 次用量估算</small>}{row.unpricedRequests > 0 && <small>{row.unpricedRequests} 次待定价</small>}{row.missingUsageRequests > 0 && <small>{row.missingUsageRequests} 次缺少估算依据</small>}</td></tr>)}</tbody>
    </table></div>}
  </section>;
}

export function UsageView({ sites, onUnauthorized }: { sites: Site[]; onUnauthorized: (error: unknown) => boolean }) {
  const [keyId, setKeyId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [report, setReport] = useState<UsageReport>();
  const [keys, setKeys] = useState<UsageReport["keys"]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [estimating, setEstimating] = useState(false);
  const [notice, setNotice] = useState("");
  const estimateMissing = async () => {
    setEstimating(true); setError(""); setNotice("");
    try {
      const result = await api.estimateMissingUsage(usageDateFilters(keyId, from, to));
      setNotice(`已补算 ${integer(result.updated)} 次历史用量${result.remaining ? `，${integer(result.remaining)} 次缺少估算依据` : ""}`);
      setRevision((value) => value + 1);
    } catch (cause) { if (!onUnauthorized(cause)) setError(errorMessage(cause)); }
    finally { setEstimating(false); }
  };
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setReport(undefined);
    Promise.resolve().then(() => api.usage(usageDateFilters(keyId, from, to))).then((value) => {
      if (active) { setReport(value); setKeys(value.keys); }
    }).catch((cause) => { if (active && !onUnauthorized(cause)) setError(errorMessage(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
    // The auth callback is recreated by App; queries depend only on the filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyId, from, to, revision]);

  return <div className="grid min-w-0 grid-cols-1 gap-4">
    <section className="panel p-4">
      <div className="form-head"><h2>消费统计</h2><ActionButton tone="ghost" disabled={loading} onClick={() => setRevision((value) => value + 1)}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />刷新</ActionButton></div>
      <div className="consumption-filters">
        <label>客户端 Key<SelectInput value={keyId} onChange={(event) => setKeyId(event.target.value)}><option value="">全部客户端</option>{keys.map((key) => <option key={key.id} value={key.id}>{key.name}{key.prefix ? ` · ${key.prefix}…` : ""}</option>)}</SelectInput></label>
        <label>开始日期<TextInput type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>结束日期（含当天）<TextInput type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} /></label>
        <ActionButton tone="ghost" onClick={() => { setFrom(""); setTo(""); }}>全部时间</ActionButton>
      </div>
      <p className="field-hint my-3">每次上游尝试单独统计，优先使用实际用量，缺失时自动估算。账目独立保存，清理请求日志不会影响消费统计。</p>
      {error && <p className="error-banner" role="alert">{error}</p>}
      {notice && <p className="field-hint mb-3" role="status">{notice}</p>}
      {loading ? <div className="center-empty">正在读取用量…</div> : report && <UsageSummary totals={report.totals} />}
      {Boolean(report?.totals.missingUsageRequests) && <ActionButton className="mt-3" tone="ghost" disabled={estimating || loading} onClick={() => void estimateMissing()}>{estimating ? "正在补算…" : "补算当前范围的历史未知用量"}</ActionButton>}
    </section>
    {report && <>
      <UsageTable title="客户端用量" rows={report.clients.map((row) => ({ ...row, id: row.apiKeyId, label: row.apiKeyName }))} />
      <UsageTable title="模型用量" rows={report.models.map((row) => ({ ...row, id: `${row.providerId}:${row.model}`, label: row.model, detail: row.providerName }))} />
      <UsageTable title="每日用量" rows={report.daily.map((row) => ({ ...row, id: row.date, label: row.date }))} />
    </>}
    <ModelPrices sites={sites} models={report?.models.map((row) => row.model) || []} onChanged={() => setRevision((value) => value + 1)} onUnauthorized={onUnauthorized} />
  </div>;
}

const blankPrice = () => ({ providerId: "", model: "", inputUsdPerMillion: "", cachedInputUsdPerMillion: "", cacheWriteUsdPerMillion: "", cacheWriteLongUsdPerMillion: "", outputUsdPerMillion: "" });
const priceLabels = { inputUsdPerMillion: "普通输入", cachedInputUsdPerMillion: "缓存命中", cacheWriteUsdPerMillion: "缓存写入（可选）", cacheWriteLongUsdPerMillion: "1 小时缓存写入（可选）", outputUsdPerMillion: "输出" };
const priceTime = (value?: string) => value ? new Date(value).toLocaleString("zh-CN") : "尚未更新";
const utcMinute = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const ruleDescription = (rule: ModelPriceRule) => [
  rule.aboveInputTokens !== undefined ? `输入超过 ${integer(rule.aboveInputTokens)} Token` : "",
  rule.weekdaysUtc ? "周一至周五" : "",
  rule.startMinuteUtc !== undefined && rule.endMinuteUtc !== undefined ? `${utcMinute(rule.startMinuteUtc)}–${utcMinute(rule.endMinuteUtc)} UTC` : "",
  rule.effectiveFrom ? `${priceTime(rule.effectiveFrom)} 起` : "",
  rule.effectiveUntil ? `${priceTime(rule.effectiveUntil)} 前` : ""
].filter(Boolean).join(" · ");

function ModelPrices({ sites, models, onChanged, onUnauthorized }: { sites: Site[]; models: string[]; onChanged: () => void; onUnauthorized: (error: unknown) => boolean }) {
  const [prices, setPrices] = useState<ModelPrice[]>([]);
  const [sync, setSync] = useState<ModelPriceSyncReport>();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(50);
  const [draft, setDraft] = useState(blankPrice);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const refresh = async () => {
      let updating = false;
      try {
        const [values, state] = await Promise.all([api.modelPrices(), api.modelPriceSync()]);
        if (active) { setPrices(values); setSync(state); updating = state.running || state.sources.some((source) => source.status === "pending"); }
      } catch (cause) { if (active && !onUnauthorized(cause)) setError(errorMessage(cause)); }
      finally { if (active) timer = window.setTimeout(refresh, updating ? 3000 : 60000); }
    };
    void refresh();
    return () => { active = false; window.clearTimeout(timer); };
  }, []);
  const run = async (operation: () => Promise<string>) => {
    setBusy(true); setError(""); setNotice("");
    try { setNotice(await operation()); const [values, state] = await Promise.all([api.modelPrices(), api.modelPriceSync()]); setPrices(values); setSync(state); onChanged(); }
    catch (cause) { if (!onUnauthorized(cause)) setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const price: ModelPriceInput = { providerId: draft.providerId, model: draft.model, inputUsdPerMillion: Number(draft.inputUsdPerMillion), cachedInputUsdPerMillion: Number(draft.cachedInputUsdPerMillion), outputUsdPerMillion: Number(draft.outputUsdPerMillion), ...(draft.cacheWriteUsdPerMillion === "" ? {} : { cacheWriteUsdPerMillion: Number(draft.cacheWriteUsdPerMillion) }), ...(draft.cacheWriteLongUsdPerMillion === "" ? {} : { cacheWriteLongUsdPerMillion: Number(draft.cacheWriteLongUsdPerMillion) }) };
      await api.saveModelPrice(price); setDraft(blankPrice()); return "模型单价已保存，对新调用生效";
    });
  };
  const visiblePrices = prices.filter((price) => [price.model, price.source?.name, sites.find((site) => site.id === price.providerId)?.name].join(" ").toLowerCase().includes(query.trim().toLowerCase()));
  const failedSources = sync?.sources.filter((source) => source.status === "failed") || [];
  const editPrice = (price: ModelPrice) => setDraft({
    providerId: price.providerId, model: price.model,
    inputUsdPerMillion: String(price.inputUsdPerMillion),
    cachedInputUsdPerMillion: price.cacheReadUnavailable ? "" : String(price.cachedInputUsdPerMillion),
    outputUsdPerMillion: String(price.outputUsdPerMillion),
    cacheWriteUsdPerMillion: price.cacheWriteUsdPerMillion === undefined ? "" : String(price.cacheWriteUsdPerMillion),
    cacheWriteLongUsdPerMillion: price.cacheWriteLongUsdPerMillion === undefined ? "" : String(price.cacheWriteLongUsdPerMillion)
  });
  return <details className="panel p-4 consumption-details"><summary>模型定价 <small>USD / 百万 Token · {prices.length} 项 · 每日自动更新</small></summary>
    <div className="form-head consumption-price-head my-3"><p className="field-hint">每天北京时间 08:00 查询官方 Token 价格，失败后每小时重试。自动价格按响应的实际服务档位计算，未知档位保留为未定价；手动统一单价优先，已计费记录保留调用时的价格。工具调用、缓存存储和图像等额外费用不计入 Token 估算。</p><ActionButton tone="ghost" disabled={busy || sync?.running} onClick={() => void run(async () => { const result = await api.syncModelPrices(); setSync(result); const failed = result.sources.filter((source) => source.status === "failed"); return failed.length ? `价格更新完成，${failed.length} 个来源暂未更新，保留上次价格` : "官方模型价格已更新，对新调用生效"; })}><RefreshCw className={`h-4 w-4 ${busy || sync?.running ? "animate-spin" : ""}`} />{sync?.running ? "正在更新价格" : "立即更新价格"}</ActionButton></div>
    {failedSources.length > 0 && <p className="field-hint my-2" role="status">暂未更新：{failedSources.map((source) => source.name).join("、")}。可展开更新状态查看原因。</p>}
    {sync && <details className="consumption-details mb-3"><summary>更新状态 <small>{sync.sources.filter((source) => source.status === "success").length}/{sync.sources.length} 个来源已更新</small></summary><div className="consumption-table-scroll"><table className="consumption-table"><thead><tr><th>官方来源</th><th>上次成功</th><th>下次查询</th><th>状态</th></tr></thead><tbody>{sync.sources.map((source) => <tr key={source.id}><th scope="row"><a href={source.url} target="_blank" rel="noreferrer">{source.name}</a></th><td>{priceTime(source.lastSuccessAt)}</td><td>{source.nextSyncAt ? priceTime(source.nextSyncAt) : "即将更新"}</td><td>{source.status === "success" ? `${source.modelCount} 个模型` : source.status === "failed" ? source.error || "等待重试" : "等待首次更新"}</td></tr>)}</tbody></table></div></details>}
    {error && <p className="error-banner" role="alert">{error}</p>}{notice && <p className="field-hint" role="status">{notice}</p>}
    <form className="consumption-price-form" onSubmit={save}>
      <label>供应商<SelectInput value={draft.providerId} onChange={(event) => setDraft({ ...draft, providerId: event.target.value })}><option value="">全部供应商（通用价）</option>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</SelectInput></label>
      <label>上游模型<TextInput required list="consumption-models" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="输入完整模型名称" /><datalist id="consumption-models">{[...new Set(models)].map((model) => <option key={model} value={model} />)}</datalist></label>
      {(Object.keys(priceLabels) as Array<keyof typeof priceLabels>).map((field) => <label key={field}>{priceLabels[field]}<TextInput type="number" min="0" max="100000" step="0.000001" required={field !== "cacheWriteUsdPerMillion" && field !== "cacheWriteLongUsdPerMillion"} value={draft[field]} onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} /></label>)}
      <ActionButton type="submit" disabled={busy}><Save className="h-4 w-4" />保存单价</ActionButton>
    </form>
    {prices.length > 0 && <>
      <TextInput className="mb-3" aria-label="搜索模型价格" placeholder="搜索模型或价格来源" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(50); }} />
      <div className="consumption-table-scroll"><table className="consumption-table">
        <thead><tr><th>供应商 / 模型</th><th>基础输入</th><th>缓存命中</th><th>缓存写入</th><th>基础输出</th><th>操作</th></tr></thead>
        <tbody>{visiblePrices.slice(0, limit).map((price) => <tr key={price.id}>
          <th scope="row">{price.model}
            <small>{sites.find((site) => site.id === price.providerId)?.name || (price.providerId ? "历史供应商" : "通用价格")}{price.source ? <> · <a href={price.source.url} target="_blank" rel="noreferrer">{price.source.name} 官方</a></> : " · 手动配置"}</small>
            <small>更新于 {priceTime(price.updatedAt)}</small>
            {Boolean(price.rules?.length || price.serviceTiers || price.cacheWriteLongUsdPerMillion !== undefined || price.maxInputTokens || price.cacheReadRequiresMode) && <details className="mt-1">
              <summary>计费规则</summary>
              {price.cacheReadRequiresMode && <small>基础缓存价为隐式缓存；显式缓存命中：{price.explicitCachedInputUsdPerMillion ?? "未提供"}</small>}
              {price.rules?.map((rule, index) => <small key={index}>
                {ruleDescription(rule)}：输入 {rule.inputUsdPerMillion} / 缓存命中 {rule.cacheReadUnavailable ? "未提供" : rule.cachedInputUsdPerMillion} / 输出 {rule.outputUsdPerMillion}
                {rule.explicitCachedInputUsdPerMillion !== undefined ? ` / 显式缓存命中 ${rule.explicitCachedInputUsdPerMillion}` : ""}
                {rule.cacheWriteUsdPerMillion !== undefined ? ` / 缓存写入 ${rule.cacheWriteUsdPerMillion}` : ""}
              </small>)}
              {price.cacheWriteLongUsdPerMillion !== undefined && <small>1 小时缓存写入：{price.cacheWriteLongUsdPerMillion}</small>}
              {price.maxInputTokens !== undefined && <small>超过 {integer(price.maxInputTokens)} 输入 Token 的价格待确认</small>}
              {Object.entries(price.serviceTiers || {}).filter(([tier]) => tier !== "fast" || !price.serviceTiers?.priority).map(([tier, rates]) => <div key={tier}>
                <small>{tier === "priority" && price.serviceTiers?.fast ? "Fast / Priority" : tier}：输入 {rates.inputUsdPerMillion} / 缓存命中 {rates.cacheReadUnavailable ? "未提供" : rates.cachedInputUsdPerMillion} / 输出 {rates.outputUsdPerMillion}{rates.cacheWriteUsdPerMillion !== undefined ? ` / 缓存写入 ${rates.cacheWriteUsdPerMillion}` : ""}</small>
                {rates.rules?.map((rule, index) => <small key={index}>{ruleDescription(rule)}：输入 {rule.inputUsdPerMillion} / 缓存命中 {rule.cacheReadUnavailable ? "未提供" : rule.cachedInputUsdPerMillion} / 输出 {rule.outputUsdPerMillion}{rule.cacheWriteUsdPerMillion !== undefined ? ` / 缓存写入 ${rule.cacheWriteUsdPerMillion}` : ""}</small>)}
                {rates.maxInputTokens !== undefined && <small>超过 {integer(rates.maxInputTokens)} 输入 Token 的档位价格待确认</small>}
              </div>)}
            </details>}
          </th>
          <td>{price.inputUsdPerMillion}</td><td>{price.cacheReadUnavailable ? "未提供" : price.cachedInputUsdPerMillion}</td><td>{price.cacheWriteUsdPerMillion ?? "未提供"}</td><td>{price.outputUsdPerMillion}</td>
          <td><div className="flex gap-2">
            <ActionButton tone="ghost" disabled={busy} onClick={() => editPrice(price)}>{price.source ? "自定义" : "编辑"}</ActionButton>
            {!price.source && <ActionButton tone="ghost" disabled={busy} aria-label={`删除 ${price.model} 的单价`} onClick={() => void run(async () => { await api.deleteModelPrice(price.id); return "手动单价已删除，可立即更新以恢复官方价格"; })}><Trash2 className="h-4 w-4" /></ActionButton>}
          </div></td>
        </tr>)}</tbody>
      </table></div>
      {visiblePrices.length > limit && <ActionButton tone="ghost" className="mt-3" onClick={() => setLimit((value) => value + 50)}>加载更多 · 已显示 {limit}/{visiblePrices.length}</ActionButton>}
    </>}
    <ActionButton tone="ghost" className="mt-3" disabled={busy || prices.length === 0} onClick={() => void run(async () => { const result = await api.priceUnpricedUsage(); return `已按当前单价补计 ${result.updated} 次调用`; })}>按当前价格补计未定价用量</ActionButton>
  </details>;
}
