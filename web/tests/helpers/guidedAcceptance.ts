import { expect, type Page, type TestInfo } from "@playwright/test";
import jsQR from "jsqr";
import { PNG } from "pngjs";

export const shortContribution = "A community meetup this Saturday. Details: https://example.com/story";
export const longContribution = `${shortContribution}\n\n${"Bring a project, meet other makers and share what you learned. Everyone can join the conversation and ask questions. ".repeat(18)}`;
export const guidedViewports = [320, 390, 768, 1280].flatMap(width => [{ width, height: 844 }, { width, height: 560 }]);

/** Capture the settled frame before locators or QR decoding can scroll it. */
export async function captureGuidedStage(page: Page, info: TestInfo, stage: string, viewport: { width: number; height: number }) {
    await page.setViewportSize(viewport);
    const dialog = page.getByRole("dialog", { name: "Add to board", exact: true });
    await expect(dialog).toHaveCount(1);
    const body = dialog.locator("[data-modal-body]");
    await expect(body).toHaveCount(1);
    const progress = dialog.getByRole("navigation", { name: "Add to board progress", exact: true });
    if (stage === "appearance") {
        await expect(progress).toHaveCount(0);
        await expect(dialog.getByRole("heading", { name: "Billboard appearance", exact: true })).toHaveCount(1);
    } else {
        await expect(progress.locator("li")).toHaveCount(3);
        await expect(progress.locator('[aria-current="step"]')).toContainText(stage[0].toUpperCase() + stage.slice(1));
    }
    const close = dialog.getByRole("button", { name: "Close dialog", exact: true });
    await expect(close).toHaveCount(1);
    if (stage !== "payment") await body.evaluate(element => { element.scrollTop = 0; });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
    const shell = await dialog.evaluate(element => ({ bottom: element.getBoundingClientRect().bottom, height: innerHeight, viewportHeight: visualViewport?.height,
        maxHeight: (element as HTMLElement).style.maxHeight, computedMax: getComputedStyle(element).maxHeight, overlayPadding: getComputedStyle(element.parentElement!).padding,
        overlayStyle: (element.parentElement as HTMLElement).style.cssText, classes: element.className }));
    if (shell.bottom > viewport.height + 1) await info.attach("overflow-shell", { contentType: "application/json", body: JSON.stringify(shell) });
    expect(shell, JSON.stringify(shell)).toMatchObject({ height: viewport.height });
    expect(shell.bottom, JSON.stringify(shell)).toBeLessThanOrEqual(viewport.height + 1);
    await page.screenshot({ path: info.outputPath(`${stage}-${viewport.width}x${viewport.height}.png`) });
    const measured = await dialog.evaluate((element, stage) => {
        const body = element.querySelector<HTMLElement>("[data-modal-body]")!;
        const rect = (target: Element | null) => target?.getBoundingClientRect().toJSON() ?? null;
        const field = element.querySelector<HTMLTextAreaElement>("textarea");
        const fieldStyle = field && getComputedStyle(field);
        const footer = body.nextElementSibling!;
        const visibleBottom = body.getBoundingClientRect().bottom;
        const choices = [...body.querySelectorAll<HTMLElement>("button, summary, input, select, a[href]")].filter(target => target.getClientRects().length && !target.closest("[hidden]"));
        // Alpha-composite text and ancestor backgrounds using actual computed colors.
        const rgba = (color: string) => {
            const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
            const context = canvas.getContext("2d", { willReadFrequently: true })!; context.fillStyle = color; context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data].map((value, index) => index === 3 ? value / 255 : value);
        };
        const over = (foreground: number[], background: number[]) => {
            const alpha = foreground[3] + background[3] * (1 - foreground[3]);
            return foreground.slice(0, 3).map((channel, index) => alpha ? (channel * foreground[3] + background[index] * background[3] * (1 - foreground[3])) / alpha : 0).concat(alpha);
        };
        const luminance = (color: number[]) => color.slice(0, 3).map(channel => { const s = channel / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
        // Sample leaf text, avoiding a container color standing in for its children.
        // This excludes image/gradient backgrounds and is not a whole-page audit.
        const contrast = [...element.querySelectorAll<HTMLElement>("h2, h3, p, button, summary, span, a")].filter(target => target.getClientRects().length && target.childElementCount === 0 && parseFloat(getComputedStyle(target).fontSize) > 0 && target.textContent?.trim() && !target.closest("[hidden]")).map(target => {
            const style = getComputedStyle(target);
            let background = rgba(style.backgroundColor), foreground = over(rgba(style.color), background);
            let gradients = false;
            for (let ancestor: HTMLElement | null = target; ancestor; ancestor = ancestor.parentElement) {
                const ancestorStyle = getComputedStyle(ancestor);
                gradients ||= ancestorStyle.backgroundImage !== "none";
                foreground[3] *= Number(ancestorStyle.opacity); background[3] *= Number(ancestorStyle.opacity);
                const behind = ancestor.parentElement ? rgba(getComputedStyle(ancestor.parentElement).backgroundColor) : [0, 0, 0, 1];
                foreground = over(foreground, behind); background = over(background, behind);
            }
            foreground = over(foreground, [0, 0, 0, 1]); background = over(background, [0, 0, 0, 1]);
            const a = luminance(foreground), b = luminance(background);
            return { label: target.textContent!.trim().slice(0, 90), fontSize: style.fontSize, fontFamily: style.fontFamily, color: style.color, background, ratio: gradients ? null : (Math.max(a, b) + .05) / (Math.min(a, b) + .05), disabled: !!target.closest(":disabled"), gradients };
        });
        return { stage, viewport: { width: innerWidth, height: innerHeight }, dialog: rect(element), header: rect(body.previousElementSibling?.previousElementSibling ?? null), navigation: rect(body.previousElementSibling), body: rect(body), footer: rect(footer),
            bodyScrollHeight: body.scrollHeight, bodyScrollTop: body.scrollTop, scrollingRequired: Math.max(0, body.scrollHeight - body.clientHeight),
            editableFontSize: fieldStyle?.fontSize, usableTextWidth: field && fieldStyle ? field.clientWidth - parseFloat(fieldStyle.paddingLeft) - parseFloat(fieldStyle.paddingRight) : null,
            choices: choices.map(target => ({ label: target.getAttribute("aria-label") || target.textContent?.trim().slice(0, 90), rect: rect(target), scrollToFullyReveal: Math.max(0, target.getBoundingClientRect().bottom - visibleBottom) })),
            hits: [...element.querySelectorAll<HTMLElement>("button, summary, input, select, a[href]")].filter(target => target.getClientRects().length && !target.closest("[hidden]")).map(target => ({ label: target.getAttribute("aria-label") || target.textContent?.trim().slice(0, 90), rect: rect(target), disabled: target.matches(":disabled") })),
            contrast, horizontalOverflow: element.scrollWidth > element.clientWidth || document.documentElement.scrollWidth > innerWidth };
    }, stage);
    await info.attach(`${stage}-${viewport.width}x${viewport.height}-geometry`, { contentType: "application/json", body: JSON.stringify(measured) });
    expect(measured.horizontalOverflow).toBe(false);
    expect(measured.dialog!.top).toBeGreaterThanOrEqual(-1);
    expect(measured.footer!.bottom).toBeLessThanOrEqual(viewport.height + 1);
    const closeBox = await close.boundingBox();
    expect(closeBox!.width).toBeGreaterThanOrEqual(44); expect(closeBox!.height).toBeGreaterThanOrEqual(44);
    const footerActions = dialog.locator("[data-modal-body] + div").getByRole("button");
    await expect(footerActions).toHaveCount(stage === "post" ? 2 : 3);
    for (const action of await footerActions.all()) {
        const box = (await action.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    }
    if (stage === "payment") {
        const qr = dialog.getByRole("img", { name: "Holoboard visibility invoice QR code", exact: true });
        await expect(qr).toHaveCount(1);
        const initialScroll = await body.evaluate(element => element.scrollTop);
        await qr.scrollIntoViewIfNeeded();
        const code = (await qr.boundingBox())!, visible = (await body.boundingBox())!;
        expect.soft(code.y, `${viewport.width}x${viewport.height}: QR top`).toBeGreaterThanOrEqual(visible.y - 1);
        expect.soft(code.y + code.height, `${viewport.width}x${viewport.height}: QR bottom`).toBeLessThanOrEqual(visible.y + visible.height + 1);
        const raster = PNG.sync.read(await qr.screenshot());
        const decoded = jsQR(new Uint8ClampedArray(raster.data), raster.width, raster.height)?.data;
        const invoice = (await dialog.getByRole("link", { name: "Open in wallet", exact: true }).getAttribute("href"))!.slice("lightning:".length);
        expect(decoded?.toLowerCase()).toBe(invoice.toLowerCase());
        await page.screenshot({ path: info.outputPath(`payment-full-qr-${viewport.width}x${viewport.height}.png`) });
        Object.assign(measured, { qr: code, qrManualScroll: (await body.evaluate(element => element.scrollTop)) - initialScroll });
    }
    return measured;
}
