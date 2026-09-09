import { accountProviders, type AccountProvider, type ManagedAccount } from "../shared/accounts.js";
import type { TemporaryAccount, TemporaryAccountGroup } from "../shared/types.js";

export function accountProvider(value: unknown): AccountProvider {
  if (typeof value === "string" && Object.hasOwn(accountProviders, value)) return value as AccountProvider;
  throw new Error("不支持的账号供应商");
}

export function redactAccountError(message: string | undefined, account: TemporaryAccount) {
  if (!message) return undefined;
  let result = message;
  for (const value of [account.secret, account.refreshToken, account.idToken, account.sessionToken, account.agentPrivateKey]) {
    if (value) result = result.split(value).join("***");
  }
  return result.slice(0, 1000);
}

export function managedAccountView(account: TemporaryAccount, group: TemporaryAccountGroup): ManagedAccount {
  const provider = accountProvider(group.providerType || "gpt");
  return {
    id: account.id, provider, label: account.label, email: account.email, accountId: account.accountId,
    kind: account.agentRuntimeId ? "agent-identity" : provider === "gpt" && (account.accountType === "codex" || Boolean(account.accountId)) ? "oauth" : "api-key",
    credentialPreview: account.secret.length > 12 ? `${account.secret.slice(0, 6)}…${account.secret.slice(-4)}` : account.secret ? "••••••••" : "授权凭据已保存",
    enabled: account.enabled !== false && group.enabled !== false,
    availability: account.availability || "unknown", preferred: group.preferredAccountId === account.id,
    models: [...account.models], quotaStages: structuredClone(account.quotaStages), createdAt: account.importedAt,
    lastCheckedAt: account.lastQuotaCheckedAt, lastCheckStatusCode: account.lastCheckStatusCode,
    lastCheckError: redactAccountError(account.lastCheckError, account), expiresAt: account.tokenExpiresAt
  };
}

/** Legacy management clients only need display fields, never live OAuth credentials. */
export function temporaryAccountView(account: TemporaryAccount): TemporaryAccount {
  const { secret: _secret, refreshToken: _refresh, idToken: _id, sessionToken: _session, agentPrivateKey: _private, agentTaskId: _task, ...view } = account;
  const prefix = account.secret.length > 12 ? `${account.secret.slice(0, 6)}…${account.secret.slice(-4)}` : account.secret ? "••••••••" : account.prefix;
  return { ...view, prefix, secret: "", lastCheckError: redactAccountError(account.lastCheckError, account) };
}

export function temporaryAccountGroupView(group: TemporaryAccountGroup): TemporaryAccountGroup {
  return { ...group, accounts: group.accounts.map(temporaryAccountView) };
}
