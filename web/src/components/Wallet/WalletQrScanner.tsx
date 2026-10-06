import { useEffect, useRef, useState } from "react";
import { PixelButton } from "../ui/PixelButton";

export function WalletQrScanner({ onScan, disabled }: { onScan: (value: string) => void; disabled: boolean }) {
    const [active, setActive] = useState(false);
    const [error, setError] = useState("");
    const video = useRef<HTMLVideoElement>(null);
    const file = useRef<HTMLInputElement>(null);
    const scanned = useRef(onScan);
    useEffect(() => { scanned.current = onScan; }, [onScan]);
    useEffect(() => {
        if (!active || disabled) return;
        let stopped = false;
        let stream: MediaStream | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const start = async () => {
            try {
                if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera unavailable");
                stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
                if (stopped) { stream.getTracks().forEach((track) => track.stop()); return; }
                const element = video.current;
                if (!element) return;
                element.srcObject = stream;
                await element.play();
                const { default: jsQR } = await import("jsqr");
                const canvas = document.createElement("canvas");
                const context = canvas.getContext("2d", { willReadFrequently: true });
                if (!context) throw new Error("Camera unavailable");
                const scan = () => {
                    if (stopped) return;
                    if (element.readyState >= 2 && element.videoWidth) {
                        const scale = Math.min(1, 960 / element.videoWidth);
                        canvas.width = Math.round(element.videoWidth * scale);
                        canvas.height = Math.round(element.videoHeight * scale);
                        context.drawImage(element, 0, 0, canvas.width, canvas.height);
                        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
                        const qr = jsQR(pixels.data, pixels.width, pixels.height);
                        if (qr) { scanned.current(qr.data); setActive(false); return; }
                    }
                    timer = setTimeout(scan, 250);
                };
                scan();
            } catch {
                if (!stopped) { setError("Could not open the camera. Allow camera access, choose a QR image, or paste the payment details."); setActive(false); }
            }
        };
        void start();
        return () => {
            stopped = true; clearTimeout(timer);
            stream?.getTracks().forEach((track) => track.stop());
        };
    }, [active, disabled]);

    const scanImage = async (image: File) => {
        setError("");
        const url = URL.createObjectURL(image);
        try {
            const element = new Image();
            element.src = url;
            await element.decode();
            const canvas = document.createElement("canvas");
            const scale = Math.min(1, 1800 / Math.max(element.width, element.height));
            canvas.width = Math.round(element.width * scale); canvas.height = Math.round(element.height * scale);
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context) throw new Error("Image unavailable");
            context.drawImage(element, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
            const { default: jsQR } = await import("jsqr");
            const qr = jsQR(pixels.data, pixels.width, pixels.height);
            if (!qr) throw new Error("No QR code");
            scanned.current(qr.data);
        } catch { setError("Could not read a QR code from this image."); }
        finally { URL.revokeObjectURL(url); }
    };
    return <div className="space-y-3">
        <div className="flex flex-wrap gap-3">
            <PixelButton size="sm" variant="ghost" disabled={disabled} onClick={() => { setError(""); setActive(!active); }}>{active ? "Stop camera" : "Scan QR"}</PixelButton>
            <PixelButton size="sm" variant="ghost" disabled={disabled} onClick={() => file.current?.click()}>QR image</PixelButton>
            <input ref={file} type="file" accept="image/*" className="hidden" aria-label="Payment QR image" onChange={(event) => { const image = event.target.files?.[0]; event.target.value = ""; if (image) void scanImage(image); }} />
        </div>
        {active && !disabled && <video ref={video} muted playsInline aria-label="Payment QR camera" className="w-full border border-cyan-400/40 bg-void" />}
        {error && <p role="alert" className="text-xs text-neon-pink">{error}</p>}
    </div>;
}
