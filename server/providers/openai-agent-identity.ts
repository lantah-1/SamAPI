import { createHash, createPrivateKey, sign } from "node:crypto";
import sodium from "libsodium-wrappers";
import type { RouteProxyConfig, TemporaryAccount } from "../../shared/types.js";
import { fetchWithRouteProxy } from "../proxy.js";
import { isRecord } from "../util/text.js";

const AGENT_AUTH_BASE_URL = "https://auth.openai.com/api/accounts";
const taskLocks = new Map<string, Promise<void>>();

type AgentIdentityAccount = TemporaryAccount;
type TaskRegistrationResponse = { task_id?: unknown; taskId?: unknown; encrypted_task_id?: unknown; encryptedTaskId?: unknown };

function nonEmpty(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Validate the only supported import form: base64 encoded PKCS#8 Ed25519. */
export function validateOpenAiAgentIdentityPrivateKey(encoded: string) {
  const value = encoded.trim();
  if (!value) throw new Error("Agent Identity private key is required");
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey({ key: Buffer.from(value, "base64"), format: "der", type: "pkcs8" });
  } catch {
    throw new Error("Agent Identity private key must be base64-encoded PKCS#8 Ed25519");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Agent Identity private key must be Ed25519");
}

function keyObject(account: AgentIdentityAccount) {
  const encoded = nonEmpty(account.agentPrivateKey);
  if (!encoded) throw new Error("Agent Identity private key is missing");
  validateOpenAiAgentIdentityPrivateKey(encoded);
  return createPrivateKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "pkcs8" });
}

function timestamp() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }
function signature(key: ReturnType<typeof keyObject>, payload: string) { return sign(null, Buffer.from(payload), key).toString("base64"); }

export function isOpenAiAgentIdentityAccount(account: Pick<TemporaryAccount, "agentRuntimeId" | "agentPrivateKey">) {
  return Boolean(nonEmpty(account.agentRuntimeId) && nonEmpty(account.agentPrivateKey));
}

export function agentIdentityAuthorization(account: AgentIdentityAccount) {
  const runtimeId = nonEmpty(account.agentRuntimeId);
  const taskId = nonEmpty(account.agentTaskId);
  if (!runtimeId || !taskId) throw new Error("Agent Identity runtime ID or task ID is missing");
  const signedAt = timestamp();
  const envelope = {
    agent_runtime_id: runtimeId,
    task_id: taskId,
    timestamp: signedAt,
    signature: signature(keyObject(account), `${runtimeId}:${taskId}:${signedAt}`)
  };
  return `AgentAssertion ${Buffer.from(JSON.stringify(envelope)).toString("base64url")}`;
}

export async function decryptOpenAiAgentIdentityTaskId(account: AgentIdentityAccount, encoded: string) {
  let cipher: Uint8Array;
  try { cipher = new Uint8Array(Buffer.from(encoded, "base64")); } catch { throw new Error("encrypted Agent Identity task ID is not valid base64"); }
  if (cipher.length <= 32) throw new Error("encrypted Agent Identity task ID is invalid");
  // OpenAI's sealed-box format: ephemeral X25519 public key + nacl.box payload.
  const jwk = keyObject(account).export({ format: "jwk" }) as { d?: string };
  if (!jwk.d) throw new Error("unable to read Agent Identity private key seed");
  const seed = Buffer.from(jwk.d, "base64url");
  if (seed.length !== 32) throw new Error("Agent Identity private key seed is invalid");
  const scalar = new Uint8Array(createHash("sha512").update(seed).digest().subarray(0, 32));
  scalar[0] &= 248; scalar[31] &= 127; scalar[31] |= 64;
  await sodium.ready;
  const publicKey = sodium.crypto_scalarmult_base(scalar);
  const plain = sodium.crypto_box_seal_open(cipher, publicKey, scalar);
  const taskId = plain && Buffer.from(plain).toString("utf8").trim();
  if (!taskId) throw new Error("unable to decrypt Agent Identity task ID");
  return taskId;
}

async function registerTask(account: AgentIdentityAccount, proxy?: RouteProxyConfig) {
  const runtimeId = nonEmpty(account.agentRuntimeId);
  if (!runtimeId) throw new Error("Agent Identity runtime ID is missing");
  const signedAt = timestamp();
  const { response } = await fetchWithRouteProxy(`${AGENT_AUTH_BASE_URL}/v1/agent/${encodeURIComponent(runtimeId)}/task/register`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ timestamp: signedAt, signature: signature(keyObject(account), `${runtimeId}:${signedAt}`) })
  }, proxy, 30_000);
  const text = await response.text();
  if (!response.ok) throw new Error(`Agent Identity task registration failed (HTTP ${response.status})`);
  let payload: TaskRegistrationResponse;
  try { payload = JSON.parse(text) as TaskRegistrationResponse; } catch { throw new Error("Agent Identity task registration response is invalid"); }
  const taskId = nonEmpty(payload.task_id) || nonEmpty(payload.taskId);
  if (taskId) return taskId;
  const encrypted = nonEmpty(payload.encrypted_task_id) || nonEmpty(payload.encryptedTaskId);
  if (!encrypted) throw new Error("Agent Identity task registration response omitted task ID");
  return decryptOpenAiAgentIdentityTaskId(account, encrypted);
}

/** Serializes registration per account and rechecks persisted state inside that lock. */
export async function ensureOpenAiAgentIdentityTask(input: {
  account: AgentIdentityAccount;
  proxy?: RouteProxyConfig;
  expectedTaskId?: string;
  getCurrent: () => AgentIdentityAccount | undefined;
  persist: (taskId: string) => void;
}) {
  const lockKey = input.account.id;
  const previous = taskLocks.get(lockKey) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  taskLocks.set(lockKey, tail);
  await previous;
  try {
    const account = input.getCurrent() || input.account;
    const existing = nonEmpty(account.agentTaskId);
    if (existing && (!input.expectedTaskId || existing !== input.expectedTaskId)) return account;
    const taskId = await registerTask(account, input.proxy);
    input.persist(taskId);
    return { ...account, agentTaskId: taskId };
  } finally {
    release();
    if (taskLocks.get(lockKey) === tail) taskLocks.delete(lockKey);
  }
}

export function isOpenAiAgentIdentityTaskInvalid(status: number, body: string) {
  if (status !== 401) return false;
  const lower = body.toLowerCase();
  return ["invalid_task_id", "task_not_found", "task_expired", "invalid task id", "invalid task_id", "task id is invalid", "task not found", "task expired", "unknown task"].some((marker) => lower.includes(marker));
}

/** Redacts assertion and identity fields before upstream errors enter logs. */
export function redactOpenAiAgentIdentityText(value: string, account?: AgentIdentityAccount) {
  let result = value.replace(/AgentAssertion\s+[^\s"',}]+/g, "AgentAssertion [redacted]");
  for (const secret of [account?.agentPrivateKey, account?.agentRuntimeId, account?.agentTaskId]) {
    if (secret) result = result.split(secret).join("[redacted]");
  }
  return result;
}
