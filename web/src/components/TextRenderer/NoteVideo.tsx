import { NoteVideo as Shared } from '@ptrio42/nostr-client/react';
import type { ComponentProps } from 'react';
import { HoloboardClient } from '../../lib/clientServices';
export function NoteVideo(props: ComponentProps<typeof Shared>) { return <HoloboardClient><Shared {...props} /></HoloboardClient>; }
