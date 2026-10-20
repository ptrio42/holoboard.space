import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import AccountCallback from "./pages/AccountCallback";

// OAuth returns must not boot board reads, payment restoration or signers.
createRoot(document.getElementById("root")!).render(<StrictMode><AccountCallback /></StrictMode>);
