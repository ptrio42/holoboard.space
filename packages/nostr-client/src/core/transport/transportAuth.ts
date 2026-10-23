import type { EventTemplate } from 'nostr-tools';
import { verifiedNostrEvent } from '../events/verifyNostrEvent';
import type { SocketAuthorization } from './nostrTransport';
import type { AuthorSigner } from '../ports';

class AuthorizationFailure extends Error {}

/** One socket, principal and signer generation. No HTTP session proof is accepted. */
export function socketAuthorization(
  relay: string, socket: WebSocket, principal: string, signer: AuthorSigner, generation: number,
): SocketAuthorization {
  let challenge: string | undefined;
  let epoch = 0;
  let disposed = false;
  let accepted: number | undefined;
  const pending = new Set<{ start(): void; cancel(reason: string): void; ack(id: string, ok: boolean): void }>();
  const error = (reason: string) => new AuthorizationFailure(`AUTH: ${reason}`);
  const guard = (expected: number) => {
    if (disposed || socket.readyState !== WebSocket.OPEN) throw error('Socket closed.');
    if (signer.generation !== generation) throw error('Signer generation changed.');
    if (epoch !== expected) throw error('Relay challenge changed.');
  };
  const receive = ({ data }: MessageEvent<unknown>) => {
    if (typeof data !== 'string' || data.length > 1_048_576) return;
    try {
      const message: unknown = JSON.parse(data);
      if (!Array.isArray(message)) return;
      if (message[0] === 'AUTH') {
        if (typeof message[1] !== 'string' || !message[1].length || message[1].length > 1024) {
          epoch++; accepted = undefined; challenge = undefined;
          for (const attempt of [...pending]) attempt.cancel('Invalid relay challenge.');
          return;
        }
        if (challenge === message[1]) return;
        const replacing = challenge !== undefined;
        challenge = message[1]; epoch++; accepted = undefined;
        for (const attempt of [...pending]) {
          if (replacing) attempt.cancel('Relay challenge changed.');
          else attempt.start();
        }
      }
      if (message[0] === 'OK' && typeof message[1] === 'string' && typeof message[2] === 'boolean' && typeof message[3] === 'string') {
        for (const attempt of [...pending]) attempt.ack(message[1], message[2]);
      }
    } catch { /* Ignore malformed protocol frames. */ }
  };
  socket.addEventListener('message', receive);
  const dispose = () => {
    if (disposed) return;
    disposed = true; epoch++; accepted = undefined;
    socket.removeEventListener('message', receive);
    socket.removeEventListener('close', dispose);
    for (const attempt of [...pending]) attempt.cancel('Socket closed.');
  };
  socket.addEventListener('close', dispose, { once: true });
  return {
    dispose,
    authorize(signal) {
      if (signal.aborted) return Promise.reject(error('Cancelled.'));
      try { guard(epoch); } catch (failure) { return Promise.reject(failure); }
      if (accepted === epoch) {
        const authorizedEpoch = epoch;
        return Promise.resolve(() => guard(authorizedEpoch));
      }
      if (pending.size >= 4) return Promise.reject(error('Authorization budget exhausted.'));
      return new Promise<() => void>((resolve, reject) => {
        let ended = false;
        let started = false;
        let proofId: string | undefined;
        let requestedEpoch = epoch;
        const finish = (reason?: string) => {
          if (ended) return;
          ended = true; pending.delete(attempt); clearInterval(generationWatch);
          signal.removeEventListener('abort', cancelled);
          if (reason) reject(error(reason));
          else { accepted = requestedEpoch; resolve(() => guard(requestedEpoch)); }
        };
        const cancelled = () => finish('Cancelled.');
        const attempt = {
          cancel: finish,
          start() {
            if (started || ended || challenge === undefined) return;
            started = true; requestedEpoch = epoch;
            const template: EventTemplate = { kind: 22242, created_at: Math.floor(Date.now() / 1000), content: '',
              tags: [['relay', relay], ['challenge', challenge]] };
            void (async () => {
              try {
                guard(requestedEpoch);
                if (await signer.getPublicKey() !== principal) throw error('Signer principal changed.');
                if (ended) return;
                guard(requestedEpoch);
                // Give the signer a separate body so mutations cannot change the expected proof.
                const signed = await signer.signEvent({ ...template, tags: template.tags.map(tag => [...tag]) });
                if (ended) return;
                guard(requestedEpoch);
                if (JSON.stringify(signed).length > 16384) throw error('Invalid signed proof.');
                const proof = verifiedNostrEvent(signed);
                if (!proof || proof.pubkey !== principal || proof.kind !== template.kind ||
                    proof.created_at !== template.created_at || proof.content !== template.content ||
                    JSON.stringify(proof.tags) !== JSON.stringify(template.tags)) throw error('Invalid signed proof.');
                proofId = proof.id;
                socket.send(JSON.stringify(['AUTH', proof]));
              } catch (failure) {
                finish(failure instanceof AuthorizationFailure
                  ? failure.message.slice(6, 250) : 'Signer declined or proof could not be sent.');
              }
            })();
          },
          ack(id: string, ok: boolean) {
            if (!proofId || id !== proofId) return;
            try { guard(requestedEpoch); } catch { finish('Authorization became stale.'); return; }
            finish(ok ? undefined : 'Relay rejected proof.');
          },
        };
        // AuthorSigner has a generation counter rather than an event subscription.
        // Poll only pending requests; every send and ACK also checks synchronously.
        const generationWatch = setInterval(() => {
          if (signer.generation !== generation) finish('Signer generation changed.');
        }, 20);
        signal.addEventListener('abort', cancelled, { once: true });
        pending.add(attempt); attempt.start();
      });
    },
  };
}
