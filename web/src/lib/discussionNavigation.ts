import type { MouseEvent } from "react";

const positions = new Map<string, number>();

/** Only intercept explicit local reading links; modified clicks keep browser behavior. */
export function navigateReading(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = new URL(event.currentTarget.href);
    if (target.origin !== window.location.origin) return;
    event.preventDefault();
    positions.set(window.location.pathname + window.location.search, window.scrollY);
    if (positions.size > 16) positions.delete(positions.keys().next().value!);
    window.history.replaceState({ ...window.history.state, readingScroll: window.scrollY }, "");
    window.history.pushState({ readingScroll: positions.get(target.pathname + target.search) ?? 0 }, "", target.pathname + target.search);
    window.dispatchEvent(new PopStateEvent("popstate"));
}
