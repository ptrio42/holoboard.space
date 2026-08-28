import React, { useEffect, useRef } from 'react';

interface AddAdModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function AddAdModal({ isOpen, onClose }: AddAdModalProps) {
    const modalRef = useRef<HTMLDivElement>(null);

    // Handle ESC key press
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                onClose();
            }
        };

        if (isOpen) {
            document.addEventListener('keydown', handleEscape);
            // Lock body scroll
            document.body.style.overflow = 'hidden';
        }

        return () => {
            document.removeEventListener('keydown', handleEscape);
            // Restore body scroll
            document.body.style.overflow = '';
        };
    }, [isOpen, onClose]);

    // Focus trap
    useEffect(() => {
        if (!isOpen || !modalRef.current) return;

        const modal = modalRef.current;
        const focusableElements = modal.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const firstElement = focusableElements[0] as HTMLElement;
        const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;

        const handleTab = (e: KeyboardEvent) => {
            if (e.key !== 'Tab') return;

            if (e.shiftKey) {
                if (document.activeElement === firstElement) {
                    lastElement?.focus();
                    e.preventDefault();
                }
            } else {
                if (document.activeElement === lastElement) {
                    firstElement?.focus();
                    e.preventDefault();
                }
            }
        };

        modal.addEventListener('keydown', handleTab as EventListener);
        firstElement?.focus();

        return () => {
            modal.removeEventListener('keydown', handleTab as EventListener);
        };
    }, [isOpen]);

    if (!isOpen) return null;

    const relayPubkey = "30bd172fc5295108b93de95516c811fabcfba0ec891e251645023329113d7643";

    return (
        <div
            className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
        >
            <div
                ref={modalRef}
                className="bg-[#090018] border-4 border-cyan-400 shadow-[0_0_40px_#00ffff88] max-w-2xl w-full max-h-[90vh] overflow-y-auto pixel-corners"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="p-8">
                    <div className="flex justify-between items-center mb-6">
                        <h2 id="modal-title" className="text-2xl md:text-3xl text-pink-500 font-mono tracking-wider">
                            HOW TO PROMOTE A POST
                        </h2>
                        <button
                            onClick={onClose}
                            className="text-cyan-300 hover:text-pink-500 text-3xl leading-none transition-colors"
                            aria-label="Close modal"
                        >
                            ×
                        </button>
                    </div>

                    <div className="space-y-6 text-cyan-300 font-mono">
                        <section>
                            <h3 className="text-xl text-pink-400 mb-3 flex items-center gap-2">
                                <span>📍</span> Method 1: Zap with event reference (recommended)
                            </h3>
                            <p className="mb-3">
                                Send a zap to this relay's pubkey and include the post reference in the zap comment/message field.
                            </p>
                            <div className="bg-[#05010d] border border-cyan-400/50 p-4 rounded mb-3">
                                <p className="text-sm text-pink-300 mb-1">Relay pubkey:</p>
                                <code className="text-xs text-yellow-300 break-all select-all">
                                    {relayPubkey}
                                </code>
                            </div>
                            <div className="bg-[#05010d] border border-cyan-400/50 p-4 rounded">
                                <p className="text-sm text-pink-300 mb-2">Supported formats in zap comment:</p>
                                <ul className="text-sm space-y-1 list-disc list-inside text-white/80">
                                    <li><code className="text-yellow-300">nostr:nevent1...</code> (most common)</li>
                                    <li><code className="text-yellow-300">nostr:note1...</code></li>
                                    <li><code className="text-yellow-300">nevent1...</code></li>
                                    <li><code className="text-yellow-300">note1...</code></li>
                                    <li><code className="text-yellow-300">64-char hex ID</code></li>
                                </ul>
                            </div>
                            <p className="mt-3 text-sm text-white/70 italic">
                                The relay monitors major relays for zaps and will automatically fetch and promote the post!
                            </p>
                        </section>

                        <section>
                            <h3 className="text-xl text-pink-400 mb-3 flex items-center gap-2">
                                <span>📍</span> Method 2: PROMOTE command
                            </h3>
                            <ol className="space-y-2 list-decimal list-inside text-sm text-white/80">
                                <li>Send a DM to the relay with: <code className="text-yellow-300">PROMOTE &lt;post_id&gt;</code></li>
                                <li className="ml-6">(Supports all formats above)</li>
                                <li>The relay will reply with a Lightning invoice</li>
                                <li>Pay the invoice</li>
                                <li>Your post will be promoted!</li>
                            </ol>
                        </section>

                        <section>
                            <h3 className="text-xl text-pink-400 mb-3 flex items-center gap-2">
                                <span>💰</span> Payment Rules
                            </h3>
                            <ul className="space-y-2 list-disc list-inside text-sm text-white/80">
                                <li>Any post can be promoted by anyone (not just the author)</li>
                                <li>Posts are ranked by total sats paid</li>
                                <li>Multiple payments to the same post increase its ranking</li>
                                <li>The relay actively monitors other relays for zaps</li>
                            </ul>
                        </section>

                        <section>
                            <h3 className="text-xl text-pink-400 mb-3 flex items-center gap-2">
                                <span>📊</span> Query & Storage
                            </h3>
                            <p className="text-sm text-white/80">
                                Query this relay to see the top promoted posts! This relay only stores and serves posts that have been paid for.
                            </p>
                            <div className="bg-[#05010d] border border-cyan-400/50 p-4 rounded mt-3">
                                <p className="text-sm text-pink-300 mb-1">Relay URL:</p>
                                <code className="text-xs text-yellow-300 break-all select-all">
                                    wss://relay.holoboard.space
                                </code>
                            </div>
                        </section>

                        <div className="flex justify-center mt-8">
                            <button
                                onClick={onClose}
                                className="font-mono border-2 border-cyan-400 text-cyan-300 bg-[#05010d] px-8 py-3 tracking-widest uppercase shadow-[0_0_12px_#00ffff88] hover:translate-x-[2px] hover:translate-y-[2px] hover:border-pink-500 hover:text-pink-400 hover:shadow-[0_0_18px_#ff00ff] transition-all"
                            >
                                GOT IT!
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
