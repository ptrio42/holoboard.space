import { pointerRelays as sharedRelays, eventPointer as sharedEvent, profilePointer as sharedProfile } from '@ptrio42/nostr-client/core';
import { relayCandidates } from './relayPolicy';
export const pointerRelays = (hints: string[] = []) => sharedRelays(hints, relayCandidates);
export const eventPointer = (id: string, author?: string, hints: string[] = []) => sharedEvent(id, author, hints, relayCandidates);
export const profilePointer = (pubkey: string, hints: string[] = []) => sharedProfile(pubkey, hints, relayCandidates);
