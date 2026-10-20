import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Rpc } from '../src/rpc.ts';
import { restrictedConfig, childEnvironment, restrictCatalog, verifyEffectiveConfig } from '../src/codex.ts';
import { object } from '../src/contract.ts';

// Explicit opt-in: starts the installed native CLI against an exclusively loopback fake provider.
// It uses an empty home, no native credentials and no real inference endpoint.
test('native CLI sends zero effective tools to a loopback fake Responses provider', { skip: process.env.CURATOR_NATIVE_CODEX_TEST !== '1', timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-native-audit-'));
  const executable = process.env.CURATOR_CODEX_BIN ?? 'codex';
  let rpc: Rpc | undefined;
  let resolveCapture: (body: unknown) => void = () => {};
  let captureMarker = 'Local transport audit';
  let captured = new Promise<unknown>(resolve => { resolveCapture = resolve; });
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/responses');
    const chunks: Buffer[] = [];
    for await (const data of req) chunks.push(data as Buffer);
    try { const raw = Buffer.concat(chunks).toString(); if (raw.includes(captureMarker)) resolveCapture(JSON.parse(raw)); }
    catch { resolveCapture(null); }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Intentional local audit stop; no inference', type: 'invalid_request_error' } }));
  });
  try {
    for (const dir of ['codex', 'empty', 'tmp']) await mkdir(join(root, dir), { mode: 0o700 });
    const env = childEnvironment(root);
    const bundled = await promisify(execFile)(executable, ['debug', 'models', '--bundled'], { cwd: join(root, 'empty'), env, maxBuffer: 20_000_000, timeout: 10_000 });
    const catalog = restrictCatalog(JSON.parse(bundled.stdout));
    const catalogPath = join(root, 'catalog.json');
    await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    // Only this test provider can disable native auth. Production always pins the managed OpenAI provider.
    const config = restrictedConfig(catalogPath).replace('forced_login_method = "chatgpt"\n', '').replace('model_provider = "openai"', 'model_provider = "local_audit"') + '\n[model_providers.local_audit]\nname = "Loopback audit"\nbase_url = "http://127.0.0.1:' + address.port + '/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n';
    await writeFile(join(root, 'codex', 'config.toml'), config, { mode: 0o600 });
    const child = spawn(executable, ['app-server', '--stdio', '--strict-config'], { cwd: join(root, 'empty'), env, stdio: ['pipe', 'pipe', 'pipe'] });
    rpc = new Rpc(child);
    await rpc.request('initialize', { clientInfo: { name: 'holoboard_curator_native_audit', version: '0.1.0' }, capabilities: { experimentalApi: true } }, 10_000);
    rpc.notify('initialized');
    verifyEffectiveConfig(await rpc.request('config/read', { includeLayers: false, cwd: join(root, 'empty') }, 10_000), catalogPath, 'local_audit');
    const thread = await rpc.request('thread/start', { cwd: join(root, 'empty'), ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: 'This is a local transport audit. Return {}.', developerInstructions: 'No tools.' }, 10_000);
    assert.ok(object(thread) && object(thread.thread) && typeof thread.thread.id === 'string');
    await rpc.request('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Local transport audit', text_elements: [] }], outputSchema: { type: 'object', properties: {}, additionalProperties: false }, sandboxPolicy: { type: 'readOnly', networkAccess: false } }, 10_000);
    const body = await Promise.race([captured, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('No local provider request')), 10_000).unref())]);
    assert.ok(object(body));
    assert.equal(typeof body.model, 'string');
    assert.ok(Array.isArray(body.input));
    const inventory = (request: Record<string, unknown>): unknown[] => {
      const tools: unknown[] = [];
      if (request.tools != null) { assert.ok(Array.isArray(request.tools)); tools.push(...request.tools); }
      assert.ok(Array.isArray(request.input));
      for (const item of request.input) {
        if (object(item) && ['additional_tools', 'tool_search_output'].includes(String(item.type))) {
          assert.ok(Array.isArray(item.tools)); tools.push(...item.tools);
        }
      }
      return tools;
    };
    const restrictedTools = inventory(body);
    assert.equal(restrictedTools.length, 0, 'Both standard Responses and ResponsesLite tool inventories must be empty');
    await rpc.close(); rpc = undefined;
    // Positive control keeps the same feature gates and restores native tool capabilities.
    // Direct mode makes the remaining metadata-driven declarations visible for inspection.
    const controlCatalog = JSON.parse(bundled.stdout) as { models: Record<string, unknown>[] };
    for (const model of controlCatalog.models) model.tool_mode = 'direct';
    await writeFile(catalogPath, JSON.stringify(controlCatalog), { mode: 0o600 });
    captureMarker = 'POSITIVE_CONTROL_7';
    captured = new Promise<unknown>(resolve => { resolveCapture = resolve; });
    rpc = new Rpc(spawn(executable, ['app-server', '--stdio', '--strict-config'], { cwd: join(root, 'empty'), env, stdio: ['pipe', 'pipe', 'pipe'] }));
    await rpc.request('initialize', { clientInfo: { name: 'holoboard_curator_positive_control', version: '0.1.0' } }, 10_000);
    rpc.notify('initialized');
    const controlThread = await rpc.request('thread/start', { cwd: join(root, 'empty'), ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: 'Local audit only.' }, 10_000);
    assert.ok(object(controlThread) && object(controlThread.thread));
    await rpc.request('turn/start', { threadId: controlThread.thread.id, input: [{ type: 'text', text: 'POSITIVE_CONTROL_7', text_elements: [] }] }, 10_000);
    const control = await Promise.race([captured, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('No positive-control request')), 10_000).unref())]);
    assert.ok(object(control));
    const controlTools = inventory(control);
    assert.ok(controlTools.length > 0, 'Positive control must expose native tool declarations');
    assert.ok(JSON.stringify(controlTools).includes('clock'));
    process.stdout.write(JSON.stringify({ audit: 'native_loopback_only', restricted_tools: restrictedTools.length, control_tools: controlTools.length }) + '\n');
  } finally {
    if (rpc) await rpc.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
