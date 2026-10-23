import type { Publisher, DeliveryOutcome } from '../transport/nostrTransport';
import type { ContentPolicy } from '../ports';

/** The same gate covers direct sends and restored/queued borrowed outbox sends. */
export function policyPublish(policy: ContentPolicy, publish: Publisher): Publisher {
  return async (event, urls, options = {}) => {
    const generation = policy.generation;
    const relays: Record<string, DeliveryOutcome> = {};
    const allowed = urls.filter(url => policy.relayAllowed(url));
    for (const url of urls) if (!allowed.includes(url)) {
      relays[url] = { state: 'not-sent', detail: 'Destination blocked by current content policy.' };
      options.onOutcome?.(url, relays[url]);
    }
    if (!allowed.length) return { id: event.id, relays };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const unsubscribe = policy.onChange(cancel);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const observe = (url: string, outcome: DeliveryOutcome) => {
      if (!allowed.includes(url) || relays[url] || generation !== policy.generation || controller.signal.aborted || !policy.relayAllowed(url)) return;
      relays[url] = outcome; options.onOutcome?.(url, outcome);
    };
    try {
      if (!controller.signal.aborted) {
        const result = await publish(event, allowed, { ...options, signal: controller.signal, onOutcome: observe });
        for (const [url, outcome] of Object.entries(result.relays)) observe(url, outcome);
      }
      for (const url of allowed) if (!relays[url]) {
        relays[url] = { state: 'uncertain', detail: 'Policy or request changed during delivery. Check the saved receipt before an explicit retry.' };
        options.onOutcome?.(url, relays[url]);
      }
      return { id: event.id, relays };
    } finally { unsubscribe(); options.signal?.removeEventListener('abort', cancel); }
  };
}
