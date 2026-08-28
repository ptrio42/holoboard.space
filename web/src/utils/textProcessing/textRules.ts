export type TextRule = (text: string) => string;

const IMAGE_REGEX =
    /(https?:\/\/[^\s]+?\.(?:png|jpe?g|gif|webp|svg))/gi;

export const rules: TextRule[] = [
    // image URL → <img>
    (text) =>
        text.replace(
            IMAGE_REGEX,
            '<img src="$1" alt="" loading="lazy" />'
        ),

    // newline → <br>
    (text) =>
        text.replace(/\r?\n/g, '<br />'),
];
