import type { ReactNode } from "react";
import { ConnectionControls } from "../PromoteModal/ConnectionControls";
import { PixelButton } from "../ui/PixelButton";

type BoardSection = "board" | "waiting" | "expired";
const sections: { id: BoardSection; href: string; label: string }[] = [
    { id: "board", href: "/", label: "TOP 21" },
    { id: "waiting", href: "/waiting", label: "Waiting room" },
    { id: "expired", href: "/expired", label: "Expired" },
];

export function BoardLayout({ section, onPromote, headerContent, children, newWaitingCount = 0 }: {
    section: BoardSection;
    onPromote: () => void;
    headerContent?: ReactNode;
    children: ReactNode;
    newWaitingCount?: number;
}) {
    return <div className="mx-auto min-h-dvh w-full max-w-5xl px-4 pt-4 pb-20 sm:px-6 md:pt-6">
        <a href="#board" className="skip-link pixel-frame focus-pixel border-2 border-neon-gold bg-void px-4 py-2 font-pixel text-[10px] text-neon-gold">Skip to notes</a>
        <header className="mb-4 md:mb-6">
            <div className="grid grid-cols-[minmax(44px,1fr)_auto_minmax(44px,1fr)] items-center gap-x-2 gap-y-2 md:grid-cols-[minmax(0,1fr)_auto_auto] md:gap-x-5 md:gap-y-3">
                <h1 className="min-w-0 font-pixel text-2xl leading-tight tracking-widest text-neon-pink [text-shadow:0_0_18px_rgba(236,72,153,0.55)]">
                    <a href="/" title="Holoboard home" className="focus-pixel inline-flex min-h-11 min-w-11 items-center">
                        <span aria-hidden="true" className="md:hidden">H</span><span className="sr-only md:not-sr-only">HOLOBOARD</span>
                    </a>
                </h1>
                <PixelButton variant="accent" aria-label="Promote a note" className="justify-self-center [&>span]:min-h-[38px] [&>span]:px-4 [&>span]:py-0 [&>span]:text-[10px]" onClick={onPromote}>
                    Promote<span className="hidden md:inline"> a note</span>
                </PixelButton>
                <ConnectionControls className="justify-self-end justify-end" />
                <nav aria-label="Board sections" className="col-span-3 flex justify-between gap-x-2 font-pixel text-[10px] text-cyan-200/80 md:justify-start md:gap-x-6">
                    {sections.map(({ id, href, label }) => <a key={id} href={href} aria-current={section === id ? "page" : undefined} className={`focus-pixel relative inline-flex min-h-11 items-center justify-center gap-2 border-b-2 ${section === id ? "border-neon-gold text-neon-gold" : "border-transparent hover:text-neon-cyan"}`}>{label}{id === "waiting" && newWaitingCount > 0 && <span className="waiting-new-badge" aria-label={`${newWaitingCount} new ${newWaitingCount === 1 ? "note" : "notes"} since your last visit`}>{newWaitingCount > 99 ? "99+" : newWaitingCount}</span>}</a>)}
                </nav>
            </div>
            {headerContent}
        </header>
        {children}
        <footer className="mt-12 border-t-2 border-cyan-400/15 pt-6 text-center text-xs text-cyan-100/50"><div className="flex flex-wrap justify-center gap-6"><a href="/help" className="promotion-action focus-pixel inline-flex min-h-11 items-center">Help</a><a href="https://github.com/ptrio42/holoboard.space" target="_blank" rel="noopener noreferrer" className="promotion-action focus-pixel inline-flex min-h-11 items-center">GitHub</a></div><p>Only paid visibility affects rank. Each payment loses half its weight every 30 days.</p></footer>
    </div>;
}
