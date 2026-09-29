import { RefreshCw, Upload, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { TemporaryAccountImportMode, TemporaryAccountProviderType } from "../../shared/types";
import type { TemporaryAccountImportDraft } from "../app/types";
import { ActionButton, SelectInput, TextInput } from "./ui";

const TEMPORARY_IMPORT_FILE_LIMIT = 500;
const TEMPORARY_IMPORT_TEXT_LIMIT = 20 * 1024 * 1024;
const TEMPORARY_IMPORT_ARCHIVE_LIMIT = 25 * 1024 * 1024;
const TEMPORARY_IMPORT_TEXT_FILE = /\.(?:json|jsonl|txt|csv)$/i;

const temporaryImportModeHints: Record<TemporaryAccountImportMode, string> = {
  auto: "逐个文件识别；支持 OAuth、API Key，以及含 agent_runtime_id + base64 PKCS8 Ed25519 agent_private_key 的 OpenAI Agent Identity。",
  subapi: "按 Sub2API 来源导入，支持 tokenless OpenAI Agent Identity（严格校验 PKCS8 Ed25519 私钥）。",
  "sub2api-k12": "导入 Sub2API 导出的 ChatGPT K12 OAuth 账号列表 JSON。",
  cpa: "按 CPA 来源导入，同时兼容常见账号字段。",
  "auth-json": "适合直接导入 Codex 或 Grok 的 auth.json。",
  zip: "解压后逐文件自动识别，支持 Sub2API、CPA 和 auth.json 混合包。"
};

function temporaryImportModeHint(providerType: TemporaryAccountProviderType, mode: TemporaryAccountImportMode) {
  if (providerType !== "grok") return temporaryImportModeHints[mode];
  if (mode === "cpa") return "仅导入 CLIProxyAPI / CPA 格式的单账号 xAI OAuth JSON。";
  if (mode === "subapi") return "仅导入 grok2api 格式的单账号 Grok Build OAuth JSON。";
  if (mode === "zip") return "ZIP 内可混合 CPA 与 grok2api OAuth JSON，每个 JSON 只包含一个账号。";
  return "自动识别 CPA 或 grok2api 的单账号 OAuth JSON。";
}

function isTemporaryImportZip(file: File) {
  return file.name.toLowerCase().endsWith(".zip") || ["application/zip", "application/x-zip-compressed"].includes(file.type);
}

export function AccountImportDialog(props: {
  draft: TemporaryAccountImportDraft;
  editorOpen: boolean;
  busy: boolean;
  onDraft: (value: TemporaryAccountImportDraft) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
}) {
  const hasImportContent = props.draft.content.trim() || props.draft.contents.some((content) => content.trim());
  const [importFileError, setImportFileError] = useState("");
  useEffect(() => {
    if (props.editorOpen) setImportFileError("");
  }, [props.editorOpen]);
  const readImportFiles = async (files?: FileList | null) => {
    const selectedFiles = Array.from(files || []);
    if (selectedFiles.length === 0) return;
    setImportFileError("");
    try {
      const contents: string[] = [];
      const fileNames: string[] = [];
      let totalTextSize = 0;
      const appendContent = (name: string, content: string) => {
        if (!content.trim()) return;
        totalTextSize += content.length;
        if (totalTextSize > TEMPORARY_IMPORT_TEXT_LIMIT) throw new Error("解压后的账号数据不能超过 20 MB");
        if (contents.length >= TEMPORARY_IMPORT_FILE_LIMIT) throw new Error(`单次最多导入 ${TEMPORARY_IMPORT_FILE_LIMIT} 个文件`);
        contents.push(content);
        fileNames.push(name);
      };

      for (const file of selectedFiles) {
        const zipFile = isTemporaryImportZip(file);
        if (props.draft.mode === "zip" && !zipFile) throw new Error("ZIP 包模式只能选择 .zip 文件");
        if (!["auto", "zip"].includes(props.draft.mode) && zipFile) throw new Error("请切换到“自动识别”或“ZIP 混合包”后再选择 ZIP 文件");
        if (!zipFile) {
          appendContent(file.name, await file.text());
          continue;
        }
        if (file.size > TEMPORARY_IMPORT_ARCHIVE_LIMIT) throw new Error(`${file.name} 超过 25 MB`);
        const { default: JSZip } = await import("jszip");
        const archive = await JSZip.loadAsync(file);
        const entries = Object.values(archive.files).filter(
          (entry) => !entry.dir && !entry.name.startsWith("__MACOSX/") && TEMPORARY_IMPORT_TEXT_FILE.test(entry.name)
        );
        if (entries.length === 0) throw new Error(`${file.name} 中没有可导入的 JSON、JSONL、TXT 或 CSV 文件`);
        for (const entry of entries) appendContent(`${file.name} / ${entry.name}`, await entry.async("string"));
      }

      if (contents.length === 0) throw new Error("所选文件中没有可导入的账号数据");
      props.onDraft({
        ...props.draft,
        contents,
        fileNames,
        name: props.draft.name || selectedFiles[0]?.name.replace(/\.[^.]+$/, "") || ""
      });
    } catch (error) {
      setImportFileError(error instanceof Error ? error.message : "读取导入文件失败");
      props.onDraft({ ...props.draft, contents: [], fileNames: [] });
    }
  };
  return (
    <>
      {props.editorOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form onSubmit={props.onSubmit} className="modal-panel temp-account-modal" role="dialog" aria-modal="true" aria-label="账号导入">
            <div className="form-head">
              <div>
                <h2>{props.draft.providerType === "gpt" ? "导入 GPT 账号" : "导入 Grok 账号"}</h2>
                <div className="mt-1 text-xs font-bold text-ink/55">导入当前平台的账号，文件格式可自动识别</div>
              </div>
              <ActionButton type="button" tone="ghost" onClick={props.onClose} title="关闭">
                <X className="h-4 w-4" />
              </ActionButton>
            </div>
            <div className="form-grid">
              <label>
                账号平台
                <TextInput readOnly value={props.draft.providerType === "gpt" ? "GPT" : "Grok"} />
              </label>
              <label>
                导入方式
                <SelectInput value={props.draft.mode} onChange={(event) => {
                  const mode = event.target.value as TemporaryAccountImportMode;
                  setImportFileError("");
                  props.onDraft({
                    ...props.draft,
                    mode,
                    source: mode === "cpa" ? "cpa" : "subapi",
                    content: mode === "zip" ? "" : props.draft.content,
                    contents: [],
                    fileNames: []
                  });
                }}>
                  <option value="auto">自动识别（推荐）</option>
                  <option value="subapi">{props.draft.providerType === "grok" ? "grok2api OAuth JSON" : "Sub2API"}</option>
                  {props.draft.providerType === "gpt" ? <option value="sub2api-k12">Sub2API K12 JSON</option> : null}
                  <option value="cpa">{props.draft.providerType === "grok" ? "CPA OAuth JSON" : "CPA"}</option>
                  {props.draft.providerType === "gpt" ? <option value="auth-json">纯 auth.json</option> : null}
                  <option value="zip">ZIP 混合包</option>
                </SelectInput>
                <span className="field-hint">{temporaryImportModeHint(props.draft.providerType, props.draft.mode)}</span>
              </label>
              <label className="form-span-2">
                导入文件
                <input
                  className="field"
                  type="file"
                  accept={props.draft.mode === "zip" ? ".zip,application/zip" : props.draft.mode === "auto" ? ".json,.jsonl,.txt,.csv,.zip,application/zip" : ".json,.jsonl,.txt,.csv"}
                  multiple
                  onChange={(event) => void readImportFiles(event.target.files)}
                />
                {props.draft.fileNames.length > 0 ? (
                  <span className="field-hint">
                    已读取 {props.draft.fileNames.length} 个数据文件：{props.draft.fileNames.slice(0, 3).join("，")}{props.draft.fileNames.length > 3 ? ` 等 ${props.draft.fileNames.length} 个` : ""}
                  </span>
                ) : null}
                {importFileError ? <span className="temp-account-import-error" role="alert">{importFileError}</span> : null}
              </label>
              {props.draft.mode === "zip" ? (
                <div className="temp-account-import-note form-span-2">
                  {props.draft.providerType === "grok"
                    ? "ZIP 内可混合 CPA 与 grok2api OAuth JSON；暂不支持 SSO JSON 和 accounts 账号列表。"
                    : "ZIP 内可以包含多条 Sub2API、CPA、auth.json，也可以混合；目录和不支持的文件会自动忽略。"}
                </div>
              ) : (
                <label className="form-span-2">
                  账号数据
                  <textarea
                    className="field temp-account-textarea"
                    value={props.draft.content}
                    placeholder={props.draft.providerType === "grok"
                      ? "粘贴单账号 CPA 或 grok2api OAuth JSON；不支持 SSO、Cookie、纯 token 或 accounts 列表"
                      : props.draft.mode === "sub2api-k12"
                        ? "粘贴 type 为 sub2api-data、accounts 中包含 OpenAI K12 OAuth 账号的 JSON"
                        : "也可以直接粘贴 JSON、JSONL、Cookie、token 或账号字段"}
                    onChange={(event) => props.onDraft({ ...props.draft, content: event.target.value })}
                  />
                </label>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <ActionButton type="button" tone="ghost" onClick={props.onClose}>
                取消
              </ActionButton>
              <ActionButton type="submit" disabled={props.busy || !hasImportContent}>
                {props.busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {props.busy ? "正在导入..." : "导入账号"}
              </ActionButton>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
