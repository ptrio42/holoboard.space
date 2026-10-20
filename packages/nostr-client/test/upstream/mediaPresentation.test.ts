import { afterEach, expect, it, vi } from "vitest";
import { createMediaPresentation } from "../../src/react/content/mediaPresentation";
const { knownMedia, rememberMedia } = createMediaPresentation();
afterEach(() => vi.useRealTimers());
it("expires failures before learned geometry and playback, then expires the whole presentation", () => {
    vi.useFakeTimers();
    const src = "https://media.example/expiring.mp4";
    rememberMedia(src, { width: 900, height: 1600, time: 5, failed: true });
    vi.advanceTimersByTime(60_001);
    expect(knownMedia(src)).toMatchObject({ width: 900, height: 1600, time: 5, failed: false });
    vi.advanceTimersByTime(30 * 60_000);
    expect(knownMedia(src)).toBeUndefined();
});
it("bounds exact-source entries and rejects nonfinite playback positions", () => {
    const original = "https://media.example/first.mp4?signature=one";
    rememberMedia(original, { width: 800, height: 600, time: 12 });
    expect(knownMedia(original + "&changed")).toBeUndefined();
    rememberMedia(original, { time: NaN });
    expect(knownMedia(original)?.time).toBeUndefined();
    for (let index = 0; index < 512; index++) rememberMedia(`https://media.example/${index}.png`, { width: 1, height: 1 });
    expect(knownMedia(original)).toBeUndefined();
    expect(knownMedia("https://media.example/511.png")).toMatchObject({ width: 1, height: 1 });
});
