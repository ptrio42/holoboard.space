import { useEffect, useState } from "react";
import { PixelButton } from "./PixelButton";

interface CopyButtonProps {
    value: string;
    label?: string;
    size?: "sm" | "md";
}

export function CopyButton({ value, label = "Copy", size = "sm" }: CopyButtonProps) {
    const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

    useEffect(() => {
        if (state === "idle") return;
        const timer = window.setTimeout(() => setState("idle"), 1_800);
        return () => window.clearTimeout(timer);
    }, [state]);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(value);
            setState("copied");
        } catch {
            setState("failed");
        }
    };

    return (
        <PixelButton variant="ghost" size={size} onClick={copy}>
            <span aria-live="polite">
                {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
            </span>
        </PixelButton>
    );
}
