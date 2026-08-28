export function PixelCard({ children, className }: { children: React.ReactNode, className?: string }) {
    return (
        <div
            className={`
        pixel-corners
        card
        bg-[#090018]
        border-2 border-cyan-400
        p-6
        shadow-[0_0_20px_#00ffff55]
        col-span-3
        ${className}
      `}
        >
            {children}
        </div>
    );
}