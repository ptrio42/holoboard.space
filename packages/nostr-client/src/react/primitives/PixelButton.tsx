import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "accent" | "ghost";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
    primary: "",
    accent: "pixel-btn--accent",
    ghost: "pixel-btn--ghost",
};

const SIZES: Record<Size, string> = {
    sm: "px-3 py-2 text-[9px]",
    md: "px-5 py-3 text-[10px] sm:text-[11px]",
    lg: "px-7 py-4 text-xs sm:text-sm",
};

const shell = (variant: Variant, className: string) =>
    `pixel-btn ${VARIANTS[variant]} ${className}`;

interface PixelButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    children: ReactNode;
    variant?: Variant;
    size?: Size;
}

export function PixelButton({
    children,
    variant = "primary",
    size = "md",
    className = "",
    type = "button",
    ...rest
}: PixelButtonProps) {
    return (
        <button type={type} className={shell(variant, className)} {...rest}>
            <span className={`pixel-btn__face ${SIZES[size]}`}>{children}</span>
        </button>
    );
}

interface PixelLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
    children: ReactNode;
    variant?: Variant;
    size?: Size;
}

/** Same shape as PixelButton, for the places where a link is the honest element. */
export function PixelLink({
    children,
    variant = "primary",
    size = "md",
    className = "",
    ...rest
}: PixelLinkProps) {
    return (
        <a className={shell(variant, className)} {...rest}>
            <span className={`pixel-btn__face ${SIZES[size]}`}>{children}</span>
        </a>
    );
}
