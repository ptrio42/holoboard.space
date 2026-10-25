import { expect, type Page } from "@playwright/test";

/** Model an overlaid keyboard without changing the layout viewport or font scale. */
export async function keyboardViewport(page: Page, height: number, offsetTop = 0) {
    await page.evaluate(({ height, offsetTop }) => {
        const viewport = window.visualViewport!;
        Object.defineProperties(viewport, {
            height: { configurable: true, value: height },
            offsetTop: { configurable: true, value: offsetTop },
        });
        viewport.dispatchEvent(new Event("resize"));
        viewport.dispatchEvent(new Event("scroll"));
    }, { height, offsetTop });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const close = page.getByRole("dialog").getByRole("button", { name: "Close dialog", exact: true });
    const bounds = (await close.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(offsetTop);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(offsetTop + height);
}
