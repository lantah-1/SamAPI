import { Activity, KeyRound, LockKeyhole, LogIn, RefreshCw, Route, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";
import type { AuthStatus } from "../app/types";
import { ActionButton, TextInput } from "./ui";

export function AuthLanding(props: {
  status: AuthStatus;
  busy: boolean;
  error: string;
  onLogin: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const checking = props.status === "checking";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!password.trim() || props.busy || checking) return;
    props.onLogin(password);
  };

  return (
    <main className="auth-page min-h-screen text-ink">
      <div className="grain" />
      <div className="auth-shell">
        <section className="auth-copy" aria-labelledby="auth-title">
          <div className="auth-kicker">
            <span className="auth-kicker-mark">
              <ShieldCheck className="h-4 w-4" />
            </span>
            Local model gateway
          </div>
          <h1 id="auth-title">SamAPI</h1>
          <p className="auth-intro">
            一个面向本地和私有部署的模型路由控制台，用来集中管理上游模型供应商、请求头模板、客户端密钥和路由策略。
          </p>
          <div className="auth-metric-row" aria-label="SamAPI capability summary">
            <div>
              <strong>Proxy</strong>
              <span>统一转发入口</span>
            </div>
            <div>
              <strong>Keys</strong>
              <span>客户端密钥</span>
            </div>
            <div>
              <strong>Logs</strong>
              <span>请求链路记录</span>
            </div>
          </div>
          <div className="auth-feature-grid">
            <div className="auth-feature">
              <Route className="h-4 w-4" />
              <span>在多个供应商、模型和 endpoint 之间切换路由。</span>
            </div>
            <div className="auth-feature">
              <KeyRound className="h-4 w-4" />
              <span>把上游 Key 和下游调用密钥分开管理。</span>
            </div>
            <div className="auth-feature">
              <Activity className="h-4 w-4" />
              <span>记录下游请求、上游响应和失败原因。</span>
            </div>
          </div>
        </section>

        <form className="auth-panel panel" onSubmit={submit}>
          <div className="auth-lock">
            <LockKeyhole className="h-5 w-5" />
          </div>
          <div>
            <h2>进入控制台</h2>
            <p>管理入口已启用密码保护。</p>
          </div>
          <label>
            管理密码
            <TextInput
              type="password"
              value={password}
              autoFocus
              autoComplete="current-password"
              disabled={props.busy || checking}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {props.error ? <div className="auth-error" role="alert">{props.error}</div> : null}
          <ActionButton type="submit" disabled={!password.trim() || props.busy || checking}>
            {props.busy || checking ? <RefreshCw className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
            {checking ? "检查会话" : "进入"}
          </ActionButton>
        </form>
      </div>
    </main>
  );
}
