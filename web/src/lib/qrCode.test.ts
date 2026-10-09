import { expect, it } from "vitest";
import qrcode from "qrcode-generator";
import { findQrBadge } from "./qrCode";

for (const [version, centers] of [[1, []], [7, [6, 22, 38]], [21, [6, 28, 50, 72, 94]]] as const) {
    it(`keeps QR version ${version} tracking and alignment targets outside the badge`, () => {
        const qr = qrcode(version, "H");
        qr.addData("Holo"); qr.make();
        const count = qr.getModuleCount();
        const matrix = Array.from({ length: count }, (_, y) => Array.from({ length: count }, (_, x) => qr.isDark(y, x)));
        const badge = findQrBadge(matrix);
        expect(badge).not.toBeNull();
        if (!badge) throw new Error("Expected a safe badge position");
        expect(badge.x).toBeGreaterThan(8); expect(badge.y).toBeGreaterThan(8);
        expect(badge.x + badge.size).toBeLessThan(count);
        expect(badge.y + badge.size).toBeLessThan(count);
        for (const x of centers) for (const y of centers) {
            const overlaps = badge.x < x + 3 && badge.x + badge.size > x - 2 && badge.y < y + 3 && badge.y + badge.size > y - 2;
            expect(overlaps, `Badge intersects alignment target ${x},${y}`).toBe(false);
        }
    });
}
