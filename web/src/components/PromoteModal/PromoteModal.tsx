import { useState } from "react";
import { Modal } from "../ui/Modal";
import { DirectPromote } from "./DirectPromote";
import type { RankingTarget } from "../../lib/ranking";

export { RANKING_SECTION } from "../Help/HelpContent";

interface PromoteModalProps {
    onClose: () => void;
    openSection?: string;
    initialReference?: string;
    currentWeight?: number;
    rankingTargets?: RankingTarget[];
    onPaid?: () => void;
}

export function PromoteModal({ onClose, openSection, initialReference = "", currentWeight, rankingTargets = [], onPaid }: PromoteModalProps) {
    const [footerHost, setFooterHost] = useState<HTMLDivElement | null>(null);
    const [presentation, setPresentation] = useState({ compact: !!initialReference && (currentWeight ?? 0) > 0 && !openSection, boost: !!initialReference && (currentWeight ?? 0) > 0, payment: false });
    return <Modal isOpen onClose={onClose} scrollBody footerRef={setFooterHost}
        compact={presentation.compact} mobileFullScreen={!presentation.compact}
        title={presentation.payment ? "Promotion payment" : presentation.boost ? "Boost this note" : "Promote a note"}
        panelClassName={presentation.compact ? "max-w-lg" : "max-w-3xl"}>
        <DirectPromote initialReference={initialReference} currentWeight={currentWeight}
            rankingTargets={rankingTargets} onPaid={onPaid} initialSection={openSection}
            footerHost={footerHost} onPresentationChange={setPresentation} />
    </Modal>;
}
