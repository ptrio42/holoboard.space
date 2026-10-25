export type EditorStep = "post" | "budget";
export type PromotionStep = EditorStep | "payment";

const STEPS: PromotionStep[] = ["post", "budget", "payment"];

/** Ordered task progress. Only completed steps offer navigation. */
export function PromotionSteps({ active, onEarlier }: { active: PromotionStep; onEarlier: (step: EditorStep) => void }) {
    const current = STEPS.indexOf(active);
    return <nav aria-label="Add to board progress" className="promotion-steps">
        <ol>
            {STEPS.map((step, index) => <li key={step} data-state={index === current ? "current" : index < current ? "complete" : "future"} aria-current={index === current ? "step" : undefined}>
                {index < current ? <button type="button" className="promotion-action focus-pixel" onClick={() => onEarlier(step as EditorStep)}>{step === "post" ? "Post" : "Budget"}</button> :
                    <span className="promotion-label">{step === "post" ? "Post" : step === "budget" ? "Budget" : "Payment"}</span>}
                <span className="promotion-steps__point" aria-hidden="true">{index < current ? "✓" : ""}</span>
            </li>)}
        </ol>
    </nav>;
}
