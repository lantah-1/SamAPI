import { useLayoutEffect, useRef } from "react";

const BOTTOM_THRESHOLD_PX = 80;
type Position = { height: number; following: boolean };

function position(element: HTMLElement): Position {
  return {
    height: element.scrollHeight,
    following: element.clientHeight > 0 && element.scrollHeight - element.clientHeight - element.scrollTop <= BOTTOM_THRESHOLD_PX
  };
}

/** Follow appended log content only when its scroll area was already near the bottom. */
export function useLogAutoScroll(logId: string | undefined, revision: number | undefined) {
  const containerRef = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<HTMLElement, Position>());
  const previousLogId = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const rememberScroll = (event: Event) => {
      const element = event.target;
      if (element instanceof HTMLElement && (element === container || element.tagName === "PRE")) {
        positions.current.set(element, position(element));
      }
    };
    // Expanding a section is a reading action, not newly appended log content.
    const rememberLayout = () => {
      for (const element of [container, ...container.querySelectorAll("pre")]) positions.current.set(element, position(element));
    };
    container.addEventListener("scroll", rememberScroll, true);
    container.addEventListener("toggle", rememberLayout, true);
    window.addEventListener("resize", rememberLayout);
    return () => {
      container.removeEventListener("scroll", rememberScroll, true);
      container.removeEventListener("toggle", rememberLayout, true);
      window.removeEventListener("resize", rememberLayout);
    };
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const sameLog = previousLogId.current === logId;
    if (!sameLog) container.scrollTop = 0;
    const next = new Map<HTMLElement, Position>();
    // The result and expanded attempt bodies can scroll independently of the modal.
    for (const element of [...container.querySelectorAll("pre"), container]) {
      const previous = sameLog ? positions.current.get(element) : undefined;
      if (previous?.following && element.clientHeight > 0 && element.scrollHeight > previous.height) element.scrollTop = element.scrollHeight;
      next.set(element, position(element));
    }
    positions.current = next;
    previousLogId.current = logId;
  }, [logId, revision]);

  return containerRef;
}
