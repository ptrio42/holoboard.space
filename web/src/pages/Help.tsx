import { HelpContent } from "../components/Help/HelpContent";

export default function Help() {
    return <main className="mx-auto min-h-dvh max-w-3xl px-5 pt-6 pb-16 sm:px-8">
        <a href="/" className="focus-pixel mb-6 inline-flex min-h-11 items-center text-sm text-neon-cyan">&lt; Back to board</a>
        <h1 className="mb-8 font-pixel text-lg leading-relaxed text-neon-pink">Holoboard help</h1>
        <HelpContent section={window.location.hash.slice(1)} />
    </main>;
}
