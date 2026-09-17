import React from "react";
import Billboard from "./pages/Billboard";
import Expired from "./pages/Expired";
import NDKHeadless from "./components/Ndk";

function App() {
  return <React.Fragment>
    <NDKHeadless />
    {window.location.pathname === "/expired" ? <Expired /> : <Billboard />}
  </React.Fragment>
}

export default App
