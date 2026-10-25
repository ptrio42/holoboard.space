import { expect, type Locator } from "@playwright/test";

/** Check the shell as well as its scrollable content, without moving focus. */
export async function expectModalChrome(dialog: Locator) {
    const geometry = await dialog.evaluate(element => ({
        panel: element.getBoundingClientRect().toJSON(),
        close: element.querySelector('[aria-label="Close dialog"]')!.getBoundingClientRect().toJSON(),
        top: visualViewport?.offsetTop ?? 0,
        bottom: (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? innerHeight),
    }));
    expect(geometry.panel.top).toBeGreaterThanOrEqual(geometry.top - 1);
    expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.bottom + 1);
    expect(geometry.close.top).toBeGreaterThanOrEqual(geometry.top - 1);
    expect(geometry.close.bottom).toBeLessThanOrEqual(geometry.bottom + 1);
    expect(geometry.close.width).toBeGreaterThanOrEqual(44);
    expect(geometry.close.height).toBeGreaterThanOrEqual(44);
}
