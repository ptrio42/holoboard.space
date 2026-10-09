import type { ContentToken } from "../utils/textProcessing/parseContent";

export type TextFormat = "strong" | "em" | "code" | "del";
export type NoteTextToken = ContentToken
    | { kind: "formatted"; value: string; formats: readonly TextFormat[] }
    | { kind: "article-link"; href: string; label: string };

/** Removed media URLs must not leave empty paragraphs before a gallery. */
export function noteTextTokens(tokens: ContentToken[]): ContentToken[] {
    const output: ContentToken[] = [];
    for (const token of tokens) {
        const previous = output.at(-1);
        if (token.kind === "text" && previous?.kind === "text") previous.value += token.value;
        else output.push({ ...token });
    }
    for (const token of output) if (token.kind === "text") token.value = token.value.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
    if (output[0]?.kind === "text") {
        output[0].value = output[0].value.trimStart();
        if (!output[0].value) output.shift();
    }
    const last = output.at(-1);
    if (last?.kind === "text") {
        last.value = last.value.trimEnd();
        if (!last.value) output.pop();
    }
    return output;
}
