import type {
  AppSnapshot,
  EndpointKind,
  GroupRouteMember,
  GroupRouteStrategy,
  HeaderTemplate,
  ProviderApiKeyKind,
  ProviderModelManageMode,
  RouteProxyConfig,
  RouteType,
  TemporaryAccountImportSource,
  TemporaryAccountImportMode,
  TemporaryAccountProviderType
} from "../../shared/types";

export type Section = "routes" | "sites" | "providerKeys" | "models" | "temporaryAccounts" | "keys" | "headers" | "logs" | "settings" | "docs";
export type AuthStatus = "checking" | "signed-out" | "signed-in";

export interface RouteDraft {
  id?: string;
  name?: string;
  type?: RouteType;
  siteId?: string;
  addressId?: string;
  model?: string;
  modelGroupId?: string;
  matchRule?: string;
  members?: GroupRouteMember[];
  strategy?: GroupRouteStrategy;
  endpoint?: EndpointKind;
  headerTemplateId?: string;
  proxy?: RouteProxyConfig;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProviderApiKeyDraft {
  id?: string;
  label: string;
  secret: string;
  kind?: ProviderApiKeyKind;
  enabled: boolean;
  models: string[];
  lastCheckedAt?: string;
}

export interface ProviderKeyGroupDraft {
  id?: string;
  siteId: string;
  groupName: string;
  modelManageMode?: ProviderModelManageMode;
  apiKeys: ProviderApiKeyDraft[];
}

export interface TemporaryAccountImportDraft {
  name: string;
  providerType: TemporaryAccountProviderType;
  source: TemporaryAccountImportSource;
  mode: TemporaryAccountImportMode;
  modelsText: string;
  content: string;
  contents: string[];
  fileNames: string[];
}

export interface HeaderKeyValue {
  key: string;
  value: string;
}

export interface HeaderTemplateDraft extends Partial<HeaderTemplate> {
  headerRows: HeaderKeyValue[];
}

export interface ProviderModelOption {
  siteId: string;
  siteName: string;
  apiKeyId: string;
  apiKeyLabel: string;
  model: string;
  enabled: boolean;
}

export type SnapshotLoader = (options?: { includeRequestLogs?: boolean; includeTemporaryAccounts?: boolean }) => Promise<void>;
export type SnapshotState = AppSnapshot | null;
