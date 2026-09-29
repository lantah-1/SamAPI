import { ArrowLeftRight, ChevronRight, Clock3, Database, FileText, LockKeyhole, Palette, RefreshCw, Timer } from "lucide-react";
import { useId, useState } from "react";
import { upstreamRetryDelaySummary } from "../../shared/upstream-retry";
import { themeOptions } from "../app/constants";
import { ActionButton } from "../components/ui";
import { BackupSettingsDialog } from "../components/settings/BackupSettingsDialog";
import { NumericSettingsDialog, PasswordSettingsDialog, RetrySettingsDialog, ThemeSettingsDialog } from "../components/settings/GeneralSettingsDialogs";
import { ModelMappingSettingsDialog } from "../components/settings/ModelMappingSettingsDialog";
import type { SettingsActions, SettingsPageProps } from "../components/settings/types";

export const settingsEntries = [
  { id: "modelMapping", title: "下游模型映射", description: "按客户端或项目指定供应商和模型", icon: ArrowLeftRight },
  { id: "retries", title: "上游错误码重试配置", description: "设置错误码的重试次数与等待时间", icon: RefreshCw },
  { id: "requestTimeoutSeconds", title: "上游请求超时", description: "设置等待上游响应头的最长时间", icon: Timer },
  { id: "maxRequestLogs", title: "日志保留", description: "管理请求日志的保留数量", icon: FileText },
  { id: "theme", title: "界面主题", description: "切换配色与明暗风格", icon: Palette },
  { id: "backup", title: "数据备份", description: "导出配置或从备份恢复", icon: Database },
  { id: "password", title: "管理员密码", description: "更换控制台的登录密码", icon: LockKeyhole },
  { id: "adminSessionTtlMinutes", title: "会话有效期", description: "设置管理会话的有效时长", icon: Clock3 }
] as const;
type SettingPage = typeof settingsEntries[number]["id"];

export function SettingsDetailPage(props: SettingsPageProps & { page: SettingPage }) {
  switch (props.page) {
    case "modelMapping": return <ModelMappingSettingsDialog {...props} />;
    case "retries": return <RetrySettingsDialog {...props} />;
    case "theme": return <ThemeSettingsDialog {...props} />;
    case "backup": return <BackupSettingsDialog {...props} />;
    case "password": return <PasswordSettingsDialog {...props} />;
    default: return <NumericSettingsDialog {...props} setting={props.page} />;
  }
}

export function SettingsView(props: SettingsActions & { onRefresh: () => void }) {
  const [page, setPage] = useState<SettingPage | null>(null);
  const descriptionId = useId();
  const settings = props.snapshot.settings;
  const rules = settings.downstreamModelRules || [];
  const summaries: Record<SettingPage, string> = {
    modelMapping: rules.length ? `${rules.length} 条规则 · ${rules.filter((rule) => rule.enabled).length} 条启用` : "尚未配置映射",
    retries: `${settings.upstreamRetryCodeCounts.some((item) => item.count > 0) ? `${settings.upstreamRetryCodeCounts.length} 个错误码` : "未启用重试"} · ${upstreamRetryDelaySummary(settings.upstreamRetryDelay)}`,
    requestTimeoutSeconds: `${settings.requestTimeoutSeconds} 秒`,
    maxRequestLogs: `最多 ${settings.maxRequestLogs.toLocaleString("zh-CN")} 条`,
    theme: themeOptions.find((theme) => theme.id === settings.themeId)?.name || "清泉",
    backup: "导出 / 导入",
    password: props.snapshot.security.adminPasswordCustomized ? "已设置自定义密码" : "使用启动密码",
    adminSessionTtlMinutes: `${settings.adminSessionTtlMinutes.toLocaleString("zh-CN")} 分钟`
  };

  return (
    <>
      <section className="panel settings-panel p-4">
        <div className="form-head">
          <div><h2>设置项目</h2><p className="settings-overview-description">选择一个项目，在独立弹窗中查看和修改。</p></div>
          <ActionButton type="button" tone="ghost" onClick={props.onRefresh} disabled={props.busy} aria-label="刷新数据" title="刷新数据"><RefreshCw className={`h-4 w-4 ${props.busy ? "animate-spin" : ""}`} aria-hidden="true" /><span className="settings-refresh-label">刷新数据</span></ActionButton>
        </div>
        <div className="settings-entry-list">
          {settingsEntries.map((entry) => <button key={entry.id} type="button" className="settings-entry"
            aria-label={entry.title} aria-haspopup="dialog" aria-describedby={`${descriptionId}-${entry.id}`} disabled={props.busy} onClick={() => setPage(entry.id)}>
            <span className="settings-entry-icon" aria-hidden="true"><entry.icon className="h-5 w-5" /></span>
            <span className="settings-entry-content"><strong>{entry.title}</strong><span id={`${descriptionId}-${entry.id}`} className="settings-entry-details"><span>{entry.description}</span><span className="settings-entry-value">{summaries[entry.id]}</span></span></span>
            <ChevronRight className="settings-entry-arrow h-4 w-4" aria-hidden="true" />
          </button>)}
        </div>
      </section>
      {page ? <SettingsDetailPage key={page} {...props} page={page} onClose={() => setPage(null)} /> : null}
    </>
  );
}
