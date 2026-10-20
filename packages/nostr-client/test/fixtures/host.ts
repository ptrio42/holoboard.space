import type { ContentMode, HostDraft, HostOptions, HostPorts, HostSnapshot } from './ports';
import { createDraftStorage } from './storage';
import { createNavigation } from './navigation';
import { createHostMedia } from './media';
import { createContentPolicy, cancelledQuery, type FixturePolicy } from './policy';

export interface ClientHostServices extends HostPorts {
  readonly policy: FixturePolicy;
  readonly namespace: string;
  snapshot(): HostSnapshot;
  subscribe(listener: () => void): () => void;
  updateDraft(draft: HostDraft): void;
  setMode(mode: ContentMode): void;
}

/** Construction is inert. Only explicitly invoked ports may perform I/O. */
export function createClientHost(options: HostOptions): ClientHostServices {
  const identity = Object.freeze({ ...options.identity });
  const storage = createDraftStorage(identity);
  const navigation = createNavigation();
  const listeners = new Set<() => void>();
  const requests = new Set<AbortController>();
  let state: HostSnapshot = { view: navigation.current(), draft: storage.read(), disposed: false, policyGeneration: 0 };
  const assertAlive = () => { if (state.disposed) throw new Error('ClientHost is disposed'); };
  const emit = () => listeners.forEach(listener => listener());
  const policy = createContentPolicy(identity.localRelay, options.networkRelay, options.mediaUrls);
  policy.onChange(() => {
    if (state.disposed) return;
    state = { ...state, policyGeneration: policy.generation }; emit();
  });
  const signer: HostPorts['signer'] = {
    get generation() { return options.signer.generation; },
    async getPublicKey() { assertAlive(); return options.signer.getPublicKey(); },
    async signEvent(template) { assertAlive(); return options.signer.signEvent(template); },
  };
  const queryPort = options.query;
  return {
    identity, policy, signer, media: (() => { const media = createHostMedia(policy, options.media); return { ...media, servers: media.MEDIA_SERVERS }; })(), namespace: storage.namespace,
    snapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    updateDraft(draft) {
      assertAlive(); storage.write(draft); state = { ...state, draft: storage.read() }; emit();
    },
    navigate(view) {
      assertAlive(); navigation.navigate(view); state = { ...state, view }; emit();
    },
    setMode(next) {
      assertAlive();
      policy.setMode(next);
    },
    async query(filter, relays, signal) {
      assertAlive();
      if (relays.some(url => !policy.relayAllowed(url))) throw new Error('Relay blocked by host policy');
      const generation = policy.generation;
      const controller = new AbortController();
      const unsubscribe = policy.onChange(() => controller.abort());
      const cancel = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      requests.add(controller);
      try {
        if (controller.signal.aborted) return cancelledQuery(relays);
        const result = await queryPort(filter, relays, controller.signal);
        return controller.signal.aborted || generation !== policy.generation ? cancelledQuery(relays) : result;
      }
      finally { unsubscribe(); requests.delete(controller); signal?.removeEventListener('abort', cancel); }
    },
    dispose() {
      if (state.disposed) return;
      state = { ...state, disposed: true };
      requests.forEach(request => request.abort()); requests.clear();
      storage.clear(); policy.dispose(); emit(); listeners.clear();
      options.dispose?.();
    },
  };
}
