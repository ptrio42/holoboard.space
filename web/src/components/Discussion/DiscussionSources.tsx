import type { DiscussionSnapshot } from "../../lib/discussionReads";
import { coverageCounts, discussionSources, type CoverageState } from "../../lib/discussionView";

const labels: Record<CoverageState, string> = {
    found: "reference found", finished: "finished", limited: "at reading limit",
    retry: "need retry", queued: "await first result", more: "await another page",
};
function summary(work: DiscussionSnapshot["coverage"]) {
    return Object.entries(coverageCounts(work)).filter(([, count]) => count > 0)
        .map(([state, count]) => `${count} ${labels[state as CoverageState]}`).join("; ");
}
export function DiscussionSources({ snapshot }: { snapshot: DiscussionSnapshot }) {
    const sources = discussionSources(snapshot);
    const cached = snapshot.routing.filter(route => route.fromCache).length;
    return <details className="mt-3 text-xs text-cyan-100/75">
        <summary className="focus-pixel inline-flex min-h-11 cursor-pointer items-center">Source details</summary>
        <p>{snapshot.requests} read operations. {sources.length} selected relays, each listed once below.</p>
        <p className="mt-2">Content coverage: {summary(snapshot.coverage) || "no queries planned yet"}.</p>
        {cached > 0 && <p className="mt-2">{cached} author relay {cached === 1 ? "list reused" : "lists reused"} from cache.</p>}
        <p className="mt-2">Coverage includes queued work and retries. These counters do not count open subscriptions. Load more continues available work, including retries.</p>
        <p className="mt-2">Public mentions / replies relays receive responses to an author. Author notes relays carry their own posts. DM relay lists are not used for this discussion.</p>
        <ul className="mt-3 space-y-3" aria-label="Relay sources">{sources.map(source => <li key={source.relay} className="min-w-0 break-words border-l-2 border-cyan-400/25 pl-3" data-source-relay={source.relay}>
            <p className="break-all text-cyan-100">{source.relay}</p>
            {(source.inbox > 0 || source.outbox > 0) && <p>{[source.inbox > 0 && "Public mentions / replies", source.outbox > 0 && "Author notes"].filter(Boolean).join("; ")}</p>}
            {source.work.length > 0 && <>
                <p>{source.work.filter(work => work.purpose === "descendants").length} reply queries, {source.work.filter(work => work.purpose === "ancestor").length} context queries.</p>
                <p>{summary(source.work)}.</p>
                {source.work.some(work => work.outcome && !["eose", "found"].includes(work.outcome) && !work.satisfied) && <p>Last incomplete results: {Object.entries(source.work.reduce<Record<string, number>>((counts, work) => {
                    if (work.outcome && !["eose", "found"].includes(work.outcome) && !work.satisfied) counts[work.outcome] = (counts[work.outcome] ?? 0) + 1;
                    return counts;
                }, {})).map(([outcome, count]) => `${count} ${outcome}`).join("; ")}.</p>}
            </>}
            {source.discovery > 0 && <p>Relay-list discovery: {source.discovery} checks, {source.discoveryFailed} incomplete ({Object.entries(source.discoveryOutcomes).map(([outcome, count]) => `${count} ${outcome}`).join("; ")}).</p>}
        </li>)}</ul>
    </details>;
}
