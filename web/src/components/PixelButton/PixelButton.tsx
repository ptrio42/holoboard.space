interface PixelButtonProps {
    label: string;
    onClick?: () => void;
}

export function PixelButton({ label, onClick }: PixelButtonProps) {
    return (
        <button
            onClick={onClick}
            className="
        font-pressstart2p
        border-2 border-cyan-400 text-cyan-300 bg-[#05010d]
        px-6 py-3 tracking-widest uppercase
        shadow-[0_0_12px_#00ffff88]
        hover:translate-x-[2px] hover:translate-y-[2px]
        hover:border-pink-500 hover:text-pink-400 hover:shadow-[0_0_18px_#ff00ff]
        transition-all
      "
        >
            {label}
        </button>
    );
}