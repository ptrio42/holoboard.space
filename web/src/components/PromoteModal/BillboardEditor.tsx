import { NDKEvent } from "@nostr-dev-kit/ndk";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { BILLBOARD_COLORS, BILLBOARD_MAX_TEXT, BILLBOARD_MAX_SLIDES, BILLBOARD_TEMPLATES, billboardCharacterCount, validBillboard, type BillboardConfig } from "../../lib/billboard";
import { noteTextSelection, selectedNoteText } from "../../lib/noteText";
import type { NotePreview } from "../../lib/promote";
import { BoardRow } from "../BoardRow/BoardRow";
import { PixelButton } from "../ui/PixelButton";

const FIELD = "focus-pixel w-full border-2 border-cyan-400/30 bg-void p-2 text-xs text-cyan-100";

export function BillboardEditor({ preview, config, onChange, enabled, onEnabledChange, amount }: {
    preview: NotePreview; config: BillboardConfig; onChange: (config: BillboardConfig) => void;
    enabled: boolean; onEnabledChange: (enabled: boolean) => void; amount: number;
}) {
    const [mobile, setMobile] = useState(false);
    const event = useMemo(() => new NDKEvent(undefined, preview.event), [preview.event]);
    const locked = preview.active;
    const [editingSlide, setEditingSlide] = useState(0);
    const slideIndex = Math.min(editingSlide, Math.max(0, (config.slides?.length ?? 1) - 1));
    const fragment = config.template === "slides" ? config.slides?.[slideIndex] ?? "" : config.text;
    const changeFragment = (text: string) => {
        if (config.template !== "slides") { onChange({ ...config, text }); return; }
        const slides = [...(config.slides ?? [config.text])];
        slides[slideIndex] = text;
        onChange({ ...config, slides, text: slides[0] });
    };
    const chooseTemplate = (template: BillboardConfig["template"]) => {
        setEditingSlide(0);
        onChange({ ...config, template,
            slides: template === "slides" ? config.slides ?? [config.text] : undefined,
            image: template === "image-led" ? config.image ?? preview.images[0] : template === "poster" ? config.image : undefined });
    };
    const selectionHint = useId();
    const originalInput = useRef<HTMLTextAreaElement>(null);
    const selection = useRef<{ content: string; start: number; end: number } | undefined>(undefined);
    const selected = preview.billboard ?? (enabled ? config : undefined);
    const valid = validBillboard(config, preview.event.content, preview.images);
    useEffect(() => {
        const input = originalInput.current;
        const content = preview.event.content;
        if (!input) return;
        if (!fragment) { input.setSelectionRange(0, 0); return; }
        // Keep the actual occurrence and mobile selection handles in place.
        if (selectedNoteText(content, input.selectionStart, input.selectionEnd) === fragment) return;
        const saved = selection.current;
        const range = saved?.content === content && selectedNoteText(content, saved.start, saved.end) === fragment
            ? [saved.start, saved.end] : noteTextSelection(content, fragment);
        if (range) input.setSelectionRange(range[0], range[1]);
    }, [enabled, locked, fragment, slideIndex, preview.event.content]);

    return (
        <section className="space-y-4 border-t-2 border-cyan-400/25 pt-4" aria-label="Billboard appearance">
            <div className="flex flex-wrap gap-2">
                <PixelButton size="sm" variant={!enabled && !preview.billboard ? "accent" : "ghost"} aria-pressed={!enabled && !preview.billboard} disabled={locked}
                    onClick={() => onEnabledChange(false)}>
                    Standard / free
                </PixelButton>
                <PixelButton size="sm" variant={enabled || !!preview.billboard ? "accent" : "ghost"} aria-pressed={enabled || !!preview.billboard} disabled={locked}
                    onClick={() => onEnabledChange(true)}>
                    Billboard / {preview.billboard ? "already paid" : `+${preview.billboardFeeSats} sats`}
                </PixelButton>
            </div>
            {locked ? <p className="text-xs leading-relaxed text-cyan-100/70">
                Boosts keep this note's existing appearance. A billboard can only be chosen when starting a new promotion period.
            </p> : enabled && <>
                <p className="text-xs leading-relaxed text-neon-gold">
                    Introductory price: {preview.billboardFeeSats} sats. Deliberately low; it will increase in the future.
                    Appearance lasts while the note is active. It does not add ranking weight.
                </p>
                <div className="billboard-template-gallery" role="group" aria-label="Billboard template">
                    {BILLBOARD_TEMPLATES.map(template => <button type="button" key={template.id}
                        className={`billboard-template billboard-template--${template.id}`}
                        aria-label={template.name} aria-pressed={config.template === template.id}
                        aria-description={template.id === "image-led" && !preview.images.length ? "Needs an image in the note" : template.caption}
                        disabled={template.id === "image-led" && !preview.images.length}
                        onClick={() => chooseTemplate(template.id)}>
                        <span className="billboard-template__sample" aria-hidden="true">{template.id === "image-led" && !preview.images.length ? "NO IMAGE" : template.sample}</span>
                        <span className="block text-xs text-cyan-100">{template.name}</span>
                        <span className="mt-1 hidden text-[10px] leading-relaxed text-cyan-100/60 sm:block">
                            {template.id === "image-led" && !preview.images.length ? "Needs an image in the note" : template.caption}
                        </span>
                    </button>)}
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-1 text-xs">Text size
                        <select aria-label="Text size" className={FIELD} value={config.size} onChange={(e) => onChange({ ...config, size: e.target.value as BillboardConfig["size"] })}>
                            <option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
                        </select>
                    </label>
                    <fieldset className="space-y-1"><legend className="text-xs">Color</legend>
                        <div className="flex flex-wrap gap-2">{Object.entries(BILLBOARD_COLORS).map(([color, ink]) => (
                            <PixelButton key={color} size="sm" variant="ghost" aria-pressed={config.color === color}
                                onClick={() => onChange({ ...config, color: color as BillboardConfig["color"] })}
                                className={config.color === color ? "billboard-color--selected" : "opacity-60"} style={{ "--edge": ink, "--ink": ink } as CSSProperties}>{color}</PixelButton>
                        ))}</div>
                    </fieldset>
                    {["led", "image-led", "terminal"].includes(config.template) && <label className="space-y-1 text-xs">{config.template === "terminal" ? "Typing speed" : "Scroll speed"}
                        <select aria-label={config.template === "terminal" ? "Typing speed" : "Scroll speed"} className={FIELD} value={config.speed}
                            onChange={(e) => onChange({ ...config, speed: e.target.value as BillboardConfig["speed"] })}>
                            <option value="slow">Slow</option><option value="normal">Normal</option><option value="fast">Fast</option>
                        </select>
                    </label>}
                </div>
                {config.template === "slides" && <div className="space-y-2" aria-label="Edit slides">
                    <div className="flex flex-wrap items-center gap-2">
                        {(config.slides ?? []).map((_, index) => <PixelButton key={index} size="sm"
                            aria-pressed={slideIndex === index} variant={slideIndex === index ? "accent" : "ghost"}
                            onClick={() => setEditingSlide(index)}>Slide {index + 1}</PixelButton>)}
                        <PixelButton size="sm" variant="ghost" disabled={(config.slides?.length ?? 0) >= BILLBOARD_MAX_SLIDES}
                            onClick={() => {
                                const slides = [...(config.slides ?? [config.text]), ""];
                                onChange({ ...config, slides }); setEditingSlide(slides.length - 1);
                            }}>Add slide</PixelButton>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <button type="button" className="note-action min-h-11 disabled:opacity-40" disabled={slideIndex === 0}
                            onClick={() => {
                                const slides = [...config.slides!];
                                [slides[slideIndex - 1], slides[slideIndex]] = [slides[slideIndex], slides[slideIndex - 1]];
                                onChange({ ...config, slides, text: slides[0] }); setEditingSlide(slideIndex - 1);
                            }}>Move earlier</button>
                        <button type="button" className="note-action min-h-11 disabled:opacity-40" disabled={slideIndex === (config.slides?.length ?? 1) - 1}
                            onClick={() => {
                                const slides = [...config.slides!];
                                [slides[slideIndex + 1], slides[slideIndex]] = [slides[slideIndex], slides[slideIndex + 1]];
                                onChange({ ...config, slides, text: slides[0] }); setEditingSlide(slideIndex + 1);
                            }}>Move later</button>
                        <button type="button" className="note-action min-h-11 disabled:opacity-40" disabled={(config.slides?.length ?? 0) <= 1}
                            onClick={() => {
                                const slides = config.slides!.filter((_, index) => index !== slideIndex);
                                onChange({ ...config, slides, text: slides[0] }); setEditingSlide(Math.max(0, slideIndex - 1));
                            }}>Remove slide</button>
                    </div>
                    <p className="text-xs leading-relaxed text-cyan-100/60">Up to 3 original fragments, 160 characters total. Slides change every 3 seconds and can be switched manually.</p>
                </div>}
                <div className="space-y-2">
                    <label className="block space-y-1 text-xs">Original note
                        <textarea ref={originalInput} readOnly value={preview.event.content} rows={5}
                            aria-describedby={selectionHint} className={`${FIELD} resize-y`}
                            onSelect={(e) => {
                                const input = e.currentTarget;
                                const content = preview.event.content;
                                selection.current = { content, start: input.selectionStart, end: input.selectionEnd };
                                const text = selectedNoteText(content, input.selectionStart, input.selectionEnd);
                                if (text && text !== fragment) changeFragment(text);
                            }} />
                    </label>
                    <div className="flex items-start justify-between gap-3 text-xs text-cyan-100/60">
                        <p id={selectionHint}>{config.template === "slides"
                            ? `Highlight text for slide ${slideIndex + 1}.`
                            : "Highlight the fragment you want to advertise."}</p>
                        <span className="shrink-0" aria-label="Selected character count">{billboardCharacterCount(config)}/{BILLBOARD_MAX_TEXT}</span>
                    </div>
                    <p className="text-xs text-cyan-100/80">Selected fragment:
                        <span className="mt-1 block max-h-24 overflow-y-auto whitespace-pre-wrap break-words">{fragment || "No fragment selected"}</span>
                    </p>
                    {!valid && <p className="text-xs text-neon-pink" role="alert">
                        {config.template === "slides" ? `Choose non-empty original fragments of up to ${BILLBOARD_MAX_TEXT} characters in total.` : `Choose a non-empty original fragment of up to ${BILLBOARD_MAX_TEXT} characters.`}
                    </p>}
                </div>
                {(config.template === "image-led" || (config.template === "poster" && preview.images.length > 0)) && <label className="block space-y-1 text-xs">Image from the note
                    <select aria-label="Image from the note" className={FIELD} value={config.image ?? ""} onChange={(e) => onChange({ ...config, image: e.target.value || undefined })}>
                        {config.template === "poster" && <option value="">No image</option>}
                        {preview.images.map((src, index) => <option key={`${src}-${index}`} value={src}>Image {index + 1}: {src}</option>)}
                    </select>
                </label>}
            </>}
            <div className="flex items-center justify-between gap-3">
                <span className="font-pixel text-[9px] text-neon-cyan">LIVE PREVIEW</span>
                <button type="button" aria-pressed={mobile} onClick={() => setMobile((value) => !value)}
                    className="note-action min-h-9">{mobile ? "Use full width" : "Use phone width"}</button>
            </div>
            <div className={mobile ? "mx-auto w-full max-w-[360px]" : "w-full"}>
                <ul><BoardRow event={event} rank={preview.rank || undefined} sats={preview.satsPaid + amount}
                    weight={preview.weight + amount} billboard={selected}
                    billboardPreviewSlide={!locked && enabled && config.template === "slides" ? slideIndex : undefined} /></ul>
            </div>
            <p className="text-[11px] leading-relaxed text-cyan-100/50">
                Preview shows appearance, not a guaranteed rank. Full note remains available in every Nostr client.
            </p>
        </section>
    );
}
