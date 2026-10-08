import { Fragment, useEffect, useState } from "react";
import Billboard from "./pages/Billboard";
import Expired from "./pages/Expired";
import Discussion from "./pages/Discussion";
import Profile from "./pages/Profile";
import NDKHeadless from "./components/Ndk";
import Help from "./pages/Help";
import { ConnectionControls } from "./components/PromoteModal/ConnectionControls";
import { ENABLE_DISCUSSIONS, ENABLE_PROFILES } from "./config";
import { discussionRoute, profileRoute } from "./lib/readingRoutes";
import { useReadingPosition } from "./hooks/useReadingPosition";

const locationPath = () => window.location.pathname + window.location.search;
const readingRoute = (path: string) => {
  const discussion = ENABLE_DISCUSSIONS ? discussionRoute(path) : null;
  const profile = ENABLE_PROFILES ? profileRoute(path) : null;
  return discussion ? { type: "discussion" as const, value: discussion } : profile ? { type: "profile" as const, value: profile } : null;
};
function App() {
  const [path, setPath] = useState(locationPath);
  const route = readingRoute(path);
  const [boardPath, setBoardPath] = useState<string | null>(() => route ? null : path);
  useEffect(() => {
    const change = () => {
      const next = locationPath();
      if (!readingRoute(next)) setBoardPath(next);
      setPath(next);
    };
    window.addEventListener("popstate", change);
    return () => window.removeEventListener("popstate", change);
  }, []);
  useReadingPosition(path, ENABLE_DISCUSSIONS || ENABLE_PROFILES);
  const boardName = boardPath?.split("?")[0];
  return <Fragment>
    <NDKHeadless />
    {/* Retain the board's rows, disclosures and position while reading. */}
    {boardPath && <div hidden={!!route} data-reading-surface className="reading-surface">
      {boardName === "/help" && <ConnectionControls />}
      {boardName === "/help" ? <Help /> : boardName === "/expired" ? <Expired /> : <Billboard pathname={boardName} />}
    </div>}
    {route && <div data-reading-surface className="reading-surface">
      {route.type === "discussion" ? <Discussion key={route.value.focusId} {...route.value} /> : <Profile key={route.value.pubkey} {...route.value} />}
    </div>}
  </Fragment>;
}

export default App;
