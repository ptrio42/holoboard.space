export function PixelSmallButton({ label }: { label: string }) {
    return (
        <button
            className="
        border-2 border-cyan-400 text-cyan-300 bg-[#05010d]
        px-3 py-1 text-xs tracking-widest uppercase
        shadow-[0_0_8px_#00ffff88]
        hover:translate-x-[2px] hover:translate-y-[2px]
        hover:border-pink-500 hover:text-pink-400 hover:shadow-[0_0_12px_#ff00ff]
      "
        >
            {label}
        </button>
    );
}