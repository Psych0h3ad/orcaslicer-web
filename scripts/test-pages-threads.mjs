#!/usr/bin/env node
/**
 * CI browser regression for our GitHub Pages isolation service worker.
 * Uses a fresh, headless Chromium profile and a plain local HTTP server, with
 * no COOP/COEP response headers. It does not automate the app or personal data.
 *
 * Run after the production build, with Playwright Chromium installed in CI:
 *   npx playwright install --with-deps chromium
 *   node scripts/test-pages-threads.mjs
 * Optional real MT slice (requires `npm run test:engine` outputs and MT assets):
 *   node scripts/test-pages-threads.mjs --engine
 *
 * This proves shared WASM memory across module/nested-module workers. It does
 * not prove that the Orca MT slicing engine can finish a slice in the browser.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const basePath = '/orcaslicer-web/';
const fixtureName = '__thread-test__';
const fixtureRoot = join(dist, fixtureName);
const testEngine = process.argv.includes('--engine');
assert.ok(process.argv.slice(2).every((arg) => arg === '--engine'), 'Usage: node scripts/test-pages-threads.mjs [--engine]');
assert.equal(dirname(fixtureRoot), dist, 'Temporary fixture must stay directly inside dist/');
await stat(join(dist, 'index.html'));
await stat(join(dist, 'thread-isolation-sw.js'));

const fixtureFiles = {
  'index.html': `<!doctype html><html><head><meta charset="utf-8"><title>Pages thread regression</title><link rel="icon" href="data:,"></head><body><p>Automated isolation test</p><script type="module" src="./probe-page.mjs"></script></body></html>`,
  'probe-page.mjs': String.raw`
const result = { done: false, ok: false, visits: 0, automaticReloads: 0 };
window.__threadTest = result;
const MARK = 'orcaslicer-web:test:thread-visits';
const deadline = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(label + ' timed out')), ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});
try {
  result.visits = Number(sessionStorage.getItem(MARK) || 0) + 1;
  sessionStorage.setItem(MARK, String(result.visits));
  result.automaticReloads = result.visits - 1;
  const appRoot = new URL('../', location.href);
  if (!crossOriginIsolated) {
    if (result.visits !== 1) throw new Error('The service worker did not isolate the page after one reload');
    const reg = await navigator.serviceWorker.register(new URL('thread-isolation-sw.js', appRoot), {
      scope: appRoot.pathname, updateViaCache: 'none',
    });
    result.scope = reg.scope;
    await deadline(navigator.serviceWorker.ready, 12000, 'Service worker activation');
    if (!navigator.serviceWorker.controller) {
      await deadline(new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })), 5000, 'Service worker control');
    }
    const controller = navigator.serviceWorker.controller;
    if (!controller || new URL(controller.scriptURL).pathname !== new URL('thread-isolation-sw.js', appRoot).pathname)
      throw new Error('The expected service worker does not control the fixture');
    location.reload();
  } else {
    if (result.visits !== 2) throw new Error('Expected exactly one activation reload');
    result.pageIsolated = crossOriginIsolated;
    result.scope = (await navigator.serviceWorker.getRegistration(location.href))?.scope;
    result.sharedArrayBuffer = typeof SharedArrayBuffer === 'function';
    if (!result.sharedArrayBuffer) throw new Error('SharedArrayBuffer is unavailable');
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    if (!(memory.buffer instanceof SharedArrayBuffer)) throw new Error('WebAssembly memory is not shared');
    const words = new Int32Array(memory.buffer);
    const worker = new Worker(new URL('./probe-parent.mjs', import.meta.url), { type: 'module', name: 'pages-thread-parent' });
    try {
      const response = await deadline(new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
        worker.onerror = (event) => { event.preventDefault(); reject(new Error(event.message || 'Parent module worker failed')); };
        worker.postMessage({ buffer: memory.buffer });
      }), 15000, 'Nested shared-memory proof');
      result.parentIsolated = response.parentIsolated;
      result.childIsolated = response.childIsolated;
      result.parentSawSharedMemory = response.parentSawSharedMemory;
      result.childSawSharedMemory = response.childSawSharedMemory;
      result.counter = Atomics.load(words, 0);
      result.childSignal = Atomics.load(words, 1);
      if (!result.parentIsolated || !result.childIsolated || !result.parentSawSharedMemory || !result.childSawSharedMemory)
        throw new Error('A module worker did not inherit isolation and shared memory');
      if (result.counter !== 3 || result.childSignal !== 1) throw new Error('Worker writes did not reach the original WASM memory');
      result.ok = true;
    } finally { worker.terminate(); }
    if (new URL(location.href).searchParams.has('engine')) {
      const engineWorker = new Worker(new URL('./probe-engine.mjs', import.meta.url), { type: 'module', name: 'pages-thread-engine' });
      try {
        result.engine = await deadline(new Promise((resolve, reject) => {
          engineWorker.onmessage = ({ data }) => {
            if (data.progress) { result.lastEngineProgress = data.progress; return; }
            if (data.error) reject(new Error(data.error)); else resolve(data);
          };
          engineWorker.onerror = (event) => { event.preventDefault(); reject(new Error(event.message || 'MT engine worker failed')); };
        }), 90000, 'Real browser MT slice');
      } finally { engineWorker.terminate(); }
    }
    result.done = true;
  }
} catch (error) {
  result.ok = false;
  result.error = error?.stack || String(error);
  result.done = true;
}
`,
  'probe-shared.mjs': String.raw`
export function inspect(buffer) {
  if (!(buffer instanceof SharedArrayBuffer)) throw new Error('The received memory is not a SharedArrayBuffer');
  return { words: new Int32Array(buffer), isolated: self.crossOriginIsolated === true };
}
`,
  'probe-parent.mjs': String.raw`
import { inspect } from './probe-shared.mjs';
self.onmessage = async ({ data }) => {
  let child;
  try {
    const { words, isolated } = inspect(data.buffer);
    Atomics.add(words, 0, 1);
    child = new Worker(new URL('./probe-child.mjs', import.meta.url), { type: 'module', name: 'pages-thread-child' });
    const reply = await new Promise((resolve, reject) => {
      child.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
      child.onerror = (event) => { event.preventDefault(); reject(new Error(event.message || 'Nested module worker failed')); };
      child.postMessage({ buffer: data.buffer });
    });
    self.postMessage({ parentIsolated: isolated, parentSawSharedMemory: true, ...reply });
  } catch (error) { self.postMessage({ error: error?.stack || String(error) }); }
  finally { child?.terminate(); }
};
`,
  'probe-child.mjs': String.raw`
import { inspect } from './probe-shared.mjs';
self.onmessage = ({ data }) => {
  try {
    const { words, isolated } = inspect(data.buffer);
    Atomics.add(words, 0, 2);
    Atomics.store(words, 1, 1);
    Atomics.notify(words, 1);
    self.postMessage({ childIsolated: isolated, childSawSharedMemory: true });
  } catch (error) { self.postMessage({ error: error?.stack || String(error) }); }
};
`,
  'probe-engine.mjs': String.raw`
// Intentionally bypasses the application's ST fallback: this optional check
// succeeds only when the actual asynchronous MT bridge finishes the cube.
let mod;
try {
  const base = new URL('../wasm/orca/mt/', import.meta.url);
  const load = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(String(url) + ': HTTP ' + response.status);
    return new Uint8Array(await response.arrayBuffer());
  };
  const [factory, wasm, data, job, blob, baseline] = await Promise.all([
    import(new URL('slicer.mjs', base).href), load(new URL('slicer.wasm', base)), load(new URL('slicer.data', base)),
    load(new URL('./job.json', import.meta.url)), load(new URL('./mesh.bin', import.meta.url)),
    fetch(new URL('./expected-report.json', import.meta.url)).then((r) => r.json()),
  ]);
  mod = await factory.default({
    wasmBinary: wasm, csThreads: 2, mainScriptUrlOrBlob: new URL('slicer.mjs', base).href,
    locateFile: (file) => new URL(file, base).href,
    getPreloadedPackage: () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    csProgress: (percent, message) => self.postMessage({ progress: { percent, message } }),
    print: () => {}, printErr: () => {},
  });
  const version = JSON.parse(mod.UTF8ToString(mod._cs_version()));
  if (version.version !== '2.5.0' || version.bridge !== 1) throw new Error('Unexpected MT engine version');
  if (!(mod.HEAPU8.buffer instanceof SharedArrayBuffer) || typeof mod._cs_slice_start !== 'function')
    throw new Error('The engine is not the shared-memory MT build');
  const threads = mod._cs_thread_count();
  if (threads < 2) throw new Error('The MT build did not create at least two threads');
  const allocate = (bytes) => {
    const ptr = mod._malloc(Math.max(1, bytes.length)) >>> 0;
    if (!ptr) throw new Error('Engine allocation failed');
    mod.csSyncHeap?.(); mod.HEAPU8.set(bytes, ptr); return ptr;
  };
  const input = allocate(job), mesh = allocate(blob), outs = allocate(new Uint8Array(16)), state = allocate(new Uint8Array(8));
  const startCode = mod._cs_slice_start(input, job.length, mesh, blob.length, outs, outs + 4, outs + 8, outs + 12, state);
  if (startCode !== 0) throw new Error('cs_slice_start rejected the job: ' + startCode);
  const start = performance.now();
  for (;;) {
    mod.csSyncHeap?.();
    if (Atomics.load(mod.HEAP32, state >>> 2) !== 0) break;
    if (performance.now() - start > 60000) throw new Error('cs_slice_start did not finish in 60 seconds');
    // Yield to Emscripten so it can start nested pthread workers.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const code = Atomics.load(mod.HEAP32, (state >>> 2) + 1);
  mod.csSyncHeap?.();
  const words = mod.HEAPU32;
  const gp = words[outs >>> 2] >>> 0, gl = words[(outs >>> 2) + 1] >>> 0;
  const rp = words[(outs >>> 2) + 2] >>> 0, rl = words[(outs >>> 2) + 3] >>> 0;
  const copy = (ptr, len) => {
    if (!ptr || !len || ptr + len > mod.HEAPU8.length) throw new Error('MT engine returned an invalid output buffer');
    return mod.HEAPU8.slice(ptr, ptr + len);
  };
  const decode = new TextDecoder();
  const report = JSON.parse(decode.decode(copy(rp, rl)));
  if (code !== 0 || !report.ok) throw new Error(report.error || 'MT slice failed with code ' + code);
  const gcode = decode.decode(copy(gp, gl));
  if (!/OrcaSlicer/i.test(gcode) || !/^G1\s[^\r\n]*[XY][^\r\n]*\sE[-\d.]+/m.test(gcode)) throw new Error('MT slice did not generate extruding G-code');
  if (report.stats.layers !== baseline.stats.layers || Math.abs(report.stats.maxZ - baseline.stats.maxZ) > 0.01)
    throw new Error('MT cube geometry differs from the production ST baseline');
  if (!(report.stats.filamentMm?.[0] > 0)) throw new Error('MT slice has no extrusion estimate');
  self.postMessage({ ok: true, bridge: 'cs_slice_start', threads, version, gcodeBytes: gl, layers: report.stats.layers, maxZ: report.stats.maxZ, elapsedMs: Math.round(performance.now() - start) });
} catch (error) { self.postMessage({ error: error?.stack || String(error) }); }
finally { mod?.csTerminateThreads?.(); }
`,
};

if (testEngine) {
  await stat(join(dist, 'wasm/orca/mt/slicer.mjs'));
  for (const [destination, source] of [['job.json', 'job.json'], ['mesh.bin', 'mesh.bin'], ['expected-report.json', 'report.json']]) {
    fixtureFiles[destination] = await readFile(join(root, 'e2e-out/engine-smoke', source));
  }
}

let fixtureCreated = false;
let server;
let browser;
let context;
const diagnostics = [];
try {
  // Refuse to overwrite or recursively delete a pre-existing directory.
  await mkdir(fixtureRoot);
  fixtureCreated = true;
  await Promise.all(Object.entries(fixtureFiles).map(([name, source]) => writeFile(join(fixtureRoot, name), source)));
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      // A second same-origin page proves that the project SW does not escape its scope.
      if (url.pathname === '/unrelated-thread-test/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end('<!doctype html><title>Outside the project scope</title><link rel="icon" href="data:,">');
        return;
      }
      if (!url.pathname.startsWith(basePath) || !['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(404).end(); return;
      }
      const requestedPath = decodeURIComponent(url.pathname.slice(basePath.length));
      const file = resolve(dist, requestedPath.endsWith('/') ? requestedPath + 'index.html' : requestedPath);
      const rel = relative(dist, file);
      if (!rel || rel === '..' || rel.startsWith('..' + sep) || rel.includes('\0')) {
        response.writeHead(403).end(); return;
      }
      const body = await readFile(file);
      const mime = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json' }[extname(file)] || 'application/octet-stream';
      // Deliberately no COOP/COEP/CORP: the tested SW must supply those headers.
      response.writeHead(200, { 'Content-Type': mime, 'Content-Length': body.byteLength, 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
      if (error.code !== 'ENOENT') diagnostics.push('Static server: ' + error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const fixtureUrl = origin + basePath + fixtureName + '/' + (testEngine ? '?engine=1' : '');
  const direct = await fetch(fixtureUrl);
  assert.equal(direct.status, 200);
  assert.equal(direct.headers.get('Cross-Origin-Opener-Policy'), null);
  assert.equal(direct.headers.get('Cross-Origin-Embedder-Policy'), null);
  await direct.arrayBuffer();

  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();
  let navigations = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame() && frame.url() === fixtureUrl) navigations++; });
  page.on('console', (message) => { if (message.type() === 'error') diagnostics.push('Console: ' + message.text()); });
  page.on('pageerror', (error) => diagnostics.push('Page: ' + error.message));
  page.on('requestfailed', (request) => diagnostics.push('Request: ' + request.url() + ' ' + request.failure()?.errorText));
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__threadTest?.done === true, undefined, { timeout: testEngine ? 130000 : 40000 });
  const result = await page.evaluate(() => window.__threadTest);
  assert.equal(result.ok, true, JSON.stringify({ result, diagnostics: diagnostics.slice(-15) }, null, 2));
  if (testEngine) assert.equal(result.engine?.ok, true, 'The real MT engine must finish its slice');
  assert.equal(result.scope, origin + basePath, 'SW scope must be limited to the GitHub project path');
  assert.equal(result.automaticReloads, 1);
  assert.equal(navigations, 2, 'A first visit must perform exactly one automatic reload');

  await page.goto(origin + '/unrelated-thread-test/', { waitUntil: 'domcontentloaded', timeout: 10000 });
  const outside = await page.evaluate(() => ({ isolated: crossOriginIsolated, controlled: !!navigator.serviceWorker.controller }));
  assert.deepEqual(outside, { isolated: false, controlled: false }, 'The project SW must not isolate other same-origin projects');
  console.log(JSON.stringify({
    ok: true, browser: 'headless Chromium', mode: testEngine ? 'isolation, shared memory and a real cs_slice_start MT slice' : 'isolation and shared-memory smoke; not an Orca MT slice',
    ...result, scopeLimited: true,
  }, null, 2));
} catch (error) {
  if (/Executable doesn't exist/.test(error.message)) {
    throw new Error('Playwright Chromium is missing. Install it in CI with: npx playwright install --with-deps chromium', { cause: error });
  }
  if (diagnostics.length) console.error(diagnostics.slice(-15).join('\n'));
  throw error;
} finally {
  if (context) {
    // This context is fresh and contains no user data; unregister only our test scope.
    const pages = context.pages();
    if (pages.length) await pages[0].evaluate(async () => {
      for (const reg of await navigator.serviceWorker.getRegistrations())
        if (new URL(reg.scope).pathname === '/orcaslicer-web/') await reg.unregister();
    }).catch(() => {});
    await context.close().catch(() => {});
  }
  await browser?.close();
  if (server) {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
  if (fixtureCreated) {
    assert.equal(dirname(fixtureRoot), dist, 'Cleanup must remain inside dist/');
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}
