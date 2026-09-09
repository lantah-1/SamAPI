import { createStreamLogCollector } from "./log-content.js";
import { responseLogLinks, type LogResponseTool } from "./log-context.js";
import { isRecord } from "./util/text.js";

/** Share the usage observer's byte stream; persist bounded snapshots, not individual SSE frames. */
export function createLogResponseCapture(hooks: {
  progress: (text: string) => void;
  links: (responseIds: string[], tools: LogResponseTool[]) => void;
}) {
  const ids = new Set<string>();
  const tools = new Map<string, LogResponseTool>();
  let linksDirty = false;
  let previousText = "";
  let lastWrite = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const collector = createStreamLogCollector((event) => {
    const links = responseLogLinks(event);
    for (const id of links.responseIds) if (!ids.has(id)) { ids.add(id); linksDirty = true; }
    const chatDelta = isRecord(event) && Array.isArray(event.choices) && event.choices.some((choice) => isRecord(choice) && isRecord(choice.delta));
    for (const tool of links.tools) {
      const previous = tools.get(tool.key);
      const next = { ...tool, callId: tool.callId || previous?.callId,
        name: chatDelta && previous && tool.name !== previous.name && !tool.callId ? previous.name + tool.name : tool.name };
      if (!previous || previous.callId !== next.callId || previous.name !== next.name) { tools.set(tool.key, next); linksDirty = true; }
    }
  });
  const publish = (text: string, force = false) => {
    if (!force && Date.now() - lastWrite < 500) {
      if (!timer && (text !== previousText || linksDirty)) {
        timer = setTimeout(() => { timer = undefined; publish(collector.snapshot(), true); }, 500 - (Date.now() - lastWrite));
        timer.unref();
      }
      return;
    }
    if (timer) { clearTimeout(timer); timer = undefined; }
    lastWrite = Date.now();
    if (text !== previousText) { previousText = text; hooks.progress(text); }
    if (linksDirty) { linksDirty = false; hooks.links([...ids], [...tools.values()]); }
  };
  return {
    push(text: string) { collector.push(text); publish(collector.snapshot()); },
    finish() { publish(collector.finish(), true); }
  };
}
