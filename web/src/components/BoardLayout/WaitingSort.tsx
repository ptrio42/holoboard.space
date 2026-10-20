import { useId, useRef, useState } from "react";
import type { CampaignView } from "../../lib/campaigns";
import { NotePopover } from "../ui/NotePopover";

const options = [
    { view: "top", label: "Rank" },
    { view: "new", label: "New" },
    { view: "hot", label: "Hot" },
] as const;

export function WaitingSort({ view, onChoose, onHelp }: {
    view: CampaignView;
    onChoose: (view: CampaignView) => void;
    onHelp: () => void;
}) {
    const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const menuId = useId();
    const label = options.find(option => option.view === view)?.label ?? "Rank";
    const close = (restoreFocus = true) => {
        if (restoreFocus) trigger.current?.focus({ preventScroll: true });
        setAnchor(null);
    };
    return <div role="group" aria-label="Waiting room sort" className="board-sort">
        <div className="board-sort__options">
            {options.map(option => <button key={option.view} type="button" className="focus-pixel" aria-pressed={view === option.view}
                onClick={() => onChoose(option.view)}>{option.label}</button>)}
            <button type="button" className="board-sort__help focus-pixel" aria-label="How sorting works" title="How sorting works" onClick={onHelp}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true">
                    <path fillRule="evenodd" d="M8 2h8v2h4v4h2v8h-2v4h-4v2H8v-2H4v-4H2V8h2V4h4V2Zm0 2v2H6v2H4v8h2v2h2v2h8v-2h2v-2h2V8h-2V6h-2V4H8Z" />
                    <path d="M8 7h7v2h2v4h-4v2h-2v-4h4V9H8V7Zm3 10h2v2h-2Z" />
                </svg>
            </button>
        </div>
        <button ref={trigger} type="button" className="board-sort__trigger focus-pixel" aria-label={`Sort waiting room: ${label}`}
            aria-haspopup="menu" aria-expanded={!!anchor} aria-controls={menuId}
            onClick={event => setAnchor(anchor ? null : event.currentTarget)}>
            {label}<svg width="8" height="6" viewBox="0 0 8 6" fill="currentColor" aria-hidden="true"><path d="M0 0h8v2H6v2H5v2H3V4H2V2H0Z" /></svg>
        </button>
        {anchor && <NotePopover id={menuId} anchor={anchor} title="Sort" menu onClose={close}>
            <div role="menu" aria-label="Waiting room sort" className="note-menu board-sort-menu">
                {options.map(option => <button key={option.view} type="button" role="menuitemradio" aria-checked={view === option.view}
                    onClick={() => { close(); onChoose(option.view); }}>{option.label}</button>)}
                <button type="button" role="menuitem" onClick={() => { close(); onHelp(); }}>How sorting works</button>
            </div>
        </NotePopover>}
    </div>;
}
