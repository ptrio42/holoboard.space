import { useEffect, useSyncExternalStore } from "react";
import { getConnections, restoreConnections, subscribeConnections } from "../lib/connections";

export function useConnections() {
    const connections = useSyncExternalStore(subscribeConnections, getConnections);
    useEffect(restoreConnections, []);
    return connections;
}
