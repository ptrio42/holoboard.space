import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Validate the literal COPY forms used by the web image without a Docker engine. */
export async function checkWebContainerContext({ dockerfileText } = {}) {
    const dockerfile = dockerfileText ?? await readFile(resolve(root, "web/Dockerfile"), "utf8");
    const stages = new Set();
    const sources = [];
    let stageCopies = 0;
    let workdir = "/";
    let imageSources = new Map();
    async function imageFile(path) {
        for (const [destination, source] of [...imageSources].reverse()) {
            const tail = posix.relative(destination, path);
            if (tail === "" || tail !== ".." && !tail.startsWith("../") && (await stat(source)).isDirectory()) {
                const host = tail ? resolve(source, tail) : source;
                if ((await stat(host).catch(() => null))?.isFile()) return host;
            }
        }
        throw new Error(`Required image input is unavailable before RUN: ${path}`);
    }
    for (const line of dockerfile.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
        const stage = line.match(/^\s*FROM\s+\S+\s+AS\s+(\S+)/i);
        if (stage) { stages.add(stage[1]); imageSources = new Map(); workdir = "/"; }
        const directory = line.match(/^\s*WORKDIR\s+(\S+)/i);
        if (directory) workdir = posix.resolve(workdir, directory[1]);
        if (/^\s*RUN\s+npm\s+ci(?:\s|$)/.test(line)) {
            const manifest = JSON.parse(await readFile(await imageFile(posix.join(workdir, "package.json")), "utf8"));
            await imageFile(posix.join(workdir, "package-lock.json"));
            const preinstall = manifest.scripts?.preinstall;
            assert.match(preinstall ?? "", /^npm ci --prefix \S+ --ignore-scripts --legacy-peer-deps$/, "Review the manifest-only preinstall workflow");
            const prefix = posix.resolve(workdir, preinstall.match(/--prefix (\S+)/)[1]);
            await imageFile(posix.join(prefix, "package.json"));
            await imageFile(posix.join(prefix, "package-lock.json"));
        }
        if (/^\s*RUN\s+npm\s+run\s+build\s*$/.test(line)) {
            const manifest = JSON.parse(await readFile(await imageFile(posix.join(workdir, "package.json")), "utf8"));
            const prefix = manifest.scripts?.prebuild?.match(/^npm run build --prefix (\S+)$/)?.[1];
            assert.ok(prefix, "Review the shared package prebuild workflow");
            for (const path of ["tsconfig.json", "scripts/build.mjs", "src/core/index.ts", "src/react/index.ts"]) {
                await imageFile(posix.resolve(workdir, prefix, path));
            }
        }
        const copy = line.match(/^\s*COPY\s+(.+)$/i);
        if (!copy) continue;
        const fields = copy[1].trim().split(/\s+/);
        let from;
        while (fields[0]?.startsWith("--")) {
            const option = fields.shift();
            assert.ok(option.startsWith("--from="), `Unsupported COPY option: ${option}`);
            from = option.slice("--from=".length);
        }
        assert.ok(fields.length >= 2, `Invalid COPY instruction: ${line}`);
        const destination = fields.pop();
        for (const source of fields) {
            assert.ok(!/[\[\]"'$*?]/.test(source), `Review unsupported COPY source syntax: ${source}`);
            if (from) {
                assert.ok(stages.has(from), `Unknown COPY stage: ${from}`);
                assert.ok(source.startsWith("/"), `Use an absolute stage source: ${source}`);
                stageCopies++;
                continue;
            }
            const path = resolve(root, source);
            const local = relative(root, path);
            assert.ok(local && local !== ".." && !local.startsWith(`..${sep}`), `COPY escapes the build context: ${source}`);
            const info = await stat(path).catch(() => { throw new Error(`COPY source is missing from the repository build context: ${source}`); });
            const target = posix.resolve(workdir, destination);
            const directoryTarget = fields.length > 1 || destination.endsWith("/") || destination === ".";
            const copiedPath = info.isDirectory() || !directoryTarget ? target : posix.join(target, basename(source));
            imageSources.set(copiedPath, path);
            sources.push(source);
        }
    }
    assert.ok(sources.length, "The web image has no checked context sources.");
    console.log(`PASS web build context: ${sources.length} local COPY sources exist; ${stageCopies} stage COPY source references a declared stage; manifest-only install and source prebuild inputs are available.`);
    return sources;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await checkWebContainerContext();
