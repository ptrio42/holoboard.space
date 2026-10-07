import { useRef, type KeyboardEvent } from "react";

export type PromotionTab = "compose" | "appearance" | "options";

const TABS: { id: PromotionTab; label: string }[] = [
    { id: "compose", label: "Promotion" },
    { id: "appearance", label: "Billboard" },
    { id: "options", label: "Payment options" },
];

export function PromotionTabs({ id, active, onChange, disabled, billboardEnabled, notificationsEnabled }: {
    id: string; active: PromotionTab; onChange: (tab: PromotionTab) => void;
    disabled: boolean; billboardEnabled: boolean; notificationsEnabled: boolean;
}) {
    const buttons = useRef<(HTMLButtonElement | null)[]>([]);
    const unavailable = () => disabled;
    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const available = TABS.map((_, i) => unavailable() ? -1 : i).filter((i) => i >= 0);
        const position = available.indexOf(index);
        const next = event.key === "Home" ? available[0] : event.key === "End" ? available.at(-1) :
            available[(position + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length];
        if (next === undefined) return;
        buttons.current[next]?.focus();
        onChange(TABS[next].id);
    };

    return <div role="tablist" aria-label="Promotion editor" className="promotion-tabs">
        {TABS.map((tab, index) => {
            const selected = active === tab.id;
            const enabled = tab.id === "appearance" ? billboardEnabled : tab.id === "options" && notificationsEnabled;
            return <button key={tab.id} ref={(element) => { buttons.current[index] = element; }} type="button"
                role="tab" id={`${id}-${tab.id}`} aria-controls={`${id}-panel`} aria-selected={selected}
                tabIndex={selected ? 0 : -1} disabled={unavailable()}
                className="promotion-action focus-pixel promotion-tab"
                onClick={() => onChange(tab.id)} onKeyDown={(event) => onKeyDown(event, index)}>
                <span>{tab.label}</span>
                {enabled && <span className="promotion-tab__indicator" aria-label={tab.id === "appearance" ? "Billboard enabled" : "Notifications enabled"} />}
            </button>;
        })}
    </div>;
}
