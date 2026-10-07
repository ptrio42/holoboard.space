import { Fragment, useEffect, useLayoutEffect, useState } from "react";
import Billboard from "./pages/Billboard";
import Expired from "./pages/Expired";
import Discussion from "./pages/Discussion";
import NDKHeadless from "./components/Ndk";
import Help from "./pages/Help";
import { ConnectionControls } from "./components/PromoteModal/ConnectionControls";
import { ENABLE_DISCUSSIONS } from "./config";
import { discussionRoute } from "./lib/discussionView";

const locationPath = () => window.location.pathname + window.location.search;
function App() {
  const [path, setPath] = useState(locationPath);
  const route = ENABLE_DISCUSSIONS ? discussionRoute(path) : null;
  const [boardPath, setBoardPath] = useState<string | null>(() => route ? null : path);
  useEffect(() => {
    const change = () => {
      const next = locationPath();
      if (!ENABLE_DISCUSSIONS || !discussionRoute(next)) setBoardPath(next);
      setPath(next);
    };
    window.addEventListener("popstate", change);
    return () => window.removeEventListener("popstate", change);
  }, []);
  useLayoutEffect(() => {
    if (ENABLE_DISCUSSIONS) window.scrollTo(0, window.history.state?.readingScroll ?? 0);
  }, [path]);
  const boardName = boardPath?.split("?")[0];
  return <Fragment>
    <NDKHeadless />
    {/* Retain the board's rows, disclosures and position while reading a discussion. */}
    {boardPath && <div hidden={!!route}>
      {boardName === "/help" && <ConnectionControls />}
      {boardName === "/help" ? <Help /> : boardName === "/expired" ? <Expired /> : <Billboard pathname={boardName} />}
    </div>}
    {route && <Discussion key={route.focusId} {...route} />}
  </Fragment>;
}

export default App;
