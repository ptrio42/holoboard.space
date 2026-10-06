import React from "react";
import Billboard from "./pages/Billboard";
import Expired from "./pages/Expired";
import NDKHeadless from "./components/Ndk";
import Help from "./pages/Help";
import { ConnectionControls } from "./components/PromoteModal/ConnectionControls";

function App() {
  return <React.Fragment>
    <NDKHeadless />
    {window.location.pathname === "/help" && <ConnectionControls />}
    {window.location.pathname === "/help" ? <Help /> : window.location.pathname === "/expired" ? <Expired /> : <Billboard />}
  </React.Fragment>
}

export default App
