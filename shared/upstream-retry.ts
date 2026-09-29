import type { UpstreamRetryDelay } from "./types.js";

export const MAX_UPSTREAM_RETRY_DELAY_SECONDS = 3600;
// Preserve the existing 1–3 second jitter when loading settings or backups without this field.
export const DEFAULT_UPSTREAM_RETRY_DELAY: UpstreamRetryDelay = { mode: "random", minSeconds: 1, maxSeconds: 3 };

function delaySeconds(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_UPSTREAM_RETRY_DELAY_SECONDS) {
    throw new Error(`${label}需要是 0-${MAX_UPSTREAM_RETRY_DELAY_SECONDS} 之间的秒数`);
  }
  if (Math.round(value * 1000) / 1000 !== value) throw new Error(`${label}最多支持 3 位小数（精确到毫秒）`);
  return value;
}

export function normalizeUpstreamRetryDelay(value?: unknown): UpstreamRetryDelay {
  if (value === undefined) return { ...DEFAULT_UPSTREAM_RETRY_DELAY };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请选择有效的重试时间规则");
  const input = value as Record<string, unknown>;
  switch (input.mode) {
    case "immediate": return { mode: "immediate" };
    case "fixed": return { mode: "fixed", seconds: delaySeconds(input.seconds, "重试间隔") };
    case "random": {
      const minSeconds = delaySeconds(input.minSeconds, "最短等待时间");
      const maxSeconds = delaySeconds(input.maxSeconds, "最长等待时间");
      if (minSeconds > maxSeconds) throw new Error("最短等待时间不能大于最长等待时间");
      return { mode: "random", minSeconds, maxSeconds };
    }
    default: throw new Error("请选择有效的重试时间规则");
  }
}

/** Draw once per actual retry, in whole milliseconds, with both bounds included. */
export function upstreamRetryDelayMs(delay: UpstreamRetryDelay = DEFAULT_UPSTREAM_RETRY_DELAY, random = Math.random): number {
  if (delay.mode === "immediate") return 0;
  if (delay.mode === "fixed") return Math.round(delay.seconds * 1000);
  const min = Math.round(delay.minSeconds * 1000);
  const max = Math.round(delay.maxSeconds * 1000);
  return min + Math.floor(random() * (max - min + 1));
}

export function upstreamRetryDelaySummary(delay: UpstreamRetryDelay = DEFAULT_UPSTREAM_RETRY_DELAY): string {
  if (delay.mode === "immediate") return "立即重试";
  if (delay.mode === "fixed") return `固定 ${delay.seconds} 秒`;
  return `随机 ${delay.minSeconds}-${delay.maxSeconds} 秒`;
}
