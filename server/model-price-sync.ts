import type { ModelPriceSyncReport, ModelPriceSyncState } from "../shared/usage.js";
import type { JsonStore } from "./store.js";
import { fetchWithRouteProxy } from "./proxy.js";
import { officialPriceSources, type FetchPriceText, type PriceSource } from "./pricing-sources.js";

const RETRY_MS = 60 * 60 * 1000;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

/** 08:00 Asia/Shanghai, independent of the server's local time zone. */
export function nextModelPriceSyncAt(from: Date): Date {
  const next = new Date(from);
  next.setUTCHours(0, 0, 0, 0);
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

export async function fetchOfficialPriceText(url: string): Promise<string> {
  const { response } = await fetchWithRouteProxy(url, {
    headers: { Accept: "text/html, text/plain, application/json", "Cache-Control": "no-cache", "User-Agent": "samapi-price-sync/1.0" },
    signal: AbortSignal.timeout(30000)
  }, { mode: "system" }, 30000);
  if (!response.ok) { await response.body?.cancel(); throw new Error(`官方价格查询失败（HTTP ${response.status}）`); }
  if (!response.body) throw new Error("官方价格页面为空");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SOURCE_BYTES) { await reader.cancel(); throw new Error("官方价格页面超出大小限制"); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

export function createModelPriceSync(store: Pick<JsonStore, "modelPriceSyncStates" | "saveModelPriceSyncState" | "saveOfficialModelPrices">, options: {
  sources?: PriceSource[];
  fetchText?: FetchPriceText;
  now?: () => Date;
} = {}) {
  const sources = options.sources || officialPriceSources;
  const fetchText = options.fetchText || fetchOfficialPriceText;
  const now = options.now || (() => new Date());
  let current: Promise<ModelPriceSyncReport> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = true;
  const needsParserRefresh = (source: PriceSource, state: ModelPriceSyncState) => (source.parserVersion || 0) > (state.parserVersion || 0);

  const status = (): ModelPriceSyncReport => {
    const saved = new Map(store.modelPriceSyncStates().map((state) => [state.id, state]));
    return { running: Boolean(current), sources: sources.map(({ id, name, url }) => saved.get(id) || { id, name, url, status: "pending", modelCount: 0 }) };
  };

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    const times = status().sources.map((state, index) => !needsParserRefresh(sources[index], state) && Number.isFinite(Date.parse(state.nextSyncAt || "")) ? Date.parse(state.nextSyncAt!) : now().getTime());
    const due = Math.min(...times);
    timer = setTimeout(() => { void sync(false).catch((error) => console.error("[model-prices] sync failed:", error instanceof Error ? error.message : "unknown error")); }, Math.max(1000, Math.min(86400000, due - now().getTime())));
    timer.unref();
  };

  const sync = (force = true): Promise<ModelPriceSyncReport> => {
    if (current) return current;
    current = (async () => {
      const states = new Map(status().sources.map((state) => [state.id, state]));
      const due = sources.filter((source) => {
        const next = Date.parse(states.get(source.id)?.nextSyncAt || "");
        return force || needsParserRefresh(source, states.get(source.id)!) || !Number.isFinite(next) || next <= now().getTime();
      });
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(3, due.length) }, async () => {
        while (cursor < due.length) {
          const source = due[cursor++];
          const previous = states.get(source.id)!;
          const attemptedAt = now().toISOString();
          try {
            const prices = await source.read(fetchText);
            if (!prices.length || prices.length > 10000) throw new Error("未解析到有效官方价格，已保留上次价格");
            const unique = new Map(prices.map((price) => [price.model, price]));
            const finished = now();
            const state: ModelPriceSyncState = { id: source.id, name: source.name, url: source.url, status: "success", modelCount: unique.size, parserVersion: source.parserVersion,
              lastAttemptAt: attemptedAt, lastSuccessAt: finished.toISOString(), nextSyncAt: nextModelPriceSyncAt(finished).toISOString() };
            store.saveOfficialModelPrices([...unique.values()], state);
          } catch (error) {
            store.saveModelPriceSyncState({ ...previous, status: "failed", lastAttemptAt: attemptedAt, parserVersion: source.parserVersion,
              nextSyncAt: new Date(now().getTime() + RETRY_MS).toISOString(), error: error instanceof Error ? error.message.slice(0, 240) : "官方价格同步失败" });
          }
        }
      }));
      return { ...status(), running: false };
    })().finally(() => { current = undefined; schedule(); });
    return current;
  };

  return {
    status,
    sync,
    start() { stopped = false; schedule(); },
    stop() { stopped = true; if (timer) clearTimeout(timer); }
  };
}

export type ModelPriceSync = ReturnType<typeof createModelPriceSync>;
