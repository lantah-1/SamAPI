import type { EndpointKind, GroupRouteStrategy, TemporaryAccountAvailability, TemporaryAccountQuotaStage } from "./types.js";

export type AccountProvider = "gpt" | "claude" | "deepseek" | "gemini";

export const accountProviders: Record<AccountProvider, { label: string; baseUrl: string; endpoint: EndpointKind; credentialHint: string }> = {
  gpt: { label: "GPT", baseUrl: "https://api.openai.com/v1", endpoint: "chat/completions", credentialHint: "登录 ChatGPT，或使用 OpenAI API Key" },
  claude: { label: "Claude", baseUrl: "https://api.anthropic.com/v1", endpoint: "messages", credentialHint: "使用 Anthropic Console 的 API Key" },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", endpoint: "chat/completions", credentialHint: "使用 DeepSeek 开放平台的 API Key" },
  gemini: { label: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", endpoint: "chat/completions", credentialHint: "使用 Google AI Studio 的 API Key" }
};

export interface ManagedAccount {
  id: string;
  provider: AccountProvider;
  label: string;
  email?: string;
  accountId?: string;
  kind: "oauth" | "api-key" | "agent-identity";
  credentialPreview: string;
  enabled: boolean;
  availability: TemporaryAccountAvailability;
  preferred: boolean;
  models: string[];
  quotaStages: TemporaryAccountQuotaStage[];
  createdAt: string;
  lastCheckedAt?: string;
  lastCheckStatusCode?: number;
  lastCheckError?: string;
  expiresAt?: string;
}

export interface ManagedAccountProviderState {
  provider: AccountProvider;
  siteId?: string;
  strategy: GroupRouteStrategy;
  preferredAccountId?: string;
  models: string[];
  accounts: ManagedAccount[];
}

export interface ManagedAccountsSnapshot { providers: ManagedAccountProviderState[] }

export interface ManagedAccountInput {
  provider: AccountProvider;
  label: string;
  secret: string;
  models?: string[];
}

export interface ManagedAccountPatch {
  label?: string;
  secret?: string;
  enabled?: boolean;
  models?: string[];
}
