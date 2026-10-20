import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { expect } from "@playwright/test";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";

// Build and run Compose with disposable data and an isolated backend network.
// Nginx also joins a preview bridge; browser guards restrict it to loopback.
// Never load a checkout's .env or mount an existing ledger.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = await mkdtemp(join(tmpdir(), "holoboard-release-smoke-"));
const project = `holoboard-smoke-${Date.now()}-${process.pid}`;
const flags = ["NOSTR_CONNECT", "DISCUSSIONS", "PROFILES", "REPLY_PUBLICATION"];
const withFeatures = process.argv.includes("--with-features");
const report = { mode: "isolated runtime, mock invoices, no public Nostr writes", checks: [] };
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(VITE_|COMPOSE_|RELAY_|FETCH_RELAYS$|DM_RELAYS$|WEB_|LIGHTNING_BACKEND$|NWC_URI$|DATA_FILE$|PUBLIC_BOARD_URL$)/.test(key)));
let started = false;
let localEngine = false;
let browser;

async function run(args, { capture = false } = {}) {
    return new Promise((accept, reject) => {
        const child = spawn("docker", args, { cwd: directory, env: environment, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", data => { output += data; if (!capture) process.stdout.write(data); });
        child.stderr.on("data", data => { if (!capture) process.stderr.write(data); });
        child.once("error", reject);
        child.once("exit", code => code === 0 ? accept(output) : reject(new Error(`docker ${args[0]} failed (${code})`)));
    });
}

async function availablePort() {
    const listener = createServer();
    await new Promise((accept, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", accept); });
    const port = listener.address().port;
    await new Promise(accept => listener.close(accept));
    return port;
}

function check(name) { report.checks.push(name); console.log(`PASS ${name}`); }

try {
    const context = (!process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST) || JSON.parse(await run([
        "context", "inspect", ...(process.env.DOCKER_CONTEXT ? [process.env.DOCKER_CONTEXT] : []),
        "--format", "{{json .Endpoints.docker.Host}}",
    ], { capture: true }));
    assert.match(context, /^(unix:\/\/|npipe:\/\/)/, "Use a local Docker engine, never a remote release host");
    localEngine = true;
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const relay = `ws://127.0.0.1:${port}/relay`;
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    await writeFile(join(directory, ".env"), [
        `RELAY_PRIVKEY=${Buffer.from(secret).toString("hex")}`, `VITE_RELAY_PUBKEY=${pubkey}`,
        `WEB_PORT=${port}`, "WEB_BIND_ADDRESS=127.0.0.1", `VITE_RELAY_URL=${relay}`,
        "LIGHTNING_BACKEND=mock", "FETCH_RELAYS=ws://127.0.0.1:9", "DM_RELAYS=ws://127.0.0.1:9",
        `PUBLIC_BOARD_URL=${origin}`, ...flags.map(flag => `VITE_ENABLE_${flag}=false`), "",
    ].join("\n"), { mode: 0o600 });
    const override = {
        services: {
            relay: { build: { context: join(root, "relay") }, restart: "no" },
            web: { build: { context: root, dockerfile: "web/Dockerfile", args: { VITE_PUBLIC_RELAYS: relay } },
                networks: ["default", "preview"], restart: "no" },
        },
        networks: { default: { internal: true }, preview: {} },
    };
    await writeFile(join(directory, "override.json"), JSON.stringify(override));
    const composeArgs = ["compose", "--parallel", "1", "--project-name", project, "--project-directory", directory,
        "--env-file", join(directory, ".env"), "-f", join(root, "compose.yaml"), "-f", join(directory, "override.json")];
    const compose = (args, options) => run([...composeArgs, ...args], options);
    const config = JSON.parse(await compose(["config", "--format", "json"], { capture: true }));
    assert.equal(config.networks.default.internal, true);
    assert.equal(config.services.web.ports[0].host_ip, "127.0.0.1");
    assert.equal(config.services.relay.ports, undefined);
    assert.deepEqual(Object.keys(config.services.relay.networks), ["default"]);
    assert.equal(config.services.relay.environment.LIGHTNING_BACKEND, "mock");
    assert.deepEqual(config.services.relay.volumes.map(volume => volume.source), ["relay_data"]);
    assert.equal(config.volumes.relay_data.name, `${project}_relay_data`);
    for (const flag of flags) assert.equal(config.services.web.build.args[`VITE_ENABLE_${flag}`], "false");
    check("Compose isolation, fresh volume, mock backend and disabled feature defaults");

    await compose(["build"]);
    // The final Fly stage must remain independently buildable after vendoring.
    await run(["build", "--target", "fly", "-t", `${project}-fly`, join(root, "relay")]);
    const fly = JSON.parse(await run(["image", "inspect", `${project}-fly`], { capture: true }))[0].Config;
    assert.equal(fly.User ?? "", "");
    assert.ok(fly.Env.includes("DATA_FILE=/root/data/relay_data.json"));
    assert.equal((await run(["run", "--rm", "--network", "none", `${project}-fly`, "id", "-u"], { capture: true })).trim(), "0");
    check("Standalone and Fly images build; Fly retains its existing volume path and user");

    started = true;
    await compose(["up", "--detach", "--wait", "--wait-timeout", "150", "--no-build"]);
    const webID = (await compose(["ps", "--quiet", "web"], { capture: true })).trim();
    const networks = JSON.parse(await run(["inspect", webID, "--format", "{{json .NetworkSettings.Networks}}"], { capture: true }));
    assert.deepEqual(Object.keys(networks).sort(), [`${project}_default`, `${project}_preview`]);
    const relayID = (await compose(["ps", "--quiet", "relay"], { capture: true })).trim();
    const relayNetworks = JSON.parse(await run(["inspect", relayID, "--format", "{{json .NetworkSettings.Networks}}"], { capture: true }));
    assert.deepEqual(Object.keys(relayNetworks), [`${project}_default`]);
    const network = JSON.parse(await run(["network", "inspect", `${project}_default`], { capture: true }))[0];
    assert.equal(network.Internal, true);
    assert.equal((await compose(["exec", "-T", "relay", "id", "-u"], { capture: true })).trim(), "10001");
    await compose(["exec", "-T", "web", "nginx", "-t"]);
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
    check("Healthy services, internal-only backend network, non-root standalone relay and valid nginx");

    async function json(path, options) {
        const response = await fetch(`${origin}/relay${path}`, { ...options, signal: AbortSignal.timeout(25000) });
        assert.equal(response.status, 200, `${path} HTTP status`);
        assert.match(response.headers.get("content-type"), /application\/json/);
        return response.json();
    }
    const board = await json("/api/board");
    assert.equal(board.posts, 1);
    const campaigns = await json("/api/board/campaigns?view=board&page=1");
    const note = campaigns.entries[0].event;
    assert.equal(note.pubkey, pubkey);
    assert.ok(verifyEvent({ ...note }));
    await json("/api/board/waiting-updates");
    const blocked = await fetch(`${origin}/relay/api/link-preview?url=http%3A%2F%2F127.0.0.1%3A1`, { signal: AbortSignal.timeout(5000) });
    assert.equal(blocked.status, 400);
    assert.match(blocked.headers.get("content-type"), /application\/json/);
    check("Proxied board, campaign and waiting APIs; signed identity; private preview rejected");

    await new Promise((accept, reject) => {
        const socket = new WebSocket(relay);
        let found = false;
        const deadline = setTimeout(() => finish(new Error("WebSocket did not complete a stored-event query")), 10000);
        const finish = error => { clearTimeout(deadline); socket.close(); error ? reject(error) : accept(); };
        socket.addEventListener("error", () => finish(new Error("WebSocket connection failed")), { once: true });
        socket.addEventListener("open", () => socket.send(JSON.stringify(["REQ", "release-smoke", { ids: [note.id] }])));
        socket.addEventListener("message", ({ data }) => {
            try {
                const frame = JSON.parse(data);
                if (frame[0] === "EVENT" && frame[1] === "release-smoke") {
                    assert.equal(frame[2].id, note.id); assert.ok(verifyEvent(frame[2])); found = true;
                }
                if (frame[0] === "EOSE" && frame[1] === "release-smoke") {
                    assert.ok(found); socket.send(JSON.stringify(["CLOSE", "release-smoke"])); finish();
                }
            } catch (error) { finish(error); }
        });
    });
    check("Native WebSocket through nginx returns verified EVENT and EOSE, then accepts CLOSE");

    const post = body => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const invoice = await json("/api/promote", post({ note: note.id, amount_sats: 21, author_share: 0 }));
    assert.match(invoice.invoice, /mock_invoice/);
    assert.equal(invoice.note_id, note.id);
    assert.equal(invoice.amount_sats, 21);
    const statusPath = `/api/promote/status?note=${note.id}&payment_hash=${invoice.payment_hash}`;
    assert.equal((await json(statusPath)).pending, true);
    check("Anonymous API prepares an unpaid mock invoice without an account or payer wallet");

    browser = await chromium.launch({ channel: "chrome", headless: true });
    const browserContext = await browser.newContext({ serviceWorkers: "block" });
    const page = await browserContext.newPage();
    const pageErrors = [];
    const blockedTraffic = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await browserContext.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) { blockedTraffic.push(url.origin); return route.abort(); }
        return route.continue();
    });
    await browserContext.routeWebSocket("**/*", socket => {
        if (socket.url() !== relay) { blockedTraffic.push(socket.url()); return socket.close(); }
        socket.connectToServer();
    });
    await page.goto(origin);
    await page.locator("[data-board-note]").first().waitFor({ timeout: 20000 });
    assert.equal(await page.getByRole("link", { name: "Discussion", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: /Connect Nostr/i }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Reply", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Boost", exact: true }).first().click();
    await page.getByRole("link", { name: /^Author:/ }).waitFor();
    const allocation = page.getByRole("slider", { name: "Holoboard share in percent" });
    await allocation.focus();
    await page.keyboard.press("End");
    await expect(allocation).toHaveValue("100");
    await expect(page.getByRole("button", { name: /^Boost \d+ sats$/ })).toBeEnabled({ timeout: 30000 });
    assert.deepEqual(pageErrors, []);
    report.blockedBrowserRequests = blockedTraffic.length;
    const chunks = (await compose(["exec", "-T", "web", "find", "/usr/share/nginx/html/assets", "-name", "*ReplyComposer*"], { capture: true })).trim();
    assert.equal(chunks, "");
    check("Actual nginx bundle renders notes and anonymous boost; signer, discussion and reply controls stay hidden");
    await browser.close(); browser = undefined;

    await compose(["stop", "relay"]);
    const logs = await compose(["logs", "--no-color", "relay"], { capture: true });
    assert.match(logs, /Shutdown complete/);
    await compose(["up", "--detach", "--wait", "--wait-timeout", "150", "--no-build"]);
    assert.equal((await json("/api/board/campaigns?view=board&page=1")).entries[0].event.id, note.id);
    const restored = await json(statusPath);
    assert.equal(restored.pending, true);
    assert.equal(restored.settled, false);
    check("SIGTERM finishes shutdown; restart preserves identity, original note and pending invoice");

    for (const flag of flags) override.services.web.build.args[`VITE_ENABLE_${flag}`] = "true";
    await writeFile(join(directory, "override.json"), JSON.stringify(override));
    const enabled = JSON.parse(await compose(["config", "--format", "json"], { capture: true }));
    for (const flag of flags) assert.equal(enabled.services.web.build.args[`VITE_ENABLE_${flag}`], "true");
    check("Compose forwards explicit opt-in feature build arguments");
    if (withFeatures) {
        await compose(["build", "web"]);
        await compose(["up", "web", "--detach", "--no-deps", "--force-recreate", "--wait", "--no-build"]);
        const enabledChunks = (await compose(["exec", "-T", "web", "find", "/usr/share/nginx/html/assets", "-name", "*ReplyComposer*"], { capture: true })).trim();
        assert.notEqual(enabledChunks, "", "Explicit feature build args must reach Vite");
        check("Explicit feature build args include the reply editor in a separate opt-in image");
    }
    report.passed = true;
} finally {
    await browser?.close();
    if (started) await run(["compose", "--project-name", project, "--project-directory", directory,
        "--env-file", join(directory, ".env"), "-f", join(root, "compose.yaml"), "-f", join(directory, "override.json"),
        "down", "--volumes", "--remove-orphans"]);
    // These names are created by this invocation, never an existing board.
    for (const image of localEngine ? [`${project}-web`, `${project}-relay`, `${project}-fly`] : []) {
        try { await run(["image", "rm", image], { capture: true }); } catch { /* A failed build may not create an image. */ }
    }
    await rm(directory, { recursive: true, force: true });
    console.log(JSON.stringify(report, null, 2));
}
