import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('..', import.meta.url));
const archive = path.resolve(process.argv[2]);
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'nostr-client-packed-'));
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const info = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
await fs.mkdir(path.join(fixture, 'vendor'));
const body = await fs.readFile(archive);
await fs.writeFile(path.join(fixture, 'vendor/client.tgz'), body);
const dependencies = { '@ptrio42/nostr-client': 'file:vendor/client.tgz', react: info.devDependencies.react, 'react-dom': info.devDependencies['react-dom'] };
const devDependencies = { vite: info.devDependencies.vite, typescript: info.devDependencies.typescript, '@types/react': info.devDependencies['@types/react'], '@types/react-dom': info.devDependencies['@types/react-dom'] };
const packages = { ...lock.packages, '': { name: 'packed-client-consumer', version: '1.0.0', dependencies, devDependencies } };
packages['node_modules/@ptrio42/nostr-client'] = { version: info.version, resolved: 'file:vendor/client.tgz', integrity: 'sha512-' + createHash('sha512').update(body).digest('base64'), dependencies: info.dependencies, peerDependencies: info.peerDependencies, license: info.license };
await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'packed-client-consumer', version: '1.0.0', private: true, type: 'module', dependencies, devDependencies }));
await fs.writeFile(path.join(fixture, 'package-lock.json'), JSON.stringify({ ...lock, name: 'packed-client-consumer', version: '1.0.0', packages }));
const writableCache = path.join(fixture, '.npm-cache');
const priorCache = execFileSync('npm', ['config', 'get', 'cache'], { encoding: 'utf8' }).trim();
let cached = 0;
for (const entry of Object.values(packages)) {
  if (!entry.integrity || !entry.integrity.startsWith('sha512-')) continue;
  const digest = Buffer.from(entry.integrity.slice(7), 'base64').toString('hex');
  const content = path.join('_cacache/content-v2/sha512', digest.slice(0, 2), digest.slice(2, 4), digest.slice(4));
  try { await fs.mkdir(path.dirname(path.join(writableCache, content)), { recursive: true }); await fs.copyFile(path.join(priorCache, content), path.join(writableCache, content)); cached++; } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
}
console.log('Read-only npm cache seed:', cached, 'locked archives');
execFileSync('npm', ['ci', '--offline', '--ignore-scripts', '--legacy-peer-deps', '--cache', writableCache], { cwd: fixture, stdio: 'pipe' });
// Prove the core import has no React runtime dependency, even in a mixed consumer.
await fs.rename(path.join(fixture, 'node_modules/react'), path.join(fixture, 'node_modules/react-hidden'));
try {
  execFileSync(process.execPath, ['--input-type=module', '-e', "const core = await import('@ptrio42/nostr-client/core'); if (typeof core.createPublicReadTransport !== 'function') throw Error('Missing anonymous read factory'); console.log('Packed core imports without React');"], { cwd: fixture, stdio: 'inherit' });
} finally { await fs.rename(path.join(fixture, 'node_modules/react-hidden'), path.join(fixture, 'node_modules/react')); }
await fs.writeFile(path.join(fixture, 'index.html'), '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/main.tsx"></script>');
await fs.writeFile(path.join(fixture, 'main.tsx'), `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ClientProvider, NoteEditor, NoteContent, createMediaPresentation, type ClientServices } from '@ptrio42/nostr-client/react';
import type { ComposerAttachment } from '@ptrio42/nostr-client/core';
import '@ptrio42/nostr-client/styles.css';
import './theme.css';
const unavailable = { available: false as const, reason: 'Optional reads unavailable.' };
const ownedImage = location.origin + '/sample.png';
let mediaEnabled = false, policyGeneration = 0;
const policyListeners = new Set<() => void>();
Object.assign(window, { fixtureSetMedia(value: boolean) { mediaEnabled = value; policyGeneration++; policyListeners.forEach(listener => listener()); }, fixtureReviews: 0 });
const reject = async () => { throw Error('Media unavailable.'); };
const services: ClientServices = {
 policy: { get generation() { return policyGeneration; }, mediaAllowed: url => mediaEnabled && url === ownedImage, onChange: listener => { policyListeners.add(listener); return () => { policyListeners.delete(listener); }; } },
 connections: { getConnectedSigner: () => null, getConnections: () => ({ signerCanUpload: false }), subscribeConnections: () => () => {} },
 media: { available: false, servers: [], mediaUrl: () => { throw Error('Media unavailable.'); }, uploadMedia: reject, attachmentTags: () => [], gifSearchAvailable: () => false, searchComposerGifs: reject },
 profile: unavailable, quote: unavailable, linkPreview: unavailable,
 navigation: { useMediaViewerHistory: onClose => onClose }, presentation: createMediaPresentation(),
};
function App() {
 const [text, setText] = useState('A public draft from the packed client.');
 const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
 return <main className={location.search.includes('alternate') ? 'alternate' : 'default'}><h1>Independent host</h1><ClientProvider services={services}>
  <div className="p-4 text-sm" data-utility>Scoped defaults</div>
  <section data-media-case="image-only"><NoteContent text="https://media.example/image-only.png" previewLinks={false} /></section>
  <section data-media-case="mixed"><NoteContent text={ownedImage + ' https://media.example/denied.mp4'} previewLinks={false} /></section>
  <section data-media-case="tag-only"><NoteContent text="Tagged attachment" tags={[["imeta", "url https://media.example/tag-only-image", "m image/png"]]} previewLinks={false} /></section>
  <NoteContent text={text} initiallyExpanded previewLinks={false} />
  <NoteEditor text={text} attachments={attachments} onChange={setText} onAttachmentsChange={setAttachments} onPendingChange={() => {}} onReview={() => { (window as any).fixtureReviews++; }} textLabel="Note text" placeholder="Write a note..." toolbarLabel="Add to note" />
 </ClientProvider><span className="hidden sm:inline" data-host-responsive>Host responsive label</span></main>;
}
createRoot(document.getElementById('root')!).render(<App />);
`);
await fs.writeFile(path.join(fixture, 'theme.css'), `
.default { --nostr-font-label: monospace; --nostr-accent: rgb(24, 90, 140); --nostr-panel: rgb(250, 250, 245); --nostr-background: white; }
.alternate { --nostr-font-label: serif; --nostr-accent: rgb(180, 30, 80); --nostr-panel: rgb(245, 235, 240); --nostr-background: rgb(255, 250, 252); }
@layer utilities { .hidden { display: none; } @media(min-width:640px) { .sm\\:inline { display: inline; } } }
main { max-width: 44rem; margin: auto; }
`);
await fs.mkdir(path.join(fixture, 'public'));
await fs.writeFile(path.join(fixture, 'public/sample.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
await fs.writeFile(path.join(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, skipLibCheck: true, noEmit: true }, include: ['main.tsx'] }));
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], { cwd: fixture, stdio: 'inherit' });
execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { cwd: fixture, stdio: 'inherit' });
console.log(JSON.stringify({ fixture, archive, integrity: packages['node_modules/@ptrio42/nostr-client'].integrity }));
