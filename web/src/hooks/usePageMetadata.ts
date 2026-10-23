import { useEffect } from "react";

export function usePageMetadata(title: string, description: string) {
    useEffect(() => {
        const previousTitle = document.title;
        document.title = title;
        const values = [
            ["name", "description", description],
            ["property", "og:title", title],
            ["property", "og:description", description],
            ["property", "og:url", window.location.origin + window.location.pathname],
            ["name", "twitter:title", title],
            ["name", "twitter:description", description],
        ];
        const restore = values.map(([attribute, key, value]) => {
            const existing = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
            const element = existing ?? document.createElement("meta");
            const previous = element.getAttribute("content");
            element.setAttribute(attribute, key);
            element.content = value;
            if (!existing) document.head.appendChild(element);
            return () => {
                if (!existing) element.remove();
                else if (previous === null) element.removeAttribute("content");
                else element.content = previous;
            };
        });
        return () => {
            document.title = previousTitle;
            restore.forEach(reset => reset());
        };
    }, [title, description]);
}
