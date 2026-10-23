import { expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ClientProvider, NoteContent, NoteMediaGallery, NoteVideo, NoteMediaViewer, NoteEditor, createMediaPresentation, type ClientServices } from '../src/react/index';
const unavailable = { available: false as const, reason: 'Unavailable in this host.' };
function services(allowed: string[] = []): ClientServices {
  const reject = async () => { throw Error('Unavailable'); };
  return {
    policy: { generation: 0, mediaAllowed: url => allowed.includes(url), onChange: () => () => {} },
    connections: { getConnectedSigner: () => null, getConnections: () => ({ signerCanUpload: false }), subscribeConnections: () => () => {} },
    media: { available: false, servers: [], mediaUrl: () => { throw Error('Unavailable'); }, uploadMedia: reject, attachmentTags: () => [], gifSearchAvailable: () => false, searchComposerGifs: reject },
    profile: unavailable, quote: unavailable, linkPreview: unavailable,
    navigation: { useMediaViewerHistory: onClose => onClose }, presentation: createMediaPresentation(),
  };
}
const render = (view: ReturnType<typeof createElement>, allowed: string[] = []) => renderToStaticMarkup(createElement(ClientProvider, { services: services(allowed), children: view }));
test('an image-only note retains its safe clickable source without a preview or request', () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  try {
    const url = 'https://media.example/image-only.png';
    const html = render(createElement(NoteContent, { text: url, previewLinks: false }));
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain('Media preview unavailable');
    expect(html).not.toMatch(/<(?:img|video|link)\b/);
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
test('mixed admitted and denied gallery items retain source order and reject unsafe hrefs', () => {
  const allowed = 'https://media.example/allowed.png';
  const denied = ['https://media.example/denied.png', 'https://media.example/denied.mp4'];
  const html = render(createElement(NoteMediaGallery, { items: [
    { kind: 'image', src: allowed }, { kind: 'image', src: denied[0] },
    { kind: 'video', src: denied[1] }, { kind: 'image', src: 'javascript:alert(1)' },
  ] }), [allowed]);
  expect(html).toContain(`src="${allowed}"`);
  for (const url of denied) { expect(html).toContain(`href="${url}"`); expect(html).not.toContain(`src="${url}"`); }
  expect(html.indexOf(`href="${denied[0]}"`)).toBeLessThan(html.indexOf(`href="${denied[1]}"`));
  expect(html).not.toContain('javascript:');
});
test('tag-only imeta media remains an explicit link without introducing automatic embedding', () => {
  const url = 'https://media.example/tag-only-image';
  const html = render(createElement(NoteContent, { text: 'An attachment.', tags: [['imeta', `url ${url}`, 'm image/png']], previewLinks: false }));
  expect(html).toContain(`href="${url}"`);
  expect(html).not.toMatch(/<(?:img|video|link)\b/);
});

test('direct public video denies its source, poster and hidden probe during SSR', () => {
  const src = 'https://media.example/direct.mp4', poster = 'https://media.example/private-poster.png';
  const html = render(createElement(NoteVideo, { item: { kind: 'video', src, poster } }));
  expect(html).toContain(`href="${src}"`);
  expect(html).not.toMatch(/<(?:img|video|link)\b/);
  expect(html).not.toContain(poster);
  const posterOnly = render(createElement(NoteVideo, { item: { kind: 'video', src, poster } }), [poster]);
  expect(posterOnly).not.toMatch(/<(?:img|video|link)\b/);
});
test('direct public video admits the poster independently and rejects unsafe source syntax even under permissive policy', () => {
  const src = 'https://media.example/direct.mp4', poster = 'https://media.example/private-poster.png';
  const html = render(createElement(NoteVideo, { item: { kind: 'video', src, poster } }), [src]);
  expect(html).toContain('<video');
  expect(html).not.toContain(poster);
  expect(html).not.toMatch(/<(?:img|link)\b/);
  const unsafe = render(createElement(NoteVideo, { item: { kind: 'video', src: 'javascript:alert(1)', poster } }), ['javascript:alert(1)', poster]);
  expect(unsafe).not.toContain('javascript:');
  expect(unsafe).not.toMatch(/<(?:img|video|link)\b/);
  const unsafePoster = render(createElement(NoteVideo, { item: { kind: 'video', src, poster: 'javascript:alert(1)' } }), [src, 'javascript:alert(1)']);
  expect(unsafePoster).not.toContain('javascript:');
});
test('direct public viewer can render denied and unsafe items during SSR without browser globals or media requests', () => {
  const src = 'https://media.example/direct.png';
  const html = render(createElement(NoteMediaViewer, { items: [{ kind: 'image', src }, { kind: 'image', src: 'javascript:alert(1)' }], index: 0, onIndex: () => {}, onClose: () => {}, openerRef: { current: null } }));
  expect(html).toContain(`href="${src}"`);
  expect(html).not.toContain('javascript:');
  expect(html).not.toMatch(/<(?:img|video|link)\b/);
});
test('denied uploaded editor thumbnails never emit an empty src', () => {
  const html = render(createElement(NoteEditor, { text: 'Draft', attachments: [{ url: 'https://media.example/uploaded.png', type: 'image/png', alt: 'Uploaded image' }], onChange: () => {}, onAttachmentsChange: () => {}, onPendingChange: () => {}, onReview: () => {} }));
  expect(html).not.toContain('src=""');
  expect(html).not.toContain('<img');
});
