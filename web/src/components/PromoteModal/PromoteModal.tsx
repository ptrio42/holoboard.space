import { useEffect, useState, useSyncExternalStore } from "react";
import { initializePaymentSessions, getPaymentSessionStatus, subscribePaymentSessions } from "../../lib/paymentSession";
import { StatusMessage } from "../ui/StatusMessage";
import { Modal } from "../ui/Modal";
import { ENABLE_POST_CREATION } from "../../config";
import { BoardComposer, type BoardComposition } from "./BoardComposer";
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
    const recovery = useSyncExternalStore(subscribePaymentSessions, getPaymentSessionStatus);
    useEffect(() => { void initializePaymentSessions(); }, []);
    const [source, setSource] = useState<BoardComposition>({ reference: "" });
    const [footerHost, setFooterHost] = useState<HTMLDivElement | null>(null);
    const [navigationHost, setNavigationHost] = useState<HTMLDivElement | null>(null);
    const [presentation, setPresentation] = useState({ compact: !!initialReference && (currentWeight ?? 0) > 0 && !openSection, boost: !!initialReference && (currentWeight ?? 0) > 0, payment: false });
    return <Modal isOpen onClose={onClose} scrollBody footerRef={setFooterHost} navigationRef={setNavigationHost}
        compact={presentation.compact} mobileFullScreen={!presentation.compact}
        title={presentation.payment ? "Promotion payment" : presentation.boost ? "Boost note" : "Add to board"}
        panelClassName={`promotion-typography ${presentation.compact || presentation.payment ? "max-w-lg" : "max-w-3xl"}`}>
        {!recovery.ready ? <StatusMessage loading>Loading saved payments...</StatusMessage> : ENABLE_POST_CREATION && !initialReference ? <BoardComposer onSource={setSource}>{editor => <DirectPromote composition={source} composer={editor} rankingTargets={rankingTargets} onPaid={onPaid} onClose={onClose}
            initialSection={openSection} footerHost={footerHost} navigationHost={navigationHost} onPresentationChange={setPresentation} />}</BoardComposer> : (
        <DirectPromote initialReference={initialReference} currentWeight={currentWeight}
            rankingTargets={rankingTargets} onPaid={onPaid} onClose={onClose} initialSection={openSection}
            footerHost={footerHost} navigationHost={navigationHost} onPresentationChange={setPresentation} />
        )}
    </Modal>;
}
