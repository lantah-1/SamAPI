import { Save, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ActionButton } from "../ui";

interface SettingsDialogProps {
  title: string;
  description: string;
  wide?: boolean;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function SettingsDialog(props: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const backdropPointerDown = useRef(false);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const viewport = window.visualViewport;
    // Keep the sheet and its actions inside the visible area when a phone keyboard opens.
    // Leave pinch zoom to the browser instead of resizing the form while the user zooms.
    const updateViewport = () => {
      if (viewport && Math.abs(viewport.scale - 1) > 0.05) return;
      const height = viewport?.height ?? window.innerHeight;
      const top = viewport?.offsetTop ?? 0;
      dialog.style.setProperty("--settings-viewport-height", `${height}px`);
      dialog.style.setProperty("--settings-viewport-top", `${top}px`);
      dialog.style.setProperty("--settings-viewport-bottom", `${Math.max(0, window.innerHeight - height - top)}px`);
      dialog.toggleAttribute("data-compact-viewport", height <= 480);
    };
    updateViewport();
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);
    dialog.showModal();
    headingRef.current?.focus();
    return () => {
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
      dialog.close();
      queueMicrotask(() => { if (previousFocus?.isConnected) previousFocus.focus(); });
    };
  }, []);

  const outsideDialog = (event: React.MouseEvent<HTMLDialogElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
  };

  return (
    <dialog
      ref={dialogRef}
      className={`settings-detail-dialog ${props.wide ? "settings-detail-dialog-wide" : ""}`}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={props.busy}
      onCancel={(event) => { event.preventDefault(); if (!props.busy) props.onClose(); }}
      onMouseDown={(event) => { backdropPointerDown.current = outsideDialog(event); }}
      onClick={(event) => { if (backdropPointerDown.current && outsideDialog(event) && !props.busy) props.onClose(); }}
    >
      <header className="settings-dialog-head">
        <div className="min-w-0">
          <p className="settings-dialog-parent">系统设置</p>
          <h2 id={titleId} ref={headingRef} tabIndex={-1}>{props.title}</h2>
          <p id={descriptionId} className="settings-dialog-description">{props.description}</p>
        </div>
        <ActionButton type="button" tone="ghost" className="settings-dialog-close" disabled={props.busy} aria-label={`关闭${props.title}`} title="返回设置" onClick={props.onClose}><X className="h-4 w-4" aria-hidden="true" /></ActionButton>
      </header>
      {props.children}
    </dialog>
  );
}

export function SettingsDialogFooter(props: { note: string; error?: string; children: ReactNode }) {
  return (
    <footer className="settings-dialog-footer">
      {props.error ? <div className="auth-error settings-dialog-error" role="alert">{props.error}</div> : null}
      <p className="settings-dialog-note">{props.note}</p>
      <div className="settings-dialog-actions">{props.children}</div>
    </footer>
  );
}

export function SettingsFormDialog(props: SettingsDialogProps & {
  onSubmit: () => Promise<void>;
  saveLabel?: string;
  note?: string;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const busy = props.busy || saving;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || pending.current) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      await props.onSubmit();
      props.onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  return (
    <SettingsDialog {...props} busy={busy}>
      <form className="settings-dialog-form" onSubmit={(event) => void submit(event)}>
        <div className="settings-dialog-body"><fieldset disabled={busy}>{props.children}</fieldset></div>
        <SettingsDialogFooter error={error} note={props.note || "仅保存当前设置项，取消不会保存修改。"}>
          <ActionButton type="button" tone="ghost" disabled={busy} onClick={props.onClose}>取消</ActionButton>
          <ActionButton type="submit" disabled={busy}><Save className="h-4 w-4" aria-hidden="true" />{busy ? "正在保存..." : props.saveLabel || "保存设置"}</ActionButton>
        </SettingsDialogFooter>
      </form>
    </SettingsDialog>
  );
}
