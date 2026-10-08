import { createContext } from "react";

/** Popovers escape clipped frames while remaining owned by the dialog. */
export const ModalPopoverHost = createContext<HTMLElement | null>(null);
