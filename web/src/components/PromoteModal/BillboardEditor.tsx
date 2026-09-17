import { NDKEvent } from "@nostr-dev-kit/ndk";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { BILLBOARD_COLORS, BILLBOARD_MAX_TEXT, validBillboard, type BillboardConfig } from "../../lib/billboard";
import { noteTextSelection, pastedNoteText, selectedNoteText } from "../../lib/noteText";
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
    const [textMode, setTextMode] = useState<"paste" | "select">("paste");
    const tabId = useId();
    const originalInput = useRef<HTMLTextAreaElement>(null);
    const selection = useRef<{ content: string; start: number; end: number } | undefined>(undefined);
    const selected = preview.billboard ?? (enabled ? config : undefined);
    const valid = validBillboard(config, preview.event.content, preview.images);
    useEffect(() => {
        const input = originalInput.current;
        const content = preview.event.content;
        if (!input || !config.text) return;
        // Keep the actual occurrence and mobile selection handles in place.
        if (selectedNoteText(content, input.selectionStart, input.selectionEnd) === config.text) return;
        const saved = selection.current;
        const range = saved?.content === content && selectedNoteText(content, saved.start, saved.end) === config.text
            ? [saved.start, saved.end] : noteTextSelection(content, config.text);
        if (range) input.setSelectionRange(range[0], range[1]);
    }, [textMode, config.text, preview.event.content]);

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
                <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-1 text-xs">Template
                        <select aria-label="Template" className={FIELD} value={config.template} onChange={(e) => onChange({ ...config,
                            template: e.target.value as BillboardConfig["template"],
                            image: e.target.value === "image-led" ? preview.images[0] : undefined })}>
                            <option value="led">LED ticker</option><option value="neon">Neon sign</option>
                            <option value="image-led" disabled={!preview.images.length}>Image + LED</option>
                        </select>
                    </label>
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
                    <label className="space-y-1 text-xs">Scroll speed
                        <select aria-label="Scroll speed" className={FIELD} disabled={config.template === "neon"} value={config.speed}
                            onChange={(e) => onChange({ ...config, speed: e.target.value as BillboardConfig["speed"] })}>
                            <option value="slow">Slow</option><option value="normal">Normal</option><option value="fast">Fast</option>
                        </select>
                    </label>
                </div>
                <div className="space-y-2">
                    <div role="tablist" aria-label="Choose billboard text" className="flex flex-wrap gap-2"
                        onKeyDown={(e) => {
                            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
                            e.preventDefault();
                            const mode = e.key === "Home" ? "paste" : e.key === "End" ? "select" : textMode === "paste" ? "select" : "paste";
                            setTextMode(mode);
                            e.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${mode}"]`)?.focus();
                        }}>
                        {(["paste", "select"] as const).map((mode) => <PixelButton key={mode} size="sm"
                            role="tab" id={`${tabId}-${mode}`} data-mode={mode}
                            aria-controls={`${tabId}-panel`} aria-selected={textMode === mode}
                            tabIndex={textMode === mode ? 0 : -1} variant={textMode === mode ? "accent" : "ghost"}
                            onClick={() => setTextMode(mode)}>
                            {mode === "paste" ? "Paste fragment" : "Select from note"}
                        </PixelButton>)}
                    </div>
                    <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${textMode}`} className="space-y-2">
                        {textMode === "paste" ? <label className="block space-y-1 text-xs">Billboard text
                            <textarea rows={3} className={`${FIELD} resize-y`} value={config.text}
                                onChange={(e) => onChange({ ...config, text: pastedNoteText(preview.event.content, e.target.value) })} />
                        </label> : <>
                            <label className="block space-y-1 text-xs">Original note
                                <textarea ref={originalInput} readOnly value={preview.event.content} rows={5} className={`${FIELD} resize-y`}
                                    onSelect={(e) => {
                                        const input = e.currentTarget;
                                        const content = preview.event.content;
                                        selection.current = { content, start: input.selectionStart, end: input.selectionEnd };
                                        const text = selectedNoteText(content, input.selectionStart, input.selectionEnd);
                                        if (text && text !== config.text) onChange({ ...config, text });
                                    }} />
                            </label>
                            <p className="text-xs text-cyan-100/80">Selected fragment:
                                <span className="mt-1 block max-h-24 overflow-y-auto whitespace-pre-wrap break-words">{config.text}</span>
                            </p>
                        </>}
                        <div className="flex items-start justify-between gap-3 text-xs text-cyan-100/60">
                            <p>{textMode === "paste" ? "Paste an exact fragment from the original note." : "Highlight the fragment you want to advertise."}</p>
                            <span className="shrink-0" aria-label="Selected character count">{Array.from(config.text).length}/{BILLBOARD_MAX_TEXT}</span>
                        </div>
                        {!valid && <p className="text-xs text-neon-pink" role="alert">
                            Choose a non-empty original fragment of up to {BILLBOARD_MAX_TEXT} characters.
                        </p>}
                    </div>
                </div>
                {config.template === "image-led" && <label className="block space-y-1 text-xs">Image from the note
                    <select aria-label="Image from the note" className={FIELD} value={config.image} onChange={(e) => onChange({ ...config, image: e.target.value })}>
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
                    weight={preview.weight + amount} billboard={selected} /></ul>
            </div>
            <p className="text-[11px] leading-relaxed text-cyan-100/50">
                Preview shows appearance, not a guaranteed rank. Full note remains available in every Nostr client.
            </p>
        </section>
    );
}
