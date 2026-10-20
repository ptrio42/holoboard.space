import { useClient, type ProfileLinkProps, type QuoteProps, type LinkPreviewProps } from './ClientProvider';
import type { RefObject } from 'react';
export function useProfileValue(pubkey?: string, hints?: string[]) {
  const capability = useClient().profile;
  return capability.available ? capability.value.useProfileValue(pubkey, hints) : undefined;
}
export function ProfileLink(props: ProfileLinkProps) {
  const capability = useClient().profile;
  if (!capability.available) return <span className={props.className} title={capability.reason}>{props.children}</span>;
  const Link = capability.value.Link;
  return <Link {...props} />;
}
export function NoteQuote(props: QuoteProps) {
  const capability = useClient().quote;
  if (!capability.available) return <aside className="note-quote" role="status">{capability.reason}</aside>;
  const Quote = capability.value;
  return <Quote {...props} />;
}
export function NoteLinkPreview(props: LinkPreviewProps) {
  const capability = useClient().linkPreview;
  if (!capability.available) return <span role="status">{capability.reason}</span>;
  const Preview = capability.value;
  return <Preview {...props} />;
}
export function useMediaViewerHistory(onClose: () => void, opener: RefObject<HTMLElement | null>) {
  return useClient().navigation.useMediaViewerHistory(onClose, opener);
}
