import './App.css'
import Billboard from "./pages/Billboard";
import React from "react";
import NDKHeadless from "./components/Ndk";

function App() {
  return <React.Fragment>
    <NDKHeadless />
    <Billboard/>
  </React.Fragment>
}

export default App
