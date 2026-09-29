import { Check, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import type { AppSettings, AppThemeId, UpstreamRetryDelay } from "../../../shared/types";
import { MAX_UPSTREAM_RETRY_DELAY_SECONDS, normalizeUpstreamRetryDelay } from "../../../shared/upstream-retry";
import { themeOptions } from "../../app/constants";
import { ActionButton, SelectInput, TextInput } from "../ui";
import { SettingsDialog, SettingsDialogFooter, SettingsFormDialog } from "./SettingsDialog";
import type { SettingsPageProps } from "./types";

export const numericSettings = {
  maxRequestLogs: { title: "日志保留", label: "日志最多保留条数", max: 5000, unit: "条", description: "控制请求日志的保留数量，按完整用户输入日志计算。降低上限会清理超出的历史日志。" },
  adminSessionTtlMinutes: { title: "会话有效期", label: "管理会话有效分钟数", max: 43200, unit: "分钟", description: "设置管理会话的有效时长，过期后需要重新输入管理员密码。" },
  requestTimeoutSeconds: { title: "上游请求超时", label: "超时秒数", max: 600, unit: "秒", description: "等待上游响应头的最长时间；流式响应开始后不会被此设置中断。" }
} as const;
export type NumericSetting = keyof typeof numericSettings;

export function numericSettingUpdate(setting: NumericSetting, value: string): Partial<AppSettings> {
  const config = numericSettings[setting];
  const number = Number(value);
  if (!value.trim() || !Number.isInteger(number) || number < 1 || number > config.max) {
    throw new Error(`${config.label}需要是 1-${config.max} 之间的整数`);
  }
  return { [setting]: number };
}

export function NumericSettingsDialog(props: SettingsPageProps & { setting: NumericSetting }) {
  const config = numericSettings[props.setting];
  const [value, setValue] = useState(String(props.snapshot.settings[props.setting]));
  const hintId = useId();
  return (
    <SettingsFormDialog title={config.title} description={config.description} busy={props.busy} onClose={props.onClose}
      onSubmit={() => props.onSave(numericSettingUpdate(props.setting, value))}>
      <label className="settings-field-label">{config.label}
        <TextInput type="number" inputMode="numeric" min={1} max={config.max} step={1} required value={value} aria-describedby={hintId} onChange={(event) => setValue(event.target.value)} />
      </label>
      <p id={hintId} className="settings-field-hint">可设置 1-{config.max.toLocaleString("zh-CN")} {config.unit}。</p>
    </SettingsFormDialog>
  );
}

const preventNumberStep = (event: React.KeyboardEvent<HTMLInputElement>) => {
  if (event.key === "ArrowUp" || event.key === "ArrowDown") event.preventDefault();
};
const preventNumberWheel = (event: React.WheelEvent<HTMLInputElement>) => event.currentTarget.blur();
const digitsOnly = (value: string) => value.replace(/[^\d]/g, "");

export function retrySettingEntry(status: string, value: string): AppSettings["upstreamRetryCodeCounts"][number] {
  const statusCode = Number(status);
  const count = Number(value);
  if (!status.trim() || !Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) throw new Error("状态码需要是 400-599 之间的整数");
  if (!value.trim() || !Number.isSafeInteger(count) || count < 0) throw new Error("重试次数需要是不小于 0 的整数");
  return { statusCode, count };
}

interface RetryDelayDraft {
  mode: UpstreamRetryDelay["mode"];
  seconds: string;
  minSeconds: string;
  maxSeconds: string;
}

export function retryDelaySetting(draft: RetryDelayDraft): UpstreamRetryDelay {
  const seconds = (value: string, label: string) => {
    if (!value.trim()) throw new Error(`请填写${label}`);
    return Number(value);
  };
  if (draft.mode === "immediate") return { mode: "immediate" };
  if (draft.mode === "fixed") return normalizeUpstreamRetryDelay({ mode: draft.mode, seconds: seconds(draft.seconds, "重试间隔") });
  return normalizeUpstreamRetryDelay({ mode: draft.mode, minSeconds: seconds(draft.minSeconds, "最短等待时间"), maxSeconds: seconds(draft.maxSeconds, "最长等待时间") });
}

export function RetrySettingsDialog(props: SettingsPageProps) {
  const delayHintId = useId();
  const [counts, setCounts] = useState(() => structuredClone(props.snapshot.settings.upstreamRetryCodeCounts));
  const [delay, setDelay] = useState<RetryDelayDraft>(() => {
    const saved = normalizeUpstreamRetryDelay(props.snapshot.settings.upstreamRetryDelay);
    return { mode: saved.mode, seconds: String(saved.mode === "fixed" ? saved.seconds : 1),
      minSeconds: String(saved.mode === "random" ? saved.minSeconds : 1), maxSeconds: String(saved.mode === "random" ? saved.maxSeconds : 3) };
  });
  const [status, setStatus] = useState("");
  const [count, setCount] = useState("");
  const [error, setError] = useState("");
  const add = () => {
    try {
      const entry = retrySettingEntry(status, count);
      setCounts((current) => [...current.filter((item) => item.statusCode !== entry.statusCode), entry].sort((a, b) => a.statusCode - b.statusCode));
      setStatus(""); setCount(""); setError("");
    } catch (error) { setError(error instanceof Error ? error.message : "请检查重试配置"); }
  };
  return (
    <SettingsFormDialog title="上游错误码重试配置" description="上游返回指定状态码时，在切换目标前重试。未配置或次数为 0 时，不重试该错误码。"
      busy={props.busy} onClose={props.onClose} onSubmit={async () => {
        if (status || count) throw new Error("请先添加填写的重试配置，或清空输入后再保存。");
        if (counts.some((item) => !Number.isSafeInteger(item.count) || item.count < 0)) throw new Error("重试次数需要是不小于 0 的整数");
        await props.onSave({ upstreamRetryCodeCounts: counts, upstreamRetryDelay: retryDelaySetting(delay) });
      }}>
      <div className="settings-retry-add-row">
        <label className="settings-field-label">状态码<TextInput type="number" inputMode="numeric" min={400} max={599} step={1} placeholder="如 502" value={status}
          onChange={(event) => { setStatus(digitsOnly(event.target.value)); setError(""); }} onKeyDown={preventNumberStep} onWheel={preventNumberWheel} /></label>
        <label className="settings-field-label">重试次数<TextInput type="number" inputMode="numeric" min={0} step={1} placeholder="不设上限" value={count}
          onChange={(event) => { setCount(digitsOnly(event.target.value)); setError(""); }} onKeyDown={preventNumberStep} onWheel={preventNumberWheel} /></label>
        <ActionButton type="button" tone="ghost" disabled={props.busy} onClick={add}><Plus className="h-4 w-4" />添加</ActionButton>
      </div>
      {error ? <div className="auth-error mt-3" role="alert">{error}</div> : null}
      {counts.length ? <div className="settings-retry-list">
        {counts.map((item) => <div key={item.statusCode} className="settings-retry-row">
          <span className="settings-retry-code">HTTP {item.statusCode}</span>
          <label className="settings-retry-count-label">重试次数<TextInput type="number" inputMode="numeric" min={0} step={1} value={String(item.count)} aria-label={`HTTP ${item.statusCode} 重试次数`}
            onChange={(event) => setCounts((current) => current.map((entry) => entry.statusCode === item.statusCode ? { ...entry, count: Number(digitsOnly(event.target.value)) } : entry))}
            onKeyDown={preventNumberStep} onWheel={preventNumberWheel} /></label>
          <ActionButton type="button" tone="ghost" className="settings-retry-remove" aria-label={`删除 HTTP ${item.statusCode} 的重试配置`}
            onClick={() => setCounts((current) => current.filter((entry) => entry.statusCode !== item.statusCode))}><Trash2 className="h-4 w-4" aria-hidden="true" /><span className="settings-retry-remove-text">删除</span></ActionButton>
        </div>)}
      </div> : <p className="settings-retry-empty">还没有配置错误码重试次数。</p>}
      <div className="settings-retry-timing">
        <div><h3>重试时间规则</h3><p className="settings-field-hint">统一用于上方已配置且次数大于 0 的错误码；首次请求不等待。</p></div>
        <label className="settings-field-label">等待方式
          <SelectInput aria-label="重试时间规则" aria-describedby={delayHintId} disabled={props.busy} value={delay.mode} onChange={(event) => setDelay((current) => ({ ...current, mode: event.target.value as RetryDelayDraft["mode"] }))}>
            <option value="random">随机间隔</option>
            <option value="fixed">固定间隔</option>
            <option value="immediate">立即重试</option>
          </SelectInput>
        </label>
        {delay.mode !== "immediate" ? <div className="settings-retry-delay-fields">
          {delay.mode === "fixed" ? <label className="settings-field-label">重试间隔（秒）
            <TextInput type="number" inputMode="decimal" min={0} max={MAX_UPSTREAM_RETRY_DELAY_SECONDS} step={0.001} required value={delay.seconds} aria-describedby={delayHintId}
              onChange={(event) => setDelay((current) => ({ ...current, seconds: event.target.value }))} onKeyDown={preventNumberStep} onWheel={preventNumberWheel} />
          </label> : <>
            <label className="settings-field-label">最短等待时间（秒）
              <TextInput type="number" inputMode="decimal" min={0} max={MAX_UPSTREAM_RETRY_DELAY_SECONDS} step={0.001} required value={delay.minSeconds} aria-describedby={delayHintId}
                onChange={(event) => setDelay((current) => ({ ...current, minSeconds: event.target.value }))} onKeyDown={preventNumberStep} onWheel={preventNumberWheel} />
            </label>
            <label className="settings-field-label">最长等待时间（秒）
              <TextInput type="number" inputMode="decimal" min={0} max={MAX_UPSTREAM_RETRY_DELAY_SECONDS} step={0.001} required value={delay.maxSeconds} aria-describedby={delayHintId}
                onChange={(event) => setDelay((current) => ({ ...current, maxSeconds: event.target.value }))} onKeyDown={preventNumberStep} onWheel={preventNumberWheel} />
            </label>
          </>}
        </div> : null}
        <p id={delayHintId} className="settings-field-hint">{delay.mode === "random" ? "每次重试都在范围内重新随机抽取等待时间，最短时间不能大于最长时间。" : delay.mode === "fixed" ? "每次重试前等待相同的时间。" : "失败后不额外等待，直接执行下一次重试。"}
          {delay.mode !== "immediate" ? ` 可设置 0-${MAX_UPSTREAM_RETRY_DELAY_SECONDS} 秒，最多 3 位小数。` : ""}等待期间取消请求会立即停止。</p>
      </div>
      <div className="settings-dialog-callout">
        <p>每次请求独立计算次数，所有尝试追加到原会话日志。599 包括连接失败、响应头超时、空响应、错误响应及流式响应中途失败。</p>
        <p>启用 599 重试后，会等待上游响应完整结束再返回内容。失败尝试不会重复发送，首段内容因此会延后；客户端取消时立即停止。</p>
      </div>
    </SettingsFormDialog>
  );
}

export function ThemeSettingsDialog(props: SettingsPageProps) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const busy = props.busy || saving;
  const choose = async (themeId: AppThemeId) => {
    if (busy || themeId === props.snapshot.settings.themeId) return;
    setError(""); setSaving(true);
    try { await props.onSave({ themeId }); }
    catch (error) { setError(error instanceof Error ? error.message : "主题保存失败"); }
    finally { setSaving(false); }
  };
  return (
    <SettingsDialog title="界面主题" description="选择后立即预览并自动保存，不影响其他设置项。" wide busy={busy} onClose={props.onClose}>
      <div className="settings-dialog-body"><div className="theme-grid">
        {themeOptions.map((theme) => {
          const selected = theme.id === props.snapshot.settings.themeId;
          return <button key={theme.id} type="button" className={`theme-card ${selected ? "theme-card-active" : ""}`} aria-pressed={selected} disabled={busy}
            onClick={() => void choose(theme.id)}>
            <span className="theme-card-top"><span><span className="theme-card-name">{theme.name}</span><span className="theme-card-desc">{theme.description}</span></span><span className="theme-check">{selected ? <Check className="h-4 w-4" /> : null}</span></span>
            <span className="theme-swatches" aria-hidden="true">{theme.swatches.map((color) => <span key={color} className="theme-swatch" style={{ background: color }} />)}</span>
          </button>;
        })}
      </div></div>
      <SettingsDialogFooter error={error} note={busy ? "正在保存主题..." : "主题自动保存，无需再次点击保存。"}>
        <ActionButton type="button" disabled={busy} onClick={props.onClose}>完成</ActionButton>
      </SettingsDialogFooter>
    </SettingsDialog>
  );
}

export function validatePasswordChange(currentPassword: string, nextPassword: string, confirmPassword: string) {
  if (!currentPassword.trim()) throw new Error("请输入当前管理密码");
  if (nextPassword.length < 4 || !nextPassword.trim()) throw new Error("新管理密码至少需要 4 个字符");
  if (nextPassword !== confirmPassword) throw new Error("两次输入的新密码不一致");
}

export function PasswordSettingsDialog(props: SettingsPageProps) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  return (
    <SettingsFormDialog title="管理员密码" description={props.snapshot.security.adminPasswordCustomized ? "当前使用本地数据库中的自定义密码。" : "当前使用启动环境变量或本地默认密码。"}
      busy={props.busy} onClose={props.onClose} saveLabel="修改密码" note="修改成功后需使用新密码重新登录。"
      onSubmit={async () => { validatePasswordChange(current, next, confirm); await props.onPasswordChange(current, next); }}>
      <div className="settings-dialog-fields">
        <label className="settings-field-label">当前密码<TextInput type="password" required value={current} autoComplete="current-password" onChange={(event) => setCurrent(event.target.value)} /></label>
        <label className="settings-field-label">新密码<TextInput type="password" required minLength={4} value={next} autoComplete="new-password" onChange={(event) => setNext(event.target.value)} /></label>
        <label className="settings-field-label">确认新密码<TextInput type="password" required minLength={4} value={confirm} autoComplete="new-password" onChange={(event) => setConfirm(event.target.value)} /></label>
      </div>
    </SettingsFormDialog>
  );
}
