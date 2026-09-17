import { useEffect, useRef, useState, type CSSProperties } from "react";
import { BILLBOARD_COLORS, type BillboardConfig } from "../../lib/billboard";

const SPEED = { slow: 24, normal: 40, fast: 60 };
const FONT_SIZE = { small: 1.1, medium: 1.5, large: 2 };

export function BillboardScreen({ config }: { config: BillboardConfig }) {
    const viewport = useRef<HTMLDivElement>(null);
    const text = useRef<HTMLSpanElement>(null);
    const pointerType = useRef("mouse");
    const [paused, setPaused] = useState(false);
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const [visible, setVisible] = useState(false);
    const [foreground, setForeground] = useState(() => document.visibilityState === "visible");
    const [failedImage, setFailedImage] = useState<string | null>(null);

    useEffect(() => {
        const element = viewport.current;
        const label = text.current;
        if (!element || !label) return;
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
        let stopped = false;
        let frame = 0;
        const fit = () => {
            if (stopped) return;
            if (!element.clientWidth) return;
            if (config.template === "neon" || reducedMotion.matches) {
                const style = getComputedStyle(element);
                const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
                const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
                const font = getComputedStyle(label);
                const maximumSize = FONT_SIZE[config.size] * parseFloat(getComputedStyle(document.documentElement).fontSize);
                // Offscreen descendants of size-query containers can report zero dimensions.
                // Measure an invisible copy outside those containers instead.
                const probe = document.createElement("span");
                probe.textContent = label.textContent;
                Object.assign(probe.style, {
                    position: "fixed", left: "-10000px", top: "0", visibility: "hidden",
                    width: `${width}px`, display: "block", whiteSpace: "normal", overflowWrap: "anywhere",
                    fontFamily: font.fontFamily, fontWeight: font.fontWeight, fontSize: `${maximumSize}px`,
                    lineHeight: String(parseFloat(font.lineHeight) / parseFloat(font.fontSize)), letterSpacing: "0.04em",
                });
                // The global reduced-motion rule otherwise transitions each font-size probe.
                probe.style.setProperty("transition", "none", "important");
                document.body.appendChild(probe);
                try {
                    let lower = 1;
                    let upper = maximumSize;
                    if (probe.offsetHeight <= height && probe.scrollWidth <= width) {
                        label.style.fontSize = `${maximumSize}px`;
                        return;
                    }
                    // The selected size is an upper bound for static text in the fixed display area.
                    for (let i = 0; i < 10; i++) {
                        const size = (lower + upper) / 2;
                        probe.style.fontSize = `${size}px`;
                        if (probe.offsetHeight <= height && probe.scrollWidth <= width) lower = size;
                        else upper = size;
                    }
                    label.style.fontSize = `${Math.floor(lower * 4) / 4}px`;
                } finally { probe.remove(); }
                return;
            }
            label.style.removeProperty("font-size");
            const width = element.clientWidth;
            const textWidth = label.getBoundingClientRect().width;
            element.style.setProperty("--travel-start", `${width}px`);
            element.style.setProperty("--travel-end", `${-textWidth}px`);
            element.style.setProperty("--travel-delay", `${-width / SPEED[config.speed]}s`);
            element.style.setProperty("--travel-duration", `${(width + textWidth) / SPEED[config.speed]}s`);
        };
        const measure = () => {
            if (stopped) return;
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(fit);
        };
        measure();
        // Observe the viewport only: fitting the label must not trigger another fitting pass.
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        reducedMotion.addEventListener("change", measure);
        void document.fonts.ready.then(measure);
        return () => { stopped = true; cancelAnimationFrame(frame); observer.disconnect(); reducedMotion.removeEventListener("change", measure); };
    }, [config.text, config.size, config.speed, config.template, visible]);

    useEffect(() => {
        const element = viewport.current;
        if (!element) return;
        const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
        observer.observe(element);
        const visibility = () => setForeground(document.visibilityState === "visible");
        document.addEventListener("visibilitychange", visibility);
        return () => { observer.disconnect(); document.removeEventListener("visibilitychange", visibility); };
    }, []);

    const style = {
        "--billboard-ink": BILLBOARD_COLORS[config.color],
        "--billboard-font-size": `${FONT_SIZE[config.size]}rem`,
        "--billboard-play": visible && foreground && !paused && !hovered && !focused ? "running" : "paused",
    } as CSSProperties;

    return (
        <div className={`billboard-screen billboard-screen--${config.template} billboard-screen--${config.size}`} style={style}
            role="button" tabIndex={0} aria-label={`Billboard: ${config.text}`} aria-pressed={paused}
            aria-description="Tap to pause or resume animation. Motion pauses on mouse hover or keyboard focus."
            onPointerEnter={(e) => { if (e.pointerType === "mouse") setHovered(true); }}
            onPointerLeave={(e) => { if (e.pointerType === "mouse") setHovered(false); }}
            onPointerDown={(e) => { pointerType.current = e.pointerType; }}
            onClick={(e) => { if (e.detail === 0 || pointerType.current !== "mouse") setPaused((value) => !value); }}
            onFocus={(e) => setFocused(e.currentTarget.matches(":focus-visible"))} onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPaused((value) => !value); }
            }}>
            {config.template === "image-led" && config.image && (
                <div className="billboard-screen__image">
                    {failedImage === config.image
                        ? <span className="text-xs text-cyan-100/60">Image unavailable</span>
                        : <img src={config.image} alt="Image from the promoted note" loading="lazy" decoding="async"
                            onError={() => setFailedImage(config.image ?? null)} />}
                </div>
            )}
            <div ref={viewport} className="billboard-screen__viewport">
                <span ref={text} className="billboard-screen__text">{config.text.replace(/\s+/g, " ")}</span>
            </div>
        </div>
    );
}
