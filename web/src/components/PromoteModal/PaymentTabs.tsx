import { useRef, type KeyboardEvent } from "react";
import type { PaymentMethod } from "./PaymentState";

export function PaymentTabs({ id, active, walletFirst, onChange }: {
    id: string; active: PaymentMethod; walletFirst: boolean; onChange: (method: PaymentMethod) => void;
}) {
    const tabs: PaymentMethod[] = walletFirst ? ["wallet", "invoice"] : ["invoice", "wallet"];
    const buttons = useRef<(HTMLButtonElement | null)[]>([]);
    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
        buttons.current[next]?.focus(); onChange(tabs[next]);
    };
    return <div role="tablist" aria-label="Payment method" className="promotion-tabs" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
        {tabs.map((tab, index) => <button key={tab} type="button" role="tab" id={`${id}-${tab}`} aria-controls={`${id}-panel`}
            aria-selected={active === tab} tabIndex={active === tab ? 0 : -1}
            ref={(element) => { buttons.current[index] = element; }}
            className="promotion-action focus-pixel promotion-tab" onClick={() => onChange(tab)} onKeyDown={(event) => onKeyDown(event, index)}>
            {tab === "wallet" ? "Wallet" : "Invoice / QR"}
        </button>)}
    </div>;
}
