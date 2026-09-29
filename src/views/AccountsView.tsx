import { CircleCheck, CircleHelp, CircleX, KeyRound, LogIn, Pencil, Plus, RefreshCw, Star, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { accountProviders, type AccountProvider, type ManagedAccount, type ManagedAccountsSnapshot } from "../../shared/accounts";
import type { TemporaryAccountCheckItemResult } from "../../shared/types";
import { api } from "../api";
import type { TemporaryAccountImportDraft } from "../app/types";
import { emptyTemporaryAccountImport, formatQuotaPercent, formatTime, numericQuotaValue, parseModelText, serializeModelText, temporaryAccountQuotaPercent, temporaryAccountQuotaText } from "../app/utils";
import { AccountImportDialog } from "../components/AccountImportDialog";
import { ActionButton, SecretTextInput, SelectInput, TextInput } from "../components/ui";

const availabilityLabels = { available: "可用", unavailable: "不可用", unknown: "未确认" };
const kindLabels = { oauth: "ChatGPT 登录", "api-key": "API Key", "agent-identity": "Agent Identity" };
const message = (error: unknown) => error instanceof Error ? error.message : "操作失败";

export function ManagedAccountRow({ account, selected, busy, checking, onSelect, onEdit, onCheck, onReset, onToggle, onDelete }: {
  account: ManagedAccount; selected: boolean; busy: boolean; checking: boolean;
  onSelect: () => void; onEdit: () => void; onCheck: () => void; onReset: () => void; onToggle: () => void; onDelete: () => void;
}) {
  const StatusIcon = checking ? RefreshCw : account.availability === "available" ? CircleCheck : account.availability === "unavailable" ? CircleX : CircleHelp;
  const kindLabel = account.provider === "grok" && account.kind === "oauth"
    ? account.grokOAuthFormat === "grok2api-oauth" ? "grok2api OAuth" : "CPA OAuth"
    : kindLabels[account.kind];
  return <article className={`managed-account-row ${!account.enabled ? "managed-account-disabled" : ""}`}>
    <label className="managed-account-row-select"><input type="checkbox" checked={selected} disabled={busy} onChange={onSelect} aria-label={`选择 ${account.label}`} /></label>
    <div className="managed-account-content min-w-0">
      <div className="managed-account-title"><strong>{account.label}</strong>{account.preferred && <span className="managed-account-preferred"><Star className="h-3 w-3" />默认</span>}<span>{kindLabel}</span></div>
      <p className="managed-account-meta">{account.email && account.email !== account.label ? `${account.email} · ` : ""}{account.credentialPreview} · {account.models.length ? `${account.models.length} 个模型` : "默认模型范围"}</p>
      <div className="managed-account-health"><span className={`account-status account-status-${checking ? "checking" : account.availability}`}><StatusIcon className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />{checking ? "检查中" : !account.enabled ? "已停用" : availabilityLabels[account.availability]}</span><small>{account.lastCheckedAt ? `检查于 ${formatTime(account.lastCheckedAt)}` : "尚未检查"}{account.expiresAt ? ` · 授权到期 ${formatTime(account.expiresAt)}` : ""}</small></div>
      {account.lastCheckError && <p className="temp-account-error">{account.lastCheckError}</p>}
      {account.quotaStages.length > 0 && <div className="temp-account-quota-list">
        {account.quotaStages.map((stage, index) => {
          const percent = temporaryAccountQuotaPercent(stage);
          const isCreditsStage = stage.label === "Credits 余额";
          const quotaText = isCreditsStage ? `${stage.label}：${stage.remaining ?? "未知"}` : temporaryAccountQuotaText(stage);
          const isResetCreditStage = stage.label === "主动重置次数";
          const resetCount = numericQuotaValue(stage.remaining);
          return <div key={`${stage.label}-${index}`} className={`temp-account-quota temp-account-quota-${account.availability}`} title={quotaText}>
            <div className="temp-account-quota-head">
              <span>{stage.label}</span>
              <strong>{isCreditsStage ? stage.remaining ?? "未知" : isResetCreditStage ? resetCount == null ? "未知" : `${resetCount} 次` : formatQuotaPercent(percent)}</strong>
            </div>
            {!isResetCreditStage && !isCreditsStage && <div
              className="temp-account-quota-track"
              role="progressbar"
              aria-label={`${account.label} · ${stage.label}剩余额度`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={percent == null ? `${quotaText}，剩余比例未知` : `${formatQuotaPercent(percent)}，${quotaText}`}
            >
              {percent != null && percent > 0 && <div className="temp-account-quota-fill" style={{ width: `${percent}%` }} />}
            </div>}
            <div className="temp-account-quota-text">{quotaText}{stage.resetCreditExpiresAt?.length ? ` · ${stage.resetCreditExpiresAt.length} 张可用重置卡` : ""}</div>
          </div>;
        })}
      </div>}
      {account.models.length > 0 && <details className="managed-account-details"><summary>模型</summary><div className="managed-account-models">{account.models.map((model) => <code key={model}>{model}</code>)}</div></details>}
    </div>
    <div className="managed-account-actions">
      <ActionButton tone="ghost" disabled={busy || checking} aria-busy={checking} onClick={onCheck}><RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />检查</ActionButton>
      <ActionButton tone="ghost" disabled={busy} onClick={onEdit} aria-label={`编辑 ${account.label}`}><Pencil className="h-3.5 w-3.5" /></ActionButton>
      <label className="toggle-row"><input type="checkbox" checked={account.enabled} disabled={busy} onChange={onToggle} aria-label={`${account.enabled ? "停用" : "启用"} ${account.label}`} />启用</label>
      {account.kind !== "api-key" && account.quotaStages.some((stage) => stage.resetCreditExpiresAt?.length) && <ActionButton tone="ghost" disabled={busy} onClick={onReset}>使用重置卡</ActionButton>}
      <ActionButton tone="danger" disabled={busy} onClick={onDelete} aria-label={`删除 ${account.label}`}><Trash2 className="h-3.5 w-3.5" /></ActionButton>
    </div>
  </article>;
}

type AccountDraft = { id?: string; provider: AccountProvider; label: string; secret: string; modelsText: string; kind: ManagedAccount["kind"] };

export function AccountsView({ onChanged, onUnauthorized, onNotify }: { onChanged: () => Promise<void>; onUnauthorized: (error: unknown) => boolean; onNotify: (message: string) => void }) {
  const [data, setData] = useState<ManagedAccountsSnapshot>();
  const [provider, setProvider] = useState<AccountProvider>("gpt");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<AccountDraft>();
  const [importDraft, setImportDraft] = useState<TemporaryAccountImportDraft>(emptyTemporaryAccountImport);
  const [importOpen, setImportOpen] = useState(false);
  const [checking, setChecking] = useState<string[]>([]);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number }>();
  const [oauthBusy, setOauthBusy] = useState(false);
  const loginGeneration = useRef(0);
  const loginPopup = useRef<Window | null>(null);
  const mounted = useRef(true);
  const loadVersion = useRef(0);
  const refresh = async () => {
    const version = ++loadVersion.current;
    const value = await api.managedAccounts();
    if (mounted.current && version === loadVersion.current) setData(value);
  };
  useEffect(() => {
    mounted.current = true;
    refresh().catch((cause) => { if (!onUnauthorized(cause)) setError(message(cause)); }).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; loginGeneration.current++; loginPopup.current?.close(); };
  }, []);
  const state = data?.providers.find((item) => item.provider === provider);
  const accounts = state?.accounts || [];
  const visible = accounts.filter((account) => (filter === "all" || (filter === "disabled" ? !account.enabled : account.enabled && account.availability === filter)) && [account.label, account.email, ...account.models].join(" ").toLowerCase().includes(query.trim().toLowerCase()));
  const selectedIds = selected.filter((id) => accounts.some((account) => account.id === id));
  const run = async (operation: () => Promise<string>) => {
    setBusy(true); setError(""); onNotify("");
    try { const text = await operation(); await refresh(); await onChanged(); if (mounted.current) onNotify(text); }
    catch (cause) { if (mounted.current && !onUnauthorized(cause)) setError(message(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const applyCheck = (item: TemporaryAccountCheckItemResult) => setData((current) => current && ({ providers: current.providers.map((entry) => ({ ...entry, accounts: entry.accounts.map((account) => account.id === item.accountId ? { ...account, availability: item.availability, lastCheckedAt: item.checkedAt, lastCheckStatusCode: item.statusCode, lastCheckError: item.errorMessage, quotaStages: item.quotaStages } : account) })) }));
  const checkAccounts = async (ids: string[], showBatchProgress = false) => {
    if (showBatchProgress) setBatchProgress({ done: 0, total: ids.length });
    let cursor = 0; let available = 0; let failed = 0;
    try {
      await Promise.all(Array.from({ length: Math.min(3, ids.length) }, async () => {
        while (cursor < ids.length) {
          const id = ids[cursor++];
          setChecking((current) => [...current, id]);
          try {
            const result = await api.checkManagedAccount(id);
            available += result.available;
            for (const item of result.results) applyCheck(item);
          } catch (cause) { if (onUnauthorized(cause)) throw cause; failed++; }
          finally {
            setChecking((current) => current.filter((value) => value !== id));
            if (showBatchProgress) setBatchProgress((current) => current && ({ ...current, done: current.done + 1 }));
          }
        }
      }));
    } finally { if (showBatchProgress) setBatchProgress(undefined); setChecking([]); }
    return `检查完成：${available}/${ids.length} 个账号可用${failed ? `，${failed} 个检查请求失败` : ""}`;
  };
  const saveAccount = (event: FormEvent) => {
    event.preventDefault(); if (!draft) return;
    const value = draft;
    void run(async () => {
      const body = { label: value.label, secret: value.secret, models: parseModelText(value.modelsText) };
      if (value.id) { await api.updateManagedAccount(value.id, body); setDraft(undefined); return "账号已更新"; }
      const account = await api.createManagedAccount({ ...body, provider: value.provider });
      setDraft(undefined); await refresh();
      return `账号已添加。${await checkAccounts([account.id])}`;
    });
  };
  const importAccounts = (event: FormEvent) => {
    event.preventDefault();
    const value = importDraft;
    void run(async () => {
      const result = await api.importManagedAccounts({ ...value, models: parseModelText(value.modelsText) });
      setImportOpen(false); setImportDraft(emptyTemporaryAccountImport()); await refresh();
      const checked = result.accountIds?.length ? await checkAccounts(result.accountIds, true) : "";
      return `已导入 ${result.imported} 个 ${accountProviders[value.providerType].label} 账号，跳过 ${result.skipped} 个重复项${result.unrecognizedFiles?.length ? `，${result.unrecognizedFiles.length} 个文件未识别` : ""}。${checked}`;
    });
  };
  const login = async () => {
    const generation = ++loginGeneration.current;
    loginPopup.current = window.open("about:blank", "samapi-chatgpt-oauth", "popup=yes,width=720,height=820");
    setOauthBusy(true); setError(""); onNotify("正在打开 ChatGPT 授权页面…");
    try {
      const session = await api.startAccountOAuth();
      if (generation !== loginGeneration.current) return;
      if (loginPopup.current) loginPopup.current.location.href = session.authorizationUrl;
      else loginPopup.current = window.open(session.authorizationUrl, "samapi-chatgpt-oauth");
      if (!loginPopup.current) throw new Error("浏览器阻止了登录窗口，请允许弹窗后重试");
      onNotify("请在登录窗口选择 ChatGPT 账号，授权后会自动添加。再次登录可添加其他账号。");
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        if (generation !== loginGeneration.current || !mounted.current) return;
        const status = await api.accountOAuthStatus(session.state);
        if (status.status === "error") throw new Error(status.error || "ChatGPT 登录失败");
        if (status.status === "success" && status.accountId) {
          loginPopup.current?.close(); await refresh();
          await run(async () => `ChatGPT 登录成功。${await checkAccounts([status.accountId!])}`); return;
        }
        if (loginPopup.current?.closed) throw new Error("登录窗口已关闭，账号尚未完成授权");
      }
      throw new Error("登录等待超时，请重试");
    } catch (cause) { if (mounted.current && generation === loginGeneration.current && !onUnauthorized(cause)) setError(message(cause)); }
    finally { if (generation === loginGeneration.current) { loginPopup.current?.close(); setOauthBusy(false); } }
  };
  const newAccount = () => setDraft({ provider, label: "", secret: "", modelsText: "", kind: "api-key" });
  const openImport = () => {
    setImportDraft({ ...emptyTemporaryAccountImport(), providerType: provider, name: `${accountProviders[provider].label} 账号` });
    setImportOpen(true);
  };

  return <div className="grid min-w-0 grid-cols-1 gap-4">
    <section className="panel p-4">
      <div className="managed-provider-tabs" role="group" aria-label="账号供应商">{(Object.keys(accountProviders) as AccountProvider[]).map((id) => <button type="button" key={id} className={provider === id ? "managed-provider-active" : ""} aria-pressed={provider === id} onClick={() => { setProvider(id); setSelected([]); setQuery(""); setFilter("all"); setLimit(50); }}><strong>{accountProviders[id].label}</strong><small>{data?.providers.find((item) => item.provider === id)?.accounts.length || 0} 个账号</small></button>)}</div>
      <div className="form-head managed-account-header mt-4">
        <div className="managed-account-heading"><h2>{accountProviders[provider].label} 账号</h2><p className="field-hint mt-1">{accountProviders[provider].credentialHint}。账号不可用时自动尝试同供应商的其他可用账号。</p></div>
        <div className="managed-account-header-actions">
          {provider === "gpt" && <ActionButton disabled={busy || oauthBusy} onClick={() => void login()}><LogIn className="h-4 w-4" />{oauthBusy ? "等待登录" : "登录 ChatGPT"}</ActionButton>}
          {(provider === "gpt" || provider === "grok") && <ActionButton tone={provider === "grok" ? "primary" : "ghost"} disabled={busy} onClick={openImport}><Upload className="h-4 w-4" />导入账号</ActionButton>}
          {provider !== "grok" && <ActionButton tone={provider === "gpt" ? "ghost" : "primary"} disabled={busy} onClick={newAccount}><Plus className="h-4 w-4" />添加 API Key</ActionButton>}
        </div>
        <ActionButton className="managed-account-refresh" tone="ghost" disabled={busy || loading} aria-label="刷新账号列表" onClick={() => void run(async () => "账号列表已刷新")}><RefreshCw className="h-4 w-4" /></ActionButton>
      </div>
      {oauthBusy && <div className="managed-account-notice"><span>正在等待 ChatGPT 授权</span><ActionButton tone="ghost" onClick={() => { loginGeneration.current++; loginPopup.current?.close(); setOauthBusy(false); onNotify("已取消登录等待"); }}>取消等待</ActionButton></div>}
      {error && <p className="error-banner my-3" role="alert">{error}</p>}
      <div className="managed-account-toolbar">
        <TextInput aria-label="搜索账号" placeholder="搜索名称、邮箱或模型" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(50); }} />
        <SelectInput aria-label="账号状态" value={filter} onChange={(event) => { setFilter(event.target.value); setLimit(50); }}><option value="all">全部状态</option><option value="available">可用</option><option value="unknown">未确认</option><option value="unavailable">不可用</option><option value="disabled">已停用</option></SelectInput>
        <label className="managed-policy"><span>调度</span><SelectInput disabled={busy || !accounts.length} value={state?.strategy === "stable-first" ? "priority" : state?.strategy || "sequential"} onChange={(event) => void run(async () => { await api.managedAccountPolicy(provider, event.target.value); return "账号调度策略已更新"; })}><option value="priority">默认 / 顺序优先</option><option value="sequential">轮询</option><option value="random">随机</option></SelectInput></label>
        <ActionButton tone="ghost" disabled={busy || !accounts.length} aria-busy={Boolean(batchProgress)} onClick={() => void run(() => checkAccounts(selectedIds.length ? selectedIds : accounts.map((account) => account.id), true))}><RefreshCw className={`h-4 w-4 ${batchProgress ? "animate-spin" : ""}`} />{batchProgress ? `${batchProgress.done}/${batchProgress.total}` : selectedIds.length ? `检查所选 ${selectedIds.length}` : "检查全部"}</ActionButton>
      </div>
      <div className="managed-account-selection"><label className="toggle-row"><input type="checkbox" checked={visible.length > 0 && visible.every((account) => selected.includes(account.id))} disabled={busy || !visible.length} onChange={(event) => setSelected(event.target.checked ? visible.map((account) => account.id) : [])} />选择筛选结果 · {visible.length} 个</label><span>{accounts.filter((account) => account.enabled && account.availability === "available").length} 个可用 / 共 {accounts.length} 个</span>{selectedIds.length > 0 && <ActionButton tone="danger" disabled={busy} onClick={() => void run(async () => { await api.deleteManagedAccounts(selectedIds); setSelected([]); return "所选账号已删除"; })}>删除所选 {selectedIds.length}</ActionButton>}</div>
      {loading ? <div className="center-empty">正在加载账号…</div> : !visible.length ? <div className="center-empty center-empty-stack"><KeyRound className="h-6 w-6" /><strong>{accounts.length ? "没有匹配的账号" : `尚未添加 ${accountProviders[provider].label} 账号`}</strong><span className="field-hint">{accounts.length ? "调整名称或状态筛选" : accountProviders[provider].credentialHint}</span></div> : <div>{visible.slice(0, limit).map((account) => <ManagedAccountRow key={account.id} account={account} selected={selected.includes(account.id)} busy={busy} checking={checking.includes(account.id)} onSelect={() => setSelected((current) => current.includes(account.id) ? current.filter((id) => id !== account.id) : [...current, account.id])} onEdit={() => setDraft({ id: account.id, provider: account.provider, label: account.label, secret: "", modelsText: serializeModelText(account.models), kind: account.kind })} onCheck={() => void run(() => checkAccounts([account.id]))} onReset={() => void run(async () => { const result = await api.resetManagedAccount(account.id); for (const item of result.results) applyCheck(item); return "已使用重置卡并重新检查额度"; })} onToggle={() => void run(async () => { await api.updateManagedAccount(account.id, { enabled: !account.enabled }); return account.enabled ? "账号已停用" : "账号已启用"; })} onDelete={() => void run(async () => { await api.deleteManagedAccount(account.id); return "账号已删除"; })} />)}</div>}
      {visible.length > limit && <ActionButton tone="ghost" className="mt-3" onClick={() => setLimit((value) => value + 50)}>加载更多 · 已显示 {limit}/{visible.length}</ActionButton>}
    </section>
    {draft && <div className="modal-backdrop"><form className="modal-panel" role="dialog" aria-modal="true" aria-label={draft.id ? "编辑账号" : "添加账号"} onSubmit={saveAccount}><div className="form-head"><h2>{draft.id ? "编辑" : "添加"} {accountProviders[draft.provider].label} 账号</h2><ActionButton type="button" tone="ghost" disabled={busy} aria-label="关闭" onClick={() => setDraft(undefined)}><X className="h-4 w-4" /></ActionButton></div><div className="grid gap-4"><label>账号名称<TextInput required maxLength={200} value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="便于区分的名称" /></label>{draft.kind === "api-key" && <label>API Key<SecretTextInput required={!draft.id} value={draft.secret} placeholder={draft.id ? "留空保留现有凭据" : accountProviders[draft.provider].credentialHint} onChange={(event) => setDraft({ ...draft, secret: event.target.value })} /></label>}<label>模型列表<textarea className="field" rows={4} value={draft.modelsText} onChange={(event) => setDraft({ ...draft, modelsText: event.target.value })} placeholder="每行一个模型，首次添加可留空后自动获取" /><span className="field-hint">检查 API Key 时会同步供应商返回的可用模型。登录账号留空使用账号默认范围。</span></label></div><div className="flex justify-end gap-2 mt-4"><ActionButton type="button" tone="ghost" disabled={busy} onClick={() => setDraft(undefined)}>取消</ActionButton><ActionButton type="submit" disabled={busy}>{busy ? "保存中…" : "保存账号"}</ActionButton></div></form></div>}
    <AccountImportDialog draft={importDraft} editorOpen={importOpen} busy={busy} onDraft={setImportDraft} onSubmit={importAccounts} onClose={() => { if (!busy) setImportOpen(false); }} />
  </div>;
}
