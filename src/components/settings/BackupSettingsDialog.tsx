import { AlertTriangle, Database, Download, ShieldCheck, Upload } from "lucide-react";
import { useRef, useState } from "react";
import type { AppBackup } from "../../../shared/types";
import { ActionButton } from "../ui";
import { SettingsDialog, SettingsDialogFooter } from "./SettingsDialog";
import type { SettingsPageProps } from "./types";

export function parseSettingsBackup(text: string): AppBackup {
  const parsed = JSON.parse(text) as Partial<AppBackup> | null;
  if (parsed?.format !== "samapi-backup" || parsed.version !== 1 || !parsed.data) throw new Error("请选择由 SamAPI 导出的有效备份文件");
  const data = parsed.data;
  if (!Array.isArray(data.sites) || !Array.isArray(data.apiKeys) || !Array.isArray(data.providerApiKeyGroups)
    || !Array.isArray(data.temporaryAccountGroups) || !Array.isArray(data.headerTemplates)
    || !Array.isArray(data.routes) || !Array.isArray(data.routeDisplayGroups)
    || !data.temporaryAccountGroups.every((group) => group && Array.isArray(group.accounts))) {
    throw new Error("备份文件结构不完整或已损坏");
  }
  return parsed as AppBackup;
}

export function BackupSettingsDialog(props: SettingsPageProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [pending, setPending] = useState<AppBackup | null>(null);
  const busy = props.busy || working;
  const exportBackup = async () => {
    if (busy) return;
    setError(""); setWorking(true);
    try {
      const backup = await props.onExportBackup();
      const date = backup.exportedAt.slice(0, 10) || new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url; link.download = `samapi-backup-${date}.json`;
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    } catch (error) { setError(error instanceof Error ? error.message : "导出备份失败"); }
    finally { setWorking(false); }
  };
  const chooseFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || busy) return;
    setError(""); setWorking(true);
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("备份文件不能超过 20 MB");
      setPending(parseSettingsBackup(await file.text()));
    } catch (error) { setError(error instanceof Error ? error.message : "读取备份文件失败"); }
    finally { setWorking(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const cancelImport = () => { setPending(null); setError(""); };
  const importBackup = async () => {
    if (!pending || busy) return;
    setError(""); setWorking(true);
    try { await props.onImportBackup(pending); setPending(null); }
    catch (error) { setError(error instanceof Error ? error.message : "导入备份失败"); }
    finally { setWorking(false); }
  };

  return (
    <SettingsDialog title={pending ? "确认导入备份" : "数据备份"} description="导出或恢复业务配置。请求日志与管理员密码不会被导出，也不会在导入时被覆盖。"
      busy={busy} onClose={pending ? cancelImport : props.onClose}>
      <div className="settings-dialog-body">
        {pending ? <div className="settings-backup-confirmation">
          <div className="settings-import-symbol" aria-hidden="true"><AlertTriangle className="h-6 w-6" /></div>
          <h3>确认覆盖现有配置？</h3>
          <p className="settings-import-description">导入会用备份中的业务配置替换当前配置，此操作无法在页面中撤销。当前请求日志和管理员密码将保留。</p>
          <div className="settings-import-summary">
            <span><strong>{pending.data.sites.length}</strong> 个站点</span>
            <span><strong>{pending.data.routes.length}</strong> 条路由</span>
            <span><strong>{pending.data.providerApiKeyGroups.length}</strong> 个上游密钥分组</span>
            <span><strong>{pending.data.temporaryAccountGroups.reduce((total, group) => total + group.accounts.length, 0)}</strong> 个供应商账号</span>
          </div>
          <p className="settings-import-meta">备份时间：{new Date(pending.exportedAt).toLocaleString("zh-CN")}</p>
        </div> : <div className="settings-backup-box">
          <div className="settings-backup-icon" aria-hidden="true"><Database className="h-5 w-5" /></div>
          <div className="settings-backup-copy"><strong>完整配置备份</strong><span>包含站点、路由、上下游密钥、供应商账号、请求头模板和系统设置。</span></div>
          <span className="settings-backup-warning"><ShieldCheck className="h-4 w-4" />文件包含明文凭据，请存放在安全位置。</span>
          <div className="settings-backup-actions">
            <ActionButton type="button" tone="ghost" disabled={busy} onClick={() => void exportBackup()}><Download className="h-4 w-4" />导出备份</ActionButton>
            <ActionButton type="button" tone="ghost" disabled={busy} onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4" />导入备份</ActionButton>
            <input ref={fileRef} className="settings-backup-file" type="file" accept=".json,application/json" aria-label="选择备份文件" disabled={busy} onChange={(event) => void chooseFile(event.target.files)} />
          </div>
        </div>}
      </div>
      <SettingsDialogFooter error={error} note={pending ? "确认前不会修改当前配置。" : busy ? "正在处理备份..." : "备份操作独立执行，无需保存设置。"}>
        <ActionButton type="button" tone="ghost" disabled={busy} onClick={pending ? cancelImport : props.onClose}>{pending ? "取消导入" : "返回设置"}</ActionButton>
        {pending ? <ActionButton type="button" tone="danger" disabled={busy} onClick={() => void importBackup()}><Upload className="h-4 w-4" />{busy ? "正在导入..." : "确认导入并覆盖"}</ActionButton> : null}
      </SettingsDialogFooter>
    </SettingsDialog>
  );
}
