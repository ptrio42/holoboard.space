import { COMPOSER_FILE_LIMIT, attachmentTags,  type ComposerAttachment } from '../../src/core/content/composerMedia';
import type { ComposerGif } from '../../src/core/ports';
import type { FixturePolicy } from './policy';

export interface SimulatedMediaOptions { upload: ComposerAttachment; gifs: readonly ComposerGif[] }
const unavailable = 'Media providers are unavailable in this prototype until a local provider is bound.';
export function createHostMedia(policy: FixturePolicy, fixture?: SimulatedMediaOptions) {
  const mediaUrl = (url: string) => {
    if (!policy.mediaAllowed(url)) throw new Error('Only explicitly owned preview media is available.');
    return url;
  };
  if (fixture) {
    mediaUrl(fixture.upload.url);
    for (const gif of fixture.gifs) { mediaUrl(gif.url); mediaUrl(gif.preview); }
    fixture = structuredClone(fixture);
  }
  const server = { id: 'primal', name: fixture ? 'Fixture simulation' : 'Upload unavailable', protocol: 'blossom' as const,
    url: fixture ? new URL(fixture.upload.url).origin : '' };
  const upload: import("../../src/core/ports").MediaPort["uploadMedia"] = async (file, selected, _sign, signal, progress) => {
    if (!fixture) throw new Error(unavailable);
    if (selected.url !== server.url || selected.protocol !== server.protocol) throw new Error('Only the bound fixture simulation is available.');
    if (!file.size || file.size > COMPOSER_FILE_LIMIT) throw new Error('Choose a file between 1 byte and 20 MiB.');
    const generation = policy.generation;
    if (signal.aborted) throw new Error('Simulation cancelled.');
    progress(0); await Promise.resolve();
    if (signal.aborted || generation !== policy.generation) throw new Error('Simulation cancelled.');
    mediaUrl(fixture.upload.url); progress(100);
    return structuredClone(fixture.upload);
  };
  return {
    available: !!fixture, MEDIA_SERVERS: [server], uploadMedia: upload, mediaUrl,
    attachmentTags: (items: readonly ComposerAttachment[], content: string) => attachmentTags(items, content, mediaUrl),
    gifSearchAvailable: () => !!fixture,
    async searchComposerGifs(query: string, signal: AbortSignal): Promise<ComposerGif[]> {
      if (!fixture) throw new Error(unavailable);
      const generation = policy.generation;
      await Promise.resolve();
      if (signal.aborted || generation !== policy.generation) throw new Error('Simulation cancelled.');
      return fixture.gifs.filter(gif => gif.title.toLowerCase().includes(query.trim().toLowerCase().slice(0, 120)))
        .slice(0, 24).map(gif => ({ ...gif, url: mediaUrl(gif.url), preview: mediaUrl(gif.preview) }));
    },
  };
}
export type HostMedia = ReturnType<typeof createHostMedia>;
