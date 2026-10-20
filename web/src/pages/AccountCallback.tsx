import { useEffect } from "react";
import { StatusMessage } from "../components/ui/StatusMessage";

export default function AccountCallback() {
    const sent = !!window.opener;
    useEffect(() => {
        const params = new URLSearchParams(location.search);
        history.replaceState(null, "", "/account/callback");
        if (window.opener) {
            window.opener.postMessage({ type: "holoboard-oauth", state: params.get("state"), code: params.get("code"), error: params.get("error") }, location.origin);
        }
    }, []);
    return <main className="mx-auto max-w-lg p-6"><StatusMessage>{sent ? "Return to Holoboard to finish signing in." : "Start sign-in from Holoboard. Your account window could not find its original tab."}</StatusMessage></main>;
}
