import type http from "node:http";
import type { ProviderModelSyncResult } from "../shared/types.js";

const MORNING_HOUR = 8;
const RANDOM_OFFSET_MAX_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export function createScheduledRequest(): http.IncomingMessage {
  return {
    method: "POST",
    headers: {
      "user-agent": "samapi-model-sync-scheduler"
    },
    socket: {
      remoteAddress: "127.0.0.1"
    }
  } as http.IncomingMessage;
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function nextMorningSyncAt(from = new Date(), randomOffsetMs = Math.floor(Math.random() * (RANDOM_OFFSET_MAX_MS + 1))) {
  const base = startOfLocalDay(from);
  base.setHours(MORNING_HOUR, 0, 0, 0);
  base.setTime(base.getTime() + randomOffsetMs);
  if (base.getTime() <= from.getTime()) {
    base.setDate(base.getDate() + 1);
  }
  return base;
}

export function startProviderModelSyncScheduler(options: {
  syncAllProviderModels: (request: http.IncomingMessage, opts?: { mode?: "auto" | "manual" | "all"; groupIds?: string[] }) => Promise<ProviderModelSyncResult>;
}) {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;

  const run = async () => {
    if (running) {
      console.log("[model-sync] previous auto sync still running, skip this tick");
      return;
    }
    running = true;
    const startedAt = Date.now();
    try {
      const result = await options.syncAllProviderModels(createScheduledRequest(), { mode: "auto" });
      console.log(
        `[model-sync] auto sync finished in ${Date.now() - startedAt}ms: total=${result.total} success=${result.success} failed=${result.failed}`
      );
    } catch (error) {
      console.error("[model-sync] auto sync failed:", error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };

  const scheduleNext = () => {
    if (stopped) return;
    const randomOffsetMs = Math.floor(Math.random() * (RANDOM_OFFSET_MAX_MS + 1));
    const nextAt = nextMorningSyncAt(new Date(), randomOffsetMs);
    const delay = Math.max(1_000, nextAt.getTime() - Date.now());
    console.log(`[model-sync] next auto sync scheduled at ${nextAt.toLocaleString()} (offset ${Math.round(randomOffsetMs / 1000)}s)`);
    const arm = (remaining: number) => {
      if (stopped) return;
      if (remaining > MAX_TIMEOUT_MS) {
        timer = setTimeout(() => arm(remaining - MAX_TIMEOUT_MS), MAX_TIMEOUT_MS);
        return;
      }
      timer = setTimeout(async () => {
        await run();
        scheduleNext();
      }, remaining);
    };
    arm(delay);
  };

  scheduleNext();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    runNow: run
  };
}
