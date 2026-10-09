import qrcode from "qrcode-generator";
import holoboardMark from "../assets/holoboard-mark.svg";

export type QrMatrix = boolean[][];
export interface QrBadge { x: number; y: number; size: number }
export interface QrSymbol { matrix: QrMatrix; badge: QrBadge | null; image?: string }

const LIGHT = "#e0fbff", DARK = "#05010d";
const QUIET = 4;
let markImage: Promise<HTMLImageElement> | undefined;

function encode(value: string, correction: "M" | "H") {
    const invoice = /^ln(?:bc|tb|bcrt)[0-9a-z]+$/i.test(value);
    const payload = invoice ? value.toUpperCase() : value;
    const qr = qrcode(0, correction);
    qr.addData(payload, invoice ? "Alphanumeric" : "Byte");
    qr.make();
    const count = qr.getModuleCount();
    return { payload, matrix: Array.from({ length: count }, (_, y) => Array.from({ length: count }, (_, x) => qr.isDark(y, x))) };
}

/** Leave finder, timing, format, version and alignment patterns unobscured. */
export function findQrBadge(matrix: QrMatrix): QrBadge | null {
    const count = matrix.length;
    const protectedCells = new Set<number>();
    const reserve = (x: number, y: number, width: number, height: number) => {
        for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) protectedCells.add(row * count + col);
    };
    reserve(0, 0, 9, 9);
    reserve(count - 11, 0, 11, 9);
    reserve(0, count - 11, 9, 11);
    reserve(6, 0, 1, count); reserve(0, 6, count, 1);
    // The encoder writes each alignment pattern as a complete 5 by 5 target.
    // Recognizing it in the actual matrix also keeps any coincidental data target clear.
    for (let y = 2; y < count - 2; y++) for (let x = 2; x < count - 2; x++) {
        let alignment = true;
        for (let dy = -2; dy <= 2 && alignment; dy++) for (let dx = -2; dx <= 2; dx++) {
            const dark = Math.abs(dx) === 2 || Math.abs(dy) === 2 || (dx === 0 && dy === 0);
            if (matrix[y + dy][x + dx] !== dark) { alignment = false; break; }
        }
        if (alignment) reserve(x - 2, y - 2, 5, 5);
    }
    const edge = Math.floor(count * 0.12);
    const size = Math.max(5, edge - (edge % 2 === 0 ? 1 : 0));
    const middle = (count - size) / 2;
    const reach = Math.ceil(count * 0.15);
    const candidates: { x: number; y: number; distance: number }[] = [];
    for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
        const x = middle + dx, y = middle + dy;
        if (x >= 0 && y >= 0 && x + size <= count && y + size <= count) candidates.push({ x, y, distance: dx * dx + dy * dy });
    }
    candidates.sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
    for (const { x, y } of candidates) {
        let clear = true;
        for (let row = y; row < y + size && clear; row++) for (let col = x; col < x + size; col++) {
            if (protectedCells.has(row * count + col)) { clear = false; break; }
        }
        if (clear) return { x, y, size };
    }
    return null;
}

function loadMark() {
    return markImage ??= new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        const cleanup = () => { clearTimeout(timeout); image.onload = null; image.onerror = null; };
        const fail = () => {
            cleanup(); markImage = undefined; image.src = "";
            reject(new Error("Could not load the QR mark"));
        };
        const timeout = setTimeout(fail, 2000);
        image.onload = () => { cleanup(); resolve(image); };
        image.onerror = fail;
        image.src = holoboardMark;
    });
}

/** Branding is optional; retain the previous M encoder when it cannot be verified. */
async function brandedSymbol(value: string, size: number): Promise<QrSymbol | null> {
    const { matrix, payload } = encode(value, "H");
    // A conservative UI budget, not a guarantee about physical cameras.
    // Check signer QRs at the ordinary invoice size as well as their larger display.
    const pixels = Math.min(size, 220);
    if (pixels / (matrix.length + QUIET * 2) < 2) return null;
    const badge = findQrBadge(matrix);
    if (!badge) return null;
    const [mark, { default: decode }] = await Promise.all([loadMark(), import("jsqr")]);
    const deviceScale = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    let image: string | undefined;
    for (const pixels of new Set([Math.min(size, 220), size, Math.round(size * deviceScale)])) {
        const canvas = document.createElement("canvas");
        canvas.width = pixels; canvas.height = pixels;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return null;
        const scale = pixels / (matrix.length + QUIET * 2);
        const rectangle = (x: number, y: number, width: number, height: number, fill: string) => {
            context.fillStyle = fill;
            context.fillRect(Math.round(x * scale), Math.round(y * scale), Math.round((x + width) * scale) - Math.round(x * scale), Math.round((y + height) * scale) - Math.round(y * scale));
        };
        rectangle(0, 0, matrix.length + QUIET * 2, matrix.length + QUIET * 2, LIGHT);
        matrix.forEach((row, y) => row.forEach((dark, x) => { if (dark) rectangle(x + QUIET, y + QUIET, 1, 1, DARK); }));
        rectangle(badge.x + QUIET, badge.y + QUIET, badge.size, badge.size, LIGHT);
        context.imageSmoothingEnabled = false;
        context.drawImage(mark, (badge.x + QUIET + 1) * scale, (badge.y + QUIET + 1) * scale, (badge.size - 2) * scale, (badge.size - 2) * scale);
        if (decode(context.getImageData(0, 0, pixels, pixels).data, pixels, pixels)?.data !== payload) return null;
        image = canvas.toDataURL("image/png");
    }
    // Display the pixels we actually checked. SVG and canvas edges differ in WebKit.
    return { matrix, badge, image };
}

export async function createQrSymbol(value: string, size: number): Promise<QrSymbol> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        const branded = await Promise.race([
            brandedSymbol(value, size),
            new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 3000); }),
        ]);
        if (branded) return branded;
    } catch { /* Keep branding failures separate from encoding the payment or pairing data. */ }
    finally { clearTimeout(timeout); }
    return { matrix: encode(value, "M").matrix, badge: null };
}
