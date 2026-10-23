import { lazy, Suspense, type ComponentProps } from "react";
import type ViewerPropsSource from "./NoteMediaViewer";
import { useClient } from "../ClientProvider";
import { StatusMessage } from "../primitives/StatusMessage";
import { MediaSourceLinks } from "./MediaSourceLinks";

const Viewer = lazy(() => import("./NoteMediaViewer"));

/** Keep the public barrel from loading the viewer before it is opened. */
export function NoteMediaViewer(props: ComponentProps<typeof ViewerPropsSource>) {
    useClient();
    if (typeof document === "undefined") return <MediaSourceLinks items={props.items} />;
    return <Suspense fallback={<StatusMessage loading compact>Opening media</StatusMessage>}>
        <Viewer {...props} />
    </Suspense>;
}
