import type { HostView } from './ports';

/** Navigation is owned by the presentation, independent of global history. */
export function createNavigation() {
  let view: HostView = 'content';
  return {
    current: () => view,
    navigate(next: HostView) {
      if (!['content', 'compose'].includes(next)) throw new TypeError('Unknown host view');
      view = next;
    },
  };
}

/** Media overlays stay inside this host; they never change application history. */
export function useMediaViewerHistory(onClose: () => void, _openerRef: unknown) {
  return onClose;
}
