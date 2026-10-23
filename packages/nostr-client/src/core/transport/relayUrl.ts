/** Syntax validation only. Admission and configured local endpoints belong to the host. */
export function canonicalRelay(value: string): string | null {
  try {
    if (value.length > 2048) return null;
    const url = new URL(value);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}
export function safeRelay(value: string): string | null {
  const canonical = canonicalRelay(value);
  if (!canonical) return null;
  const url = new URL(canonical), host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'wss:' || url.port && url.port !== '443' || !host.includes('.') || host.includes(':') || /^[\d.]+$/.test(host) || /\.(local|internal|localhost)$/.test(host)) return null;
  return canonical;
}
export function relayCandidates(values: string[], limit = 12): string[] {
  return [...new Set(values.map(safeRelay).filter((url): url is string => !!url))].slice(0, limit);
}
