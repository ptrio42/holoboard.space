// Textareas expose LF line breaks and UTF-16 selection offsets. Map those
// offsets back to the signed content without changing its original characters.
function textareaSource(content: string): { text: string; offsets: number[] } {
    let text = "";
    const offsets = [0];
    for (let index = 0; index < content.length; index++) {
        const char = content[index];
        if (char === "\r" && content[index + 1] === "\n") index++;
        text += char === "\r" ? "\n" : char;
        offsets.push(index + 1);
    }
    return { text, offsets };
}

export function selectedNoteText(content: string, start: number, end: number): string {
    const { offsets } = textareaSource(content);
    return content.slice(offsets[start], offsets[end]);
}

export function noteTextSelection(content: string, fragment: string): [number, number] | undefined {
    if (!fragment || !content.includes(fragment)) return undefined;
    const { text, offsets } = textareaSource(content);
    const normalized = textareaSource(fragment).text;
    let start = text.indexOf(normalized);
    while (start >= 0) {
        if (content.slice(offsets[start], offsets[start + normalized.length]) === fragment) {
            return [start, start + normalized.length];
        }
        start = text.indexOf(normalized, start + 1);
    }
    return undefined;
}
