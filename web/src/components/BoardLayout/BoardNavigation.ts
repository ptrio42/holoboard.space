import { createContext } from "react";

/** The last waiting-room URL belongs to this app session, independently of accounts. */
export const WaitingRoomLocation = createContext("/waiting");
