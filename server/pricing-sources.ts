import { load, type CheerioAPI } from "cheerio";
import type { ModelPriceRates, ModelPriceRule, OfficialModelPrice, OfficialPriceSource } from "../shared/usage.js";

export type FetchPriceText = (url: string) => Promise<string>;
type HtmlNode = ReturnType<CheerioAPI>[number];
export interface PriceSource extends OfficialPriceSource { parserVersion?: number; read: (fetchText: FetchPriceText) => Promise<OfficialModelPrice[]> }
const clean = (text: string) => text.replace(/\s+/g, " ").trim();
const rounded = (value: number) => Math.round(value * 1e6) / 1e6;
const dollars = (text: string) => {
  const value = text.replace(/~~[^~]*~~/g, "").match(/\$\s*([\d,]+(?:\.\d+)?)/)?.[1];
  return value === undefined ? /^free(?:\s|$)/i.test(clean(text)) ? 0 : undefined : Number(value.replace(/,/g, ""));
};
const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const tokenCount = (amount: string, unit = "") => Number(amount.replace(/,/g, "")) * (/m/i.test(unit) ? 1e6 : /k/i.test(unit) ? 1000 : 1);
const pageText = (html: string) => { const $ = load(html); $("script,style").remove(); return clean($("body").text()); };

function rates(input: number | undefined, output: number | undefined, cached: number | undefined, write?: number, longWrite?: number): ModelPriceRates {
  if (input === undefined || output === undefined) throw new Error("官方页面缺少输入或输出单价");
  return { inputUsdPerMillion: rounded(input), outputUsdPerMillion: rounded(output), cachedInputUsdPerMillion: rounded(cached ?? 0),
    ...(cached === undefined ? { cacheReadUnavailable: true } : {}),
    ...(write === undefined ? {} : { cacheWriteUsdPerMillion: rounded(write) }), ...(longWrite === undefined ? {} : { cacheWriteLongUsdPerMillion: rounded(longWrite) }) };
}

function price(source: OfficialPriceSource, model: string, value: ModelPriceRates, extra: Partial<OfficialModelPrice> = {}): OfficialModelPrice {
  return { providerId: "", model: model.toLowerCase(), ...value, source: { id: source.id, name: source.name, url: source.url }, ...extra };
}

/** Expand spans so multi-column official pricing tables keep their headings aligned. */
export function pricingTableRows($: CheerioAPI, table: HtmlNode): string[][] {
  const grid: string[][] = [];
  $(table).find("tr").each((rowIndex, row) => {
    grid[rowIndex] ||= [];
    let column = 0;
    $(row).children("th,td").each((_, cell) => {
      while (grid[rowIndex][column] !== undefined) column++;
      const copy = $(cell).clone(); copy.find("s,del,sup").remove(); copy.find("br").replaceWith("\n");
      const text = copy.text().trim();
      const width = Math.min(30, Math.max(1, Number($(cell).attr("colspan")) || 1));
      const height = Math.min(100, Math.max(1, Number($(cell).attr("rowspan")) || 1));
      for (let y = rowIndex; y < rowIndex + height; y++) {
        grid[y] ||= [];
        for (let x = column; x < column + width; x++) grid[y][x] = text;
      }
      column += width;
    });
  });
  return grid;
}

function markdownTables(markdown: string) {
  const result: string[][][] = [];
  let table: string[][] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*\|/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
      if (!cells.every((cell) => /^:?-+:?$/.test(cell))) table.push(cells);
    } else if (table.length) { result.push(table); table = []; }
  }
  if (table.length) result.push(table);
  return result;
}

function decodeAstro(value: unknown): unknown {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("OpenAI 官方价格数据格式变化");
  const [tag, data] = value;
  if (tag === 1 && Array.isArray(data)) return data.map(decodeAstro);
  if (tag === 0) return data && typeof data === "object" ? Object.fromEntries(Object.entries(data).map(([key, item]) => [key, decodeAstro(item)])) : data;
  throw new Error("OpenAI 官方价格数据类型变化");
}

function openAiTables(html: string) {
  const $ = load(html);
  const tables: Array<{ element: HtmlNode; tier: string; rows: unknown[][] }> = [];
  for (const element of $("astro-island[props]")) {
    const raw = $(element).attr("props")!;
    if (!raw.includes("tier") || !raw.includes("rows")) continue;
    const props = Object.fromEntries(Object.entries(JSON.parse(raw)).map(([key, value]) => [key, decodeAstro(value)]));
    if (typeof props.tier === "string" && Array.isArray(props.rows)) tables.push({ element, tier: props.tier, rows: props.rows as unknown[][] });
  }
  if (!tables.some((table) => table.tier === "standard")) throw new Error("未找到 OpenAI 官方标准价格表");
  return { $, tables };
}

export function parseOpenAiPrices(html: string, modelDocs: Record<string, string>, source: OfficialPriceSource): OfficialModelPrice[] {
  const { $, tables } = openAiTables(html);
  const readTier = ({ element, rows }: typeof tables[number]) => {
    const longRates = new Map<string, ModelPriceRates>();
    const table = $(element).find("table").first();
    if (table.length) for (const row of pricingTableRows($, table[0])) {
      if (row.length === 9 && dollars(row[5]) !== undefined && dollars(row[8]) !== undefined) longRates.set(clean(row[0]), rates(dollars(row[5]), dollars(row[8]), dollars(row[6]), dollars(row[7])));
    }
    const result: OfficialModelPrice[] = [];
    for (const row of rows) {
      if (typeof row[0] !== "string" || !/^[\w.-]+(?: \(|$)/.test(row[0])) continue;
      const model = row[0].replace(/ \(.+$/, "");
      const base = rates(numeric(row[1]), numeric(row[row.length - 1]), numeric(row[2]), row.length === 5 ? numeric(row[3]) : undefined);
      const extra: Partial<OfficialModelPrice> = { cacheReadUnavailable: numeric(row[2]) === undefined };
      const context = row[0].match(/<([\d,]+)([KM]?)\s*context/i);
      if (context || longRates.has(model)) {
        const description = pageText(modelDocs[model] || "");
        const threshold = description.match(/(?:prompts? with(?: more than)?|input(?:s| tokens)? (?:over|above)|greater than)\s*>?\s*([\d,]+)\s*([km]?)/i);
        const aboveInputTokens = threshold ? tokenCount(threshold[1], threshold[2]) : context ? tokenCount(context[1], context[2]) : undefined;
        if (!aboveInputTokens) throw new Error(`未确认 ${model} 的长上下文计费阈值`);
        let longer = longRates.get(model);
        const multiplier = description.match(/(?:priced|billed) at\s*([\d.]+)x input and\s*([\d.]+)x output/i);
        if (!longer && multiplier) longer = rates(base.inputUsdPerMillion * Number(multiplier[1]), base.outputUsdPerMillion * Number(multiplier[2]), base.cachedInputUsdPerMillion * Number(multiplier[1]), base.cacheWriteUsdPerMillion === undefined ? undefined : base.cacheWriteUsdPerMillion * Number(multiplier[1]));
        if (longer) extra.rules = [{ aboveInputTokens, ...longer }];
        else extra.maxInputTokens = aboveInputTokens;
      }
      result.push(price(source, model, base, extra));
    }
    return result;
  };
  const result = readTier(tables.find((table) => table.tier === "standard")!);
  for (const table of tables.filter((table) => ["flex", "fast", "priority", "ultrafast"].includes(table.tier))) {
    for (const item of readTier(table)) {
      const base = result.find((entry) => entry.model === item.model);
      if (!base) continue;
      const { providerId: _provider, model: _model, source: _source, ...tier } = item;
      base.serviceTiers ||= {};
      base.serviceTiers[table.tier] = tier;
      // OpenAI Fast mode accepts both spellings and can report either one.
      if (table.tier === "fast" || table.tier === "priority") {
        base.serviceTiers.fast = tier;
        base.serviceTiers.priority = tier;
      }
    }
  }
  // The specialized text-model table is separate from the flagship table.
  for (const table of $("table")) {
    const rows = pricingTableRows($, table);
    if (clean(rows[0]?.join(" ") || "") !== "Category Model Input Cached input Output") continue;
    for (const row of rows.slice(1)) if (row[1] && !result.some((item) => item.model === row[1])) result.push(price(source, row[1], rates(dollars(row[2]), dollars(row[4]), dollars(row[3]))));
  }
  return result;
}

export function parseAnthropicPrices(markdown: string, source: OfficialPriceSource): OfficialModelPrice[] {
  const table = markdownTables(markdown).find((rows) => rows[0].some((cell) => /Base input tokens/i.test(cell)));
  if (!table) throw new Error("未找到 Claude 官方模型价格表");
  return table.slice(1).map((row) => {
    const match = row[0].match(/Claude\s+(Fable|Mythos|Opus|Sonnet|Haiku)\s+([\d.]+)/i);
    if (!match) throw new Error("Claude 模型名称格式变化");
    const version = match[2].replace(/\./g, "-");
    const model = Number(match[2]) < 4 ? `claude-${version}-${match[1]}` : `claude-${match[1]}-${version}`;
    return price(source, model, rates(dollars(row[1]), dollars(row[5]), dollars(row[4]), dollars(row[2]), dollars(row[3])), Number(match[2]) < 4.6 ? { maxInputTokens: 200000 } : {});
  });
}

export function parseDeepSeekPrices(html: string, source: OfficialPriceSource): OfficialModelPrice[] {
  const $ = load(html);
  const table = $("table").filter((_, element) => $(element).text().includes("CACHE HIT")).first();
  if (!table.length) throw new Error("未找到 DeepSeek 官方 Token 价格表");
  const rows = pricingTableRows($, table[0]);
  const modelRow = rows.find((row) => row.some((cell) => /^deepseek-/.test(cell)))!;
  const models = modelRow.map((cell, index) => ({ model: clean(cell), index })).filter((item) => /^deepseek-/.test(item.model));
  const text = pageText(html);
  const schedule = text.match(/Peak hours are ([^.]+) UTC, Monday through Friday/i);
  const windows = schedule ? [...schedule[1].matchAll(/(\d{2}):(\d{2})\s*[-–]\s*(\d{2}):(\d{2})/g)].map((match) => ({ weekdaysUtc: [1, 2, 3, 4, 5], startMinuteUtc: Number(match[1]) * 60 + Number(match[2]), endMinuteUtc: Number(match[3]) * 60 + Number(match[4]) })) : [];
  return models.map(({ model, index }) => {
    const value = (label: RegExp, peak: boolean) => {
      const row = rows.find((row) => label.test(row.slice(0, models[0].index).join(" ")) && (peak ? /\bPEAK\b/.test(row.join(" ")) && !/OFF-PEAK/.test(row.join(" ")) : !/\bPEAK\b/.test(row.join(" ")) || /OFF-PEAK/.test(row.join(" "))));
      return row ? dollars(row[index]) : undefined;
    };
    const base = rates(value(/CACHE MISS/, false), value(/OUTPUT TOKENS/, false), value(/CACHE HIT/, false));
    const peakInput = value(/CACHE MISS/, true);
    if (peakInput === undefined) return price(source, model, base);
    if (!windows.length) throw new Error("DeepSeek 高峰计费时间格式变化");
    const peak = rates(peakInput, value(/OUTPUT TOKENS/, true), value(/CACHE HIT/, true));
    return price(source, model, base, { rules: windows.map((window) => ({ ...window, ...peak })) });
  });
}

export function parseXaiPrices(html: string, source: OfficialPriceSource): OfficialModelPrice[] {
  const $ = load(html);
  const script = $("script").map((_, element) => $(element).text()).get().find((text) => text.startsWith("globalThis.__XAI_PUBLIC_MODELS__="));
  if (!script) throw new Error("未找到 xAI 官方价格数据");
  // JSON only: never execute a vendor's scripts.
  const payload = JSON.parse(script.slice(script.indexOf("=") + 1).replace(/;\s*$/, ""));
  const models = payload.clusterConfigs?.[0]?.languageModels;
  if (!Array.isArray(models)) throw new Error("xAI 官方价格格式变化");
  return models.flatMap((model) => {
    if (!model.inputModalities?.includes("TEXT") || !model.outputModalities?.includes("TEXT")) return [];
    const value = (key: string) => typeof model[key] === "string" && /^\d+(?:\.\d+)?$/.test(model[key]) ? Number(model[key]) / 10000 : undefined;
    const base = rates(value("promptTextTokenPrice"), value("completionTextTokenPrice"), value("cachedPromptTokenPrice"));
    const rules: ModelPriceRule[] = [];
    if (value("promptTextTokenPriceLongContext") !== undefined) {
      const threshold = Number(model.longContextThreshold);
      if (!Number.isSafeInteger(threshold) || threshold <= 0) throw new Error("xAI 长上下文阈值无效");
      rules.push({ aboveInputTokens: threshold, ...rates(value("promptTextTokenPriceLongContext"), value("completionTokenPriceLongContext"), value("cachedPromptTokenPriceLongContext")) });
    }
    return [model.name, ...(model.aliases || [])].filter((name): name is string => typeof name === "string").map((name) => price(source, name, base, { rules }));
  });
}

export function parseGooglePrices(html: string, source: OfficialPriceSource): OfficialModelPrice[] {
  const $ = load(html);
  const result: OfficialModelPrice[] = [];
  for (const element of $(".models-section")) {
    const model = $(element).find("code").first().text().trim();
    if (!/^gemini-/.test(model) || /image|audio|tts|live|transcrib|translate|embedding|omni|streaming/.test(model)) continue;
    const section = $(element).nextUntil(".models-section");
    const table = section.find("table").add(section.filter("table")).first();
    if (!table.length) continue;
    const rows = pricingTableRows($, table[0]);
    if (!rows[0]?.some((cell) => /Paid Tier.*USD/s.test(cell))) continue;
    const cell = (label: RegExp) => rows.find((row) => label.test(row[0]))?.at(-1) || "";
    const input = cell(/^Input price/), output = cell(/^Output price/);
    const cached = cell(/^Context caching price/).split(/\n/).filter((line) => !/per hour|storage price/.test(line)).join(" ");
    if (dollars(input) === undefined || dollars(output) === undefined) continue;
    const base = rates(dollars(input), dollars(output), dollars(cached));
    const rules: ModelPriceRule[] = [];
    const threshold = input.match(/(?:>|≤|<=)\s*([\d,]+)\s*k/i);
    if (threshold) {
      const higher = (text: string) => [...text.matchAll(/\$\s*([\d.]+)/g)][1]?.[1];
      if (!higher(input) || !higher(output)) throw new Error(`${model} 的分段价格格式变化`);
      rules.push({ aboveInputTokens: tokenCount(threshold[1], "k"), ...rates(Number(higher(input)), Number(higher(output)), higher(cached) ? Number(higher(cached)) : dollars(cached)) });
    }
    const starting = input.match(/starting\s+([A-Za-z]+ \d{1,2}, \d{4})/i);
    if (starting) {
      const future = (text: string) => Number([...text.matchAll(/\$\s*([\d.]+)/g)][1]?.[1]);
      rules.push({ effectiveFrom: new Date(`${starting[1]} 00:00:00 UTC`).toISOString(), ...rates(future(input), future(output), future(cached)) });
    }
    result.push(price(source, model, base, { rules, cacheReadUnavailable: dollars(cached) === undefined }));
  }
  return result;
}

export function parseZaiPrices(markdown: string, source: OfficialPriceSource): OfficialModelPrice[] {
  return markdownTables(markdown).filter((rows) => rows[0].includes("Cached Input")).flatMap((rows) => rows.slice(1).map((row) => {
    const base = rates(dollars(row[1]), dollars(row[4]), dollars(row[2]));
    const original = (cell: string) => { const match = cell.match(/~~([^~]+)~~/); return match ? dollars(match[1]) : undefined; };
    const rules: ModelPriceRule[] = [];
    if (original(row[1]) !== undefined) {
      const until = markdown.match(/promotion ends at 24:00 on ([A-Za-z]+ \d{1,2}, \d{4}) \(UTC\+8/);
      if (!until) throw new Error("GLM 优惠结束时间格式变化");
      const end = new Date(`${until[1]} 00:00:00 GMT+0800`).getTime() + 86400000;
      rules.push({ effectiveFrom: new Date(end).toISOString(), ...rates(original(row[1]), original(row[4]), original(row[2])) });
    }
    return price(source, clean(row[0]), base, { rules, cacheReadUnavailable: dollars(row[2]) === undefined });
  }));
}

export function parseMinimaxPrices(markdown: string, source: OfficialPriceSource): OfficialModelPrice[] {
  const priorityTabs = [...markdown.matchAll(/<Tab title="Priority[^"]*">([\s\S]*?)<\/Tab>/g)];
  const readTier = (text: string) => {
    const result = new Map<string, OfficialModelPrice>();
    for (const rows of markdownTables(text).filter((rows) => rows[0].includes("Prompt caching Read"))) for (const row of rows.slice(1)) {
      const model = row[0].match(/MiniMax-[\w.-]+/)?.[0].toLowerCase();
      if (!model) throw new Error("MiniMax 模型名称格式变化");
      const base = rates(dollars(row[1]), dollars(row[2]), dollars(row[3]), row[4] ? dollars(row[4]) : undefined);
      const threshold = row[0].replace(/<[^>]+>/g, " ").match(/>\s*([\d,]+)\s*k/i);
      if (threshold) {
        const existing = result.get(model); if (!existing) throw new Error("MiniMax 缺少标准上下文价格");
        existing.rules = [...(existing.rules || []), { aboveInputTokens: tokenCount(threshold[1], "k"), ...base }];
      } else result.set(model, price(source, model, base));
    }
    return result;
  };
  const result = readTier(markdown.replace(/<Tab title="Priority[^"]*">[\s\S]*?<\/Tab>/g, ""));
  for (const tab of priorityTabs) for (const item of readTier(tab[1]).values()) {
    const base = result.get(item.model);
    if (!base) continue;
    const { providerId: _provider, model: _model, source: _source, ...tier } = item;
    base.serviceTiers = { priority: tier };
  }
  return [...result.values()];
}

export function parseKimiPrices(markdown: string, source: OfficialPriceSource): OfficialModelPrice[] {
  const result: OfficialModelPrice[] = [];
  for (const match of markdown.matchAll(/\["(kimi-[\w.-]+)",\s*"1M tokens",([^\n]+)\]/g)) {
    const values = [...match[2].matchAll(/\{"\$"\}([\d.]+)/g)].map((item) => Number(item[1]));
    if (values.length !== 3) throw new Error("Kimi 官方价格格式变化");
    result.push(price(source, match[1], rates(values[1], values[2], values[0])));
  }
  return result;
}

export function parseQwenPrices(html: string, source: OfficialPriceSource, cacheHtml = ""): OfficialModelPrice[] {
  const $ = load(html);
  const segments = new Map<string, Map<number, { rates: ModelPriceRates; upper?: number }>>();
  const ambiguous = new Set<string>();
  const cache = load(cacheHtml);
  const implicit = clean(cache("#billing-2").nextUntil("h2,h3").text());
  const explicit = clean(cache("#billing").nextUntil("h2,h3").text());
  const modelNames = (text: string) => new Set([...text.matchAll(/\bqwen[\w.-]+/g)].map((match) => match[0].replace(/\.$/, "")));
  const implicitModels = modelNames(cache("#singapore-2-h4").parent().text());
  const explicitModels = modelNames(cache("#singapore-h4").parent().text());
  const implicitExceptions = modelNames(implicit.match(/For models other than ([^:]+):/i)?.[1] || "");
  const explicitExceptions = modelNames(explicit.match(/Exception:([\s\S]+)/i)?.[1] || "");
  const implicitPercent = implicit.match(/unit price of\s*cached_token\s*is\s*([\d.]+)%/i)?.[1];
  const explicitPercent = explicit.match(/Cache hit:\s*Billed at\s*([\d.]+)%/i)?.[1];
  const writePercent = explicit.match(/Cache creation:[^.]+?billed at\s*([\d.]+)%/i)?.[1];
  if (cacheHtml && (!implicitModels.size || !explicitModels.size || !implicitPercent || !explicitPercent || !writePercent)) throw new Error("Qwen 官方缓存计费规则格式变化");
  for (const table of $("table")) {
    const rows = pricingTableRows($, table), header = rows[0]?.map(clean) || [];
    const modelAt = header.indexOf("Model ID"), scopeAt = header.indexOf("Deployment scope");
    const inputAt = header.findIndex((cell) => /^Input price.*1 million tokens/.test(cell));
    const outputColumns = header.map((cell, index) => /^Output price.*1 million tokens/.test(cell) ? index : -1).filter((index) => index >= 0);
    const outputAt = outputColumns[0] ?? -1;
    const contextAt = header.indexOf("Input tokens per request");
    if (modelAt < 0 || scopeAt < 0 || inputAt < 0 || outputAt < 0) continue;
    for (const row of rows.slice(1)) {
      if (clean(row[scopeAt] || "") !== "International") continue;
      const model = row[modelAt]?.match(/^qwen[\w.-]+/)?.[0];
      if (!model || /audio|tts|image|omni|vl|asr/.test(model) || dollars(row[inputAt]) === undefined || dollars(row[outputAt]) === undefined) continue;
      // Some older models charge different rates for thinking and non-thinking output.
      // Do not silently choose a rate when the request's billing mode is unknown.
      if (outputColumns.some((index) => dollars(row[index]) !== dollars(row[outputAt]))) { ambiguous.add(model); continue; }
      const input = dollars(row[inputAt])!;
      const value = rates(input, dollars(row[outputAt]), implicitModels.has(model) && !implicitExceptions.has(model) ? input * Number(implicitPercent) / 100 : undefined,
        explicitModels.has(model) ? input * Number(writePercent) / 100 : undefined);
      if (explicitModels.has(model) && !explicitExceptions.has(model)) value.explicitCachedInputUsdPerMillion = rounded(input * Number(explicitPercent) / 100);
      const threshold = (row[contextAt] || "").match(/([\d,.]+)\s*([KM]?)\s*<\s*Token/i);
      const above = threshold ? tokenCount(threshold[1], threshold[2]) : 0;
      const upperMatch = (row[contextAt] || "").match(/Token\s*(?:≤|<=)\s*([\d,.]+)\s*([KM]?)/i);
      const upper = upperMatch ? tokenCount(upperMatch[1], upperMatch[2]) : undefined;
      const modelSegments = segments.get(model) || new Map();
      const previous = modelSegments.get(above);
      if (previous && JSON.stringify(previous.rates) !== JSON.stringify(value)) ambiguous.add(model);
      modelSegments.set(above, { rates: value, upper });
      segments.set(model, modelSegments);
    }
  }
  return [...segments].filter(([model, values]) => !ambiguous.has(model) && values.has(0)).map(([model, values]) => {
    const ordered = [...values].sort(([a], [b]) => a - b);
    const upper = ordered.at(-1)![1].upper;
    return price(source, model, ordered[0][1].rates, { cacheReadRequiresMode: true,
      ...(upper ? { maxInputTokens: upper } : {}), rules: ordered.slice(1).map(([aboveInputTokens, segment]) => ({ aboveInputTokens, ...segment.rates })) });
  });
}

export function parseMimoPrices(markdown: string, source: OfficialPriceSource): OfficialModelPrice[] {
  const overseas = markdown.split(/### Overseas Pricing of the Model/i)[1]?.split(/\n### /)[0];
  if (!overseas) throw new Error("未找到 MiMo 官方美元价格表");
  const $ = load(overseas);
  const result: OfficialModelPrice[] = [];
  for (const table of $("table")) {
    const rows = pricingTableRows($, table);
    if (!rows[0]?.[1]?.includes("Input (Cache Hit)") || !rows[0]?.[2]?.includes("Input (Cache Miss)")) continue;
    for (const row of rows.slice(1)) {
      const model = row[0].match(/mimo-[\w.-]+/)?.[0];
      if (model) result.push(price(source, model, rates(dollars(row[2]), dollars(row[3]), dollars(row[1]), /Cache Write:\s*Limited-time Free/i.test(markdown) ? 0 : undefined)));
    }
  }
  return result;
}

export function parseStepfunPrices(markdown: string, source: OfficialPriceSource): OfficialModelPrice[] {
  return markdownTables(markdown).filter((rows) => rows[0].some((cell) => /Input(?: Price)?.*Cache Miss/i.test(cell))).flatMap((rows) => rows.slice(1).flatMap((row) => {
    const model = row[0].match(/step-[\w.-]+/)?.[0];
    if (!model || /audio|tts|asr/.test(model) || !/^1M tokens$/i.test(row[1])) return [];
    return [price(source, model, rates(dollars(row[2]), dollars(row[4]), dollars(row[3])))];
  }));
}

function documentSource(id: string, name: string, url: string, parse: (text: string, source: OfficialPriceSource) => OfficialModelPrice[], parserVersion?: number): PriceSource {
  const source = { id, name, url };
  return { ...source, parserVersion, read: async (fetchText) => parse(await fetchText(url), source) };
}

export const officialPriceSources: PriceSource[] = [
  { id: "openai", name: "OpenAI", url: "https://developers.openai.com/api/docs/pricing", parserVersion: 1, async read(fetchText) {
    const html = await fetchText(this.url), { $, tables } = openAiTables(html);
    const names = [...new Set(tables.filter((table) => table.tier !== "batch").flatMap(({ element, rows }) => {
      const latest = new Set($(element).find("table").first().find("tbody tr").map((_, row) => $(row).children("td").length === 9 ? $(row).children("td").first().text() : "").get().filter(Boolean));
      return rows.filter((row) => typeof row[0] === "string" && (row[0].includes("context") || latest.has(row[0]))).map((row) => String(row[0]).replace(/ \(.+$/, ""));
    }))];
    const docs: Record<string, string> = {};
    for (let i = 0; i < names.length; i += 3) await Promise.all(names.slice(i, i + 3).map(async (name) => { docs[name] = await fetchText(`https://developers.openai.com/api/docs/models/${encodeURIComponent(name)}`); }));
    return parseOpenAiPrices(html, docs, this);
  } },
  documentSource("anthropic", "Claude", "https://platform.claude.com/docs/en/about-claude/pricing.md", parseAnthropicPrices),
  documentSource("google", "Gemini", "https://ai.google.dev/gemini-api/docs/pricing", parseGooglePrices),
  documentSource("deepseek", "DeepSeek", "https://api-docs.deepseek.com/quick_start/pricing/", parseDeepSeekPrices),
  documentSource("xai", "Grok", "https://docs.x.ai/developers/models", parseXaiPrices),
  documentSource("zai", "GLM", "https://docs.z.ai/guides/overview/pricing.md", parseZaiPrices),
  documentSource("minimax", "MiniMax", "https://platform.minimax.io/docs/guides/pricing-paygo.md", parseMinimaxPrices, 1),
  { id: "qwen", name: "Qwen（国际站）", url: "https://www.alibabacloud.com/help/en/model-studio/model-pricing", async read(fetchText) {
    const [html, cache] = await Promise.all([fetchText(this.url), fetchText("https://www.alibabacloud.com/help/en/model-studio/context-cache")]);
    return parseQwenPrices(html, this, cache);
  } },
  documentSource("xiaomi", "MiMo（国际站）", "https://mimo.mi.com/static/docs/price/pay-as-you-go.md", parseMimoPrices),
  documentSource("stepfun", "StepFun（国际站）", "https://platform.stepfun.ai/docs/en/guides/pricing/details.md", parseStepfunPrices),
  { id: "kimi", name: "Kimi", url: "https://platform.kimi.ai/docs/pricing/chat", async read(fetchText) {
    const $ = load(await fetchText(this.url));
    const urls = [...new Set($("a[href]").map((_, link) => $(link).attr("href")!).get().filter((href) => /^\/docs\/pricing\/chat-[\w-]+$/.test(href)))].slice(0, 20);
    const result: OfficialModelPrice[] = [];
    for (const path of urls) result.push(...parseKimiPrices(await fetchText(`https://platform.kimi.ai${path}.md`), { id: this.id, name: this.name, url: `https://platform.kimi.ai${path}` }));
    return result;
  } }
];
