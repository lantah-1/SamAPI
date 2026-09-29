import type { AppBackup, AppBackupImportResult, AppSettings, AppSnapshot } from "../../../shared/types";

export interface SettingsActions {
  snapshot: AppSnapshot;
  busy: boolean;
  onSave: (settings: Partial<AppSettings>) => Promise<void>;
  onPasswordChange: (currentPassword: string, nextPassword: string) => Promise<void>;
  onExportBackup: () => Promise<AppBackup>;
  onImportBackup: (backup: AppBackup) => Promise<AppBackupImportResult>;
}

export interface SettingsPageProps extends SettingsActions {
  onClose: () => void;
}
