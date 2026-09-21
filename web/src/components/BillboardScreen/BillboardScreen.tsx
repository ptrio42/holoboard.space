import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { nip19 } from "@nostr-dev-kit/ndk";
import { BILLBOARD_COLORS, completeNostrReference, type BillboardConfig } from "../../lib/billboard";
import { parseContent, type ContentToken } from "../../utils/textProcessing/parseContent";
import { NostrMention } from "../TextRenderer/NostrMention";

const SPEED = { slow: 24, normal: 40, fast: 60 };
const FONT_SIZE = { small: 1.1, medium: 1.5, large: 2 };

const motionQuery = "(prefers-reduced-motion: reduce)";
const subscribeMotion = (callback: () => void) => {
    const query = window.matchMedia(motionQuery);
    query.addEventListener("change", callback);
    return () => query.removeEventListener("change", callback);
};

export function BillboardScreen({ config, initialSlide = 0, sourceContent = "" }: { config: BillboardConfig; initialSlide?: number; sourceContent?: string }) {
    return <BillboardDisplay key={`${initialSlide}:${JSON.stringify(config)}`} config={config} initialSlide={initialSlide} sourceContent={sourceContent} />;
}

function BillboardDisplay({ config, initialSlide, sourceContent }: { config: BillboardConfig; initialSlide: number; sourceContent: string }) {
    const viewport = useRef<HTMLDivElement>(null);
    const text = useRef<HTMLSpanElement>(null);
    const pointerType = useRef("mouse");
    const [paused, setPaused] = useState(false);
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const [visible, setVisible] = useState(false);
    const [foreground, setForeground] = useState(() => document.visibilityState === "visible");
    const [failedImage, setFailedImage] = useState<string | null>(null);

    const reduced = useSyncExternalStore(subscribeMotion, () => window.matchMedia(motionQuery).matches);
    const [slide, setSlide] = useState(() => Math.max(0, Math.min(initialSlide, (config.slides?.length ?? 1) - 1)));
    const [typingTime, setTypingTime] = useState(0);
    const elapsed = useRef(0);
    const fragments = config.template === "slides" && config.slides?.length ? config.slides : [config.text];
    const displayText = completeNostrReference(fragments[slide] ?? config.text, sourceContent).replace(/\s+/g, " ");
    const characters = Array.from(displayText);
    const running = visible && foreground && !paused && !hovered && !focused && !reduced;
    const typingStep = { slow: 100, normal: 65, fast: 40 }[config.speed];
    const typingCycle = characters.length * typingStep + 4000;
    const revealed = reduced ? characters.length : Math.min(characters.length, 1 + Math.floor(typingTime / typingStep));

    let characterIndex = 0;
    const animatedCharacters = (value: string, key: string): ReactNode => Array.from(value).map((character) => {
        const index = characterIndex++;
        if (config.template === "terminal") return <span key={`${key}-${index}`}
            className={index === revealed - 1 ? "billboard-terminal-cursor" : undefined}
            style={{ visibility: index < revealed ? "visible" : "hidden" }}>{character}</span>;
        if (config.template === "split-flap") return <span key={`${key}-${index}`}
            className="billboard-flap" style={{ "--flap-delay": `${index * 0.004}s` } as CSSProperties}>{character}</span>;
        return character;
    });
    const billboardToken = (token: ContentToken, index: number): ReactNode => {
        const key = `token-${index}`;
        if (token.kind === "text") return <Fragment key={key}>{animatedCharacters(token.value, key)}</Fragment>;
        if (token.kind === "mention") {
            try {
                const decoded = nip19.decode(token.bech32);
                const pubkey = decoded.type === "npub" ? decoded.data
                    : decoded.type === "nprofile" ? decoded.data.pubkey : null;
                if (pubkey) {
                    const start = characterIndex;
                    characterIndex += Array.from(token.bech32).length;
                    const terminal = config.template === "terminal";
                    return <span key={key}
                        className={terminal && start === revealed - 1 ? "billboard-terminal-cursor"
                            : config.template === "split-flap" ? "billboard-flap" : undefined}
                        style={{
                            ...(terminal ? { visibility: start < revealed ? "visible" : "hidden" } : {}),
                            ...(config.template === "split-flap" ? { "--flap-delay": `${start * 0.004}s` } : {}),
                        } as CSSProperties}><NostrMention pubkey={pubkey} /></span>;
                }
            } catch {
                // Invalid references remain readable links, matching the normal note renderer.
            }
            const label = `${token.bech32.slice(0, 12)}...`;
            return <a key={key} href={`https://njump.me/${token.bech32}`} target="_blank"
                rel="noopener noreferrer nofollow">{animatedCharacters(label, key)}</a>;
        }
        const href = token.kind === "link" ? token.href : token.src;
        return <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {animatedCharacters(href, key)}
        </a>;
    };
    const renderedText = parseContent(displayText).map(billboardToken);

    useEffect(() => {
        if (!running || config.template !== "terminal") return;
        let previous = performance.now();
        const timer = window.setInterval(() => {
            const now = performance.now();
            elapsed.current = (elapsed.current + now - previous) % typingCycle;
            previous = now;
            setTypingTime(elapsed.current);
        }, 40);
        return () => window.clearInterval(timer);
    }, [running, config.template, typingCycle]);

    useEffect(() => {
        if (!running || config.template !== "slides" || fragments.length < 2) return;
        const timer = window.setInterval(() => setSlide(index => (index + 1) % fragments.length), 3000);
        return () => window.clearInterval(timer);
    }, [running, config.template, fragments.length, slide]);

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
            if (!["led", "image-led"].includes(config.template) || reducedMotion.matches) {
                const style = getComputedStyle(element);
                const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
                const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
                const font = getComputedStyle(label);
                const maximumSize = FONT_SIZE[config.size] * parseFloat(getComputedStyle(document.documentElement).fontSize);
                // Offscreen descendants of size-query containers can report zero dimensions.
                // Measure an invisible copy outside those containers instead.
                const probe = document.createElement("span");
                probe.append(...Array.from(label.childNodes, node => node.cloneNode(true)));
                probe.querySelectorAll<HTMLElement>("span").forEach(child => child.style.setProperty("animation", "none", "important"));
                Object.assign(probe.style, {
                    position: "fixed", left: "-10000px", top: "0", visibility: "hidden",
                    width: `${width}px`, display: "block", whiteSpace: "normal", overflowWrap: "anywhere",
                    fontFamily: font.fontFamily, fontWeight: font.fontWeight, fontSize: `${maximumSize}px`,
                    lineHeight: String(parseFloat(font.lineHeight) / parseFloat(font.fontSize)), letterSpacing: font.letterSpacing === "normal" ? "normal" : `${parseFloat(font.letterSpacing) / parseFloat(font.fontSize)}em`,
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
        const contentObserver = new MutationObserver(measure);
        contentObserver.observe(label, { childList: true, subtree: true, characterData: true });
        reducedMotion.addEventListener("change", measure);
        void document.fonts.ready.then(measure);
        return () => { stopped = true; cancelAnimationFrame(frame); observer.disconnect(); contentObserver.disconnect(); reducedMotion.removeEventListener("change", measure); };
    }, [displayText, config.size, config.speed, config.template, visible]);

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
        "--billboard-play": running ? "running" : "paused",
    } as CSSProperties;

    const animated = config.template !== "poster";
    const showImage = (config.template === "image-led" || config.template === "poster") && config.image;
    const next = (direction: number) => setSlide(index => (index + direction + fragments.length) % fragments.length);

    return (
        <div className={`billboard-screen billboard-screen--${config.template} billboard-screen--${config.size}`} style={style}
            onPointerEnter={(e) => { if (e.pointerType === "mouse") setHovered(true); }}
            onPointerLeave={(e) => { if (e.pointerType === "mouse") setHovered(false); }}
            onFocusCapture={(e) => { if (e.target.matches(":focus-visible")) setFocused(true); }}
            onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}>
            <div className="billboard-screen__display" role="group" tabIndex={animated ? 0 : undefined}
                aria-label={`${paused ? "Paused billboard" : "Billboard"}: ${fragments.join(". ")}`}
                aria-description={animated ? "Tap to pause or resume animation. Motion pauses on mouse hover or keyboard focus." : undefined}
                onPointerDown={(e) => { pointerType.current = e.pointerType; }}
                onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a, button")) return;
                    if (animated && (e.detail === 0 || pointerType.current !== "mouse")) setPaused(value => !value);
                }}
                onKeyDown={(e) => {
                    if ((e.target as HTMLElement).closest("a, button")) return;
                    if (animated && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setPaused(value => !value); }
                    if (config.template === "slides" && ["ArrowLeft", "ArrowRight"].includes(e.key)) {
                        e.preventDefault(); next(e.key === "ArrowLeft" ? -1 : 1);
                    }
                }}>
                {showImage && <div className="billboard-screen__image">
                    {failedImage === config.image
                        ? <span className="text-xs text-cyan-100/60">Image unavailable</span>
                        : <img src={config.image} alt="Image from the promoted note" loading="lazy" decoding="async"
                            onError={() => setFailedImage(config.image ?? null)} />}
                </div>}
                <div ref={viewport} className="billboard-screen__viewport">
                    <span ref={text} className="billboard-screen__text">{renderedText}</span>
                </div>
            </div>
            {config.template === "slides" && fragments.length > 1 && <div className="billboard-slide-controls" aria-label="Billboard slides">
                <button type="button" className="note-action" aria-label="Previous slide" onClick={() => next(-1)}>&lt;</button>
                <span className="font-pixel text-[8px]" aria-live={focused || paused || reduced ? "polite" : "off"}>{slide + 1} / {fragments.length}<span className="sr-only">: {displayText}</span></span>
                <button type="button" className="note-action" aria-label="Next slide" onClick={() => next(1)}>&gt;</button>
            </div>}
        </div>
    );
}
