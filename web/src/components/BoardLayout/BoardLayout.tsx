import { useContext, type ReactNode } from "react";
import holoboardMark from "../../assets/holoboard-mark.svg";
import { ConnectionControls } from "../PromoteModal/ConnectionControls";
import { PixelButton } from "../ui/PixelButton";
import { WaitingRoomLocation } from "./BoardNavigation";
import { navigateBoard } from "../../lib/discussionNavigation";

type BoardSection = "board" | "waiting" | "expired";
const sections: { id: BoardSection; href: string; label: string }[] = [
    { id: "board", href: "/", label: "TOP 21" },
    { id: "waiting", href: "/waiting", label: "Waiting room" },
];

export function BoardLayout({ section, onPromote, sectionControls, headerContent, children, newWaitingCount = 0 }: {
    section: BoardSection | "discussion" | "profile";
    onPromote: () => void;
    sectionControls?: ReactNode;
    headerContent?: ReactNode;
    children: ReactNode;
    newWaitingCount?: number;
}) {
    const waitingHref = useContext(WaitingRoomLocation);
    return <div className="board-shell mx-auto min-h-dvh w-full max-w-5xl">
        <a href={section === "profile" ? "#profile" : section === "discussion" ? "#discussion" : "#board"} className="skip-link pixel-frame focus-pixel border-2 border-neon-gold bg-void px-4 py-2 font-pixel text-[10px] text-neon-gold">Skip to notes</a>
        <header className="board-header">
            <div className="board-header__bar">
                <h1 className="board-header__brand font-pixel text-2xl leading-tight tracking-widest text-neon-pink">
                    <a href="/" title="Holoboard home" onClick={navigateBoard} className="focus-pixel inline-flex min-h-11 min-w-11 items-center">
                        <img src={holoboardMark} width={24} height={24} alt="" aria-hidden="true" className="md:hidden" /><span className="sr-only md:not-sr-only">HOLOBOARD</span>
                    </a>
                </h1>
                <div className="board-header__actions">
                    <PixelButton variant="accent" aria-label="Add to board" className="board-header__add" onClick={event => {
                        // Touch Safari does not focus buttons before the modal captures its opener.
                        event.currentTarget.focus({ preventScroll: true });
                        onPromote();
                    }}>
                        <span className="md:hidden" aria-hidden="true">Add</span><span className="hidden md:inline" aria-hidden="true">Add to board</span>
                    </PixelButton>
                    <ConnectionControls className="justify-end" />
                </div>
                <nav aria-label="Board sections" className="board-header__sections">
                    {sections.map(({ id, href, label }) => <a key={id} href={id === "waiting" ? waitingHref : href} onClick={navigateBoard} aria-current={section === id ? "page" : undefined} className="focus-pixel">{label}{id === "waiting" && newWaitingCount > 0 && <span className="waiting-new-badge" aria-label={`${newWaitingCount} new ${newWaitingCount === 1 ? "note" : "notes"} since your last visit`}>{newWaitingCount > 99 ? "99+" : newWaitingCount}</span>}</a>)}
                </nav>
                {sectionControls && <div className="board-header__section-controls">{sectionControls}</div>}
                <span className="board-header__rail" aria-hidden="true" />
            </div>
            {headerContent}
        </header>
        {children}
        <footer className="board-footer"><div className="board-footer__links"><a href="/expired" onClick={navigateBoard} aria-current={section === "expired" ? "page" : undefined} className={`promotion-action focus-pixel inline-flex min-h-11 items-center${section === "expired" ? " text-neon-gold" : ""}`}>Expired notes</a><a href="/help" onClick={navigateBoard} className="promotion-action focus-pixel inline-flex min-h-11 items-center">Help</a><a href="https://github.com/ptrio42/holoboard.space" target="_blank" rel="noopener noreferrer" className="promotion-action focus-pixel inline-flex min-h-11 items-center">GitHub</a></div><p>Only paid visibility affects rank. Each payment loses half its weight every 30 days.</p></footer>
    </div>;
}
