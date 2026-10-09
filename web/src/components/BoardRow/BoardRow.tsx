import { NoteCard, type NoteCardProps } from "./NoteCard";

export function BoardRow(props: NoteCardProps) {
    const { event, readingFocus = false } = props;
    return <li data-board-note={readingFocus ? undefined : event.id} data-reading-focus={readingFocus ? event.id : undefined}
        data-discussion-key={readingFocus ? `event:${event.id}` : undefined} id={readingFocus ? `discussion-note-${event.id}` : undefined}
        tabIndex={readingFocus ? -1 : undefined} style={{ marginTop: "var(--reading-gap, 0px)" }}>
        <NoteCard {...props} />
    </li>;
}
