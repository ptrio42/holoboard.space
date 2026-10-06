import type { ReactNode } from "react";
import { ConnectionControls } from "../PromoteModal/ConnectionControls";
import { RANKING_SECTION } from "../PromoteModal/PromoteModal";
import { PixelButton } from "../ui/PixelButton";

type BoardSection = "board" | "waiting" | "expired";
const sections: { id: BoardSection; href: string; label: string }[] = [
    { id: "board", href: "/", label: "Top 21" },
    { id: "waiting", href: "/waiting", label: "Waiting room" },
    { id: "expired", href: "/expired", label: "Expired" },
];

export function BoardLayout({ section, onPromote, headerContent, children }: {
    section: BoardSection;
    onPromote: () => void;
    headerContent?: ReactNode;
    children: ReactNode;
}) {
    return <div className="mx-auto min-h-dvh w-full max-w-5xl px-4 pt-6 pb-20 sm:px-6">
        <a href="#board" className="skip-link pixel-frame focus-pixel border-2 border-neon-gold bg-void px-4 py-2 font-pixel text-[10px] text-neon-gold">Skip to notes</a>
        <header className="mb-6">
            <div className="grid grid-cols-1 justify-items-center gap-y-4 text-center md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:justify-items-start md:gap-x-6 md:text-left">
                <h1 className="font-pixel text-xl leading-tight tracking-widest text-neon-pink [text-shadow:0_0_18px_rgba(236,72,153,0.55)] md:text-2xl">HOLOBOARD</h1>
                <ConnectionControls className="justify-center md:justify-end md:justify-self-end" />
            </div>
            <div className="mt-5 flex flex-col-reverse items-center gap-5 md:flex-row md:justify-between">
                <nav aria-label="Board sections" className="flex flex-wrap justify-center gap-x-4 font-pixel text-[10px] text-cyan-200/80 md:justify-start">
                    {sections.map(({ id, href, label }) => <a key={id} href={href} aria-current={section === id ? "page" : undefined} className={`focus-pixel inline-flex min-h-11 items-center border-b-2 ${section === id ? "border-neon-gold text-neon-gold" : "border-transparent hover:text-neon-cyan"}`}>{label}</a>)}
                </nav>
                <PixelButton variant="accent" onClick={onPromote}>Promote a note</PixelButton>
            </div>
            {headerContent}
        </header>
        {children}
        <footer className="mt-12 border-t-2 border-cyan-400/15 pt-6 text-center text-xs text-cyan-100/50"><div className="flex flex-wrap justify-center gap-6"><a href={`/help#${RANKING_SECTION}`} className="focus-pixel inline-flex min-h-11 items-center">How ranking works</a><a href="/help#other-ways-to-promote" className="focus-pixel inline-flex min-h-11 items-center">Other ways to promote</a><a href="https://github.com/ptrio42/holoboard.space" target="_blank" rel="noopener noreferrer" className="focus-pixel inline-flex min-h-11 items-center">GitHub</a></div><p>Only paid visibility affects rank. Each payment loses half its weight every 30 days.</p></footer>
    </div>;
}
