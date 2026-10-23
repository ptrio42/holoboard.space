import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import postcss from 'postcss';
const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(root, 'src');
const dist = path.join(root, 'dist');
async function files(dir) {
  return (await fs.readdir(dir, { withFileTypes: true })).flatMap(e => e.isDirectory() ? [] : [path.join(dir, e.name)]).concat(...await Promise.all((await fs.readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => files(path.join(dir, e.name)))));
}
const scanner = new Scanner({ sources: [{ base: source, pattern: '**/*.{ts,tsx}', negated: false }] });
const utilities = await compile('@import "tailwindcss/theme.css" reference; @import "tailwindcss/utilities.css"; @theme reference { --font-pixel: ui-monospace; --font-body: ui-monospace; --color-void: #05010d; --color-panel: #0a0518; --color-neon-cyan: #22d3ee; --color-neon-pink: #ec4899; --color-neon-gold: #fbbf24; --animate-pixel-pulse: nostr-pixel-pulse 1.1s steps(2, end) infinite; }', { base: root, onDependency() {} });
let css = await fs.readFile(path.join(source, 'styles.css'), 'utf8');
for (const file of await files(source)) if (file.endsWith('.css') && !file.endsWith('/styles.css')) css += '\n' + await fs.readFile(file, 'utf8');
css += '\n' + await fs.readFile(fileURLToPath(import.meta.resolve('yet-another-react-lightbox/styles.css')), 'utf8');
const utilityRoot = postcss.parse(utilities.build(scanner.scan()));
utilityRoot.walkRules(rule => {
  if (rule.parent.type === 'atrule' && rule.parent.name.endsWith('keyframes') || rule.selector.startsWith('&') || rule.parent.type === 'rule') return;
  rule.selectors = rule.selectors.flatMap(selector => [':where(.nostr-client) :where(' + selector + ')', ...(selector.startsWith('.') ? [':where(.nostr-client' + selector + ')'] : [])]);
});
const utilityLayer = postcss.atRule({ name: 'layer', params: 'utilities' });
utilityLayer.append(utilityRoot.nodes);
css += '\n' + utilityLayer.toString();
// Reference themes generate utilities without global resets. Materialize only
// their referenced defaults on the component scope for non-Tailwind consumers.
const theme = postcss.parse(await fs.readFile(fileURLToPath(import.meta.resolve('tailwindcss/theme.css')), 'utf8'));
const defaults = new Map();
theme.walkDecls(decl => defaults.set(decl.prop, decl.value));
const requested = new Set([...css.matchAll(/var\((--[a-zA-Z0-9_-]+)/g)].map(match => match[1]));
const scopedDefaults = postcss.rule({ selector: ':where(.nostr-client)' });
for (const name of requested) if (defaults.has(name)) scopedDefaults.append({ prop: name, value: defaults.get(name) });
const parsed = postcss.parse(css);
parsed.walkAtRules('property', rule => {
  const initial = rule.nodes?.find(node => node.type === 'decl' && node.prop === 'initial-value');
  if (initial) scopedDefaults.append({ prop: rule.params, value: initial.value });
});
parsed.prepend(scopedDefaults);

parsed.walkRules(rule => {
  if (rule.parent.type === 'atrule' && rule.parent.name.endsWith('keyframes')) return;
  // Nested utilities already inherit their parent's scope.
  if (rule.selector.startsWith('&') || rule.parent.type === 'rule') return;
  rule.selectors = rule.selectors.map(selector => selector.startsWith('.nostr-client') || selector.startsWith(':where(.nostr-client') ? selector : ':where(.nostr-client) ' + selector);
});
parsed.walkAtRules(rule => { if (rule.name === 'property') rule.remove(); });
await fs.writeFile(path.join(dist, 'styles.css'), parsed.toString());
for (const file of await files(dist)) if (/\.(js|d\.ts)$/.test(file)) {
  let text = await fs.readFile(file, 'utf8');
  text = text.replace(/^import\s+["'][^"']+\.css["'];?\s*$/gm, '');
  text = text.replace(/((?:from\s*|import\s*\()?["'])(\.{1,2}\/[^"']+)(["'])/g, (all, before, spec, after) => /\.(js|css)$/.test(spec) ? all : before + spec + '.js' + after);
  await fs.writeFile(file, text);
}
