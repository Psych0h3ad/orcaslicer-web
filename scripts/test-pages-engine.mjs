#!/usr/bin/env node
/**
 * Real, offline integration check for the GitHub Pages slicing builds.
 * Uses the application's STL importer dependency, preset catalog, config
 * resolution, blob packer and heap helpers; no mocked slicer or browser.
 * Run after `npm run stage:pages` (or `node scripts/stage-pages-assets.mjs`).
 * Default: ST. Add --mt (or --all) to also check MT against the ST result.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createServer } from 'vite';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = join(root, 'public/wasm/orca');
const profilesDir = join(engineDir, 'profiles');
const outputDir = join(root, 'e2e-out/engine-smoke');
const textDecoder = new TextDecoder();
const started = performance.now();
const checkMt = process.argv.includes('--mt') || process.argv.includes('--all');

// Load production TypeScript modules without opening a development server.
const vite = await createServer({
  configFile: false,
  root,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, watch: null },
});

try {
  const [catalogModule, configModule, packing, heap, capabilities] = await Promise.all([
    vite.ssrLoadModule('/src/presets/orca/catalog.ts'),
    vite.ssrLoadModule('/src/presets/resolve.ts'),
    vite.ssrLoadModule('/src/engine/worker/pack.ts'),
    vite.ssrLoadModule('/src/engine/worker/heap.ts'),
    vite.ssrLoadModule('/src/engine/capabilities.ts'),
  ]);
  const [schema, stagedVersion, wasmBytes, dataBytes] = await Promise.all([
    readJson(join(engineDir, 'schema.json')),
    readJson(join(engineDir, 'version.json')),
    readFile(join(engineDir, 'slicer.wasm')),
    readFile(join(engineDir, 'slicer.data')),
  ]);
  const { default: createEngine } = await import(pathToFileURL(join(engineDir, 'slicer.mjs')).href);
  const compiled = await WebAssembly.compile(wasmBytes);
  const create = () => createEngine({
    locateFile: (file) => join(engineDir, file),
    getPreloadedPackage: () => dataBytes.buffer.slice(dataBytes.byteOffset, dataBytes.byteOffset + dataBytes.byteLength),
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(compiled, imports).then((instance) => done(instance, compiled));
      return {};
    },
    print: () => {},
    printErr: () => {},
  });

  // Exercise the same catalog and inheritance resolution used by the UI.
  const catalog = new catalogModule.OrcaCatalog({
    base: '/profiles',
    fetcher: async (url) => {
      assert.ok(url.startsWith('/profiles/'), `Unexpected profile URL: ${url}`);
      const file = resolve(profilesDir, decodeURIComponent(url.slice('/profiles/'.length)));
      const rel = relative(profilesDir, file);
      assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`), 'Profile path escaped its directory');
      try { return await readJson(file); } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
  });
  const printerId = 'sys:Custom/MyKlipper 0.4 nozzle';
  const printerInfo = await catalog.info(printerId, 'printer');
  assert.ok(printerInfo, 'The default 0.4 mm printer must be present');
  const processInfo = await catalog.findByName('process', '0.20mm Standard @MyKlipper', 'Custom');
  const filamentInfo = await catalog.findByName('filament', 'Generic PLA @System', 'OrcaFilamentLibrary');
  assert.ok(processInfo && filamentInfo, 'Real process and filament presets must resolve');
  const [printerRaw, processRaw, filamentRaw] = await Promise.all([
    catalog.resolve(printerId, 'printer'),
    catalog.resolve(processInfo.id, 'process'),
    catalog.resolve(filamentInfo.id, 'filament'),
  ]);
  assert.ok(printerRaw && processRaw && filamentRaw, 'Preset inheritance must resolve');
  const { resolveConfig, shapeValues } = configModule;
  const config = resolveConfig({
    schema,
    printer: shapeValues(schema, printerRaw),
    process: shapeValues(schema, processRaw),
    filaments: [shapeValues(schema, filamentRaw)],
    names: { printer: printerInfo.name, process: processInfo.name, filaments: [filamentInfo.name] },
  });
  assert.equal(Number(config.layer_height), 0.2);
  assert.ok(Object.keys(config).length > 200, 'Slice must use a fully resolved configuration');

  const stl = cubeStl(20);
  const geometry = new STLLoader().parse(stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength));
  const positions = geometry.getAttribute('position').array;
  const indices = Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
  const job = {
    engine: 'orca',
    config,
    objects: [{
      id: 'smoke-cube', name: '20mm cube', positions, indices,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1],
    }],
    options: { validate: true, dropToBed: true },
  };
  const packed = packing.packJob(job);

  async function run(payload) {
    // As in the production ST worker, each job receives a fresh instance.
    const mod = await create();
    const version = JSON.parse(mod.UTF8ToString(mod._cs_version()));
    assert.deepEqual(version, stagedVersion, 'WASM version must match the staged metadata');
    assert.equal(capabilities.bridgeAbiError('orca', version.bridge), null);
    const input = heap.writeIn(mod, payload.json);
    const blob = heap.writeIn(mod, payload.blob);
    const out = heap.allocWords(mod, 4);
    let gcodePtr = 0, reportPtr = 0;
    try {
      const rc = mod._cs_slice(input, payload.json.byteLength, blob, payload.blob.byteLength, out, out + 4, out + 8, out + 12);
      gcodePtr = heap.u32(mod, out);
      reportPtr = heap.u32(mod, out + 8);
      const gcodeLen = heap.u32(mod, out + 4);
      const reportLen = heap.u32(mod, out + 12);
      assert.ok(reportPtr && reportLen, 'Even rejected jobs must return a structured report');
      return {
        rc, version,
        report: JSON.parse(textDecoder.decode(heap.copyOut(mod, reportPtr, reportLen))),
        gcode: gcodePtr && gcodeLen ? heap.copyOut(mod, gcodePtr, gcodeLen) : new Uint8Array(),
      };
    } finally {
      heap.safeFree(mod, gcodePtr, true);
      heap.safeFree(mod, reportPtr, true);
      for (const ptr of [input, blob, out]) heap.safeFree(mod, ptr);
    }
  }

  // The bridge must reject invalid mesh references instead of trapping.
  const malformed = JSON.parse(textDecoder.decode(packed.json));
  malformed.objects[0].vertexOffset = packed.blob.byteLength + 4;
  const rejected = await run({ json: new TextEncoder().encode(JSON.stringify(malformed)), blob: packed.blob });
  assert.notEqual(rejected.rc, 0, 'Out-of-bounds mesh data must be rejected');
  assert.equal(rejected.report.ok, false);
  assert.equal(typeof rejected.report.error, 'string');
  assert.ok(rejected.report.error.length > 0);
  assert.equal(rejected.gcode.byteLength, 0);

  const sliced = await run(packed);
  assert.equal(sliced.rc, 0, sliced.report.error ?? 'Orca slice failed');
  assert.equal(sliced.report.ok, true, sliced.report.error ?? 'Orca slice failed');
  assert.ok(sliced.report.stats.layers >= 95 && sliced.report.stats.layers <= 105, '20 mm at 0.2 mm must produce about 100 layers');
  assert.ok(Math.abs(sliced.report.stats.maxZ - 20) < 0.3);
  assert.ok(sliced.report.stats.filamentMm[0] > 0, 'A real extrusion estimate must be produced');
  const gcode = textDecoder.decode(sliced.gcode);
  assert.match(gcode, /OrcaSlicer/i);
  assert.match(gcode, /^G1\s[^\r\n]*[XY][^\r\n]*\sE[-\d.]+/m, 'G-code must contain extruding moves');
  assert.match(gcode, /^M(?:104|109)\s[^\r\n]*S\d+/m, 'G-code must set a nozzle temperature');
  assert.doesNotMatch(gcode, /\b(?:NaN|Infinity)\b/);

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(join(outputDir, 'cube.stl'), stl),
    writeFile(join(outputDir, 'cube.gcode'), sliced.gcode),
    writeFile(join(outputDir, 'report.json'), `${JSON.stringify(sliced.report, null, 2)}\n`),
    writeFile(join(outputDir, 'job.json'), packed.json),
    writeFile(join(outputDir, 'mesh.bin'), packed.blob),
  ]);
  console.log(JSON.stringify({
    ok: true, version: sliced.version, mode: 'single-threaded',
    printer: printerInfo.name, process: processInfo.name, filament: filamentInfo.name,
    configKeys: Object.keys(config).length,
    layers: sliced.report.stats.layers, maxZ: sliced.report.stats.maxZ,
    filamentMm: sliced.report.stats.filamentMm, gcodeBytes: sliced.gcode.byteLength,
    malformedJobRejected: rejected.report.error,
    elapsedMs: Math.round(performance.now() - started),
    artifacts: relative(root, outputDir).split(sep).join('/'),
  }, null, 2));

  if (checkMt) {
    // An independent host Worker makes the deadline enforceable even if a
    // buggy pthread build blocks its host. Cleanup terminates the pool first,
    // and the parent always terminates the host before resolving/rejecting.
    const mt = await runMtCheck(join(engineDir, 'mt'), packed, 60_000);
    assert.deepEqual(mt.version, stagedVersion, 'MT and ST must expose the same engine/bridge versions');
    assert.equal(mt.sharedMemory, true, 'The MT engine must use SharedArrayBuffer-backed memory');
    assert.ok(mt.threads >= 2, 'The MT engine must use at least two threads');
    assert.equal(mt.rc, 0, mt.report?.error ?? 'MT slice failed');
    assert.equal(mt.report.ok, true, mt.report.error ?? 'MT slice failed');
    assert.equal(mt.report.stats.layers, sliced.report.stats.layers);
    assert.ok(Math.abs(mt.report.stats.maxZ - sliced.report.stats.maxZ) < 1e-6);
    assert.ok(Math.abs(mt.report.stats.filamentMm[0] - sliced.report.stats.filamentMm[0]) < sliced.report.stats.filamentMm[0] * 0.01,
      'MT and ST extrusion estimates must agree within 1%');
    const mtGcode = textDecoder.decode(mt.gcode);
    assert.match(mtGcode, /OrcaSlicer/i);
    assert.match(mtGcode, /^G1\s[^\r\n]*[XY][^\r\n]*\sE[-\d.]+/m);
    assert.match(mtGcode, /^M(?:104|109)\s[^\r\n]*S\d+/m);
    assert.doesNotMatch(mtGcode, /\b(?:NaN|Infinity)\b/);
    const countExtrusions = (text) => [...text.matchAll(/^G1\s[^\r\n]*[XY][^\r\n]*\sE[-\d.]+/gm)].length;
    assert.equal(countExtrusions(mtGcode), countExtrusions(gcode), 'MT and ST must generate the same number of extruding moves for the cube');
    await Promise.all([
      writeFile(join(outputDir, 'cube-mt.gcode'), mt.gcode),
      writeFile(join(outputDir, 'report-mt.json'), `${JSON.stringify(mt.report, null, 2)}\n`),
    ]);
    console.log(JSON.stringify({ ok: true, mode: 'multi-threaded', version: mt.version, threads: mt.threads,
      sharedMemory: mt.sharedMemory, layers: mt.report.stats.layers, gcodeBytes: mt.gcode.byteLength,
      progressEvents: mt.progressEvents, elapsedMs: mt.elapsedMs, matchesSingleThreaded: true }, null, 2));
  }
} finally {
  await vite.close();
}

async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }

async function runMtCheck(directory, payload, timeoutMs) {
  const source = `(${mtWorkerMain.toString()})()`;
  const worker = new Worker(source, {
    eval: true,
    workerData: { directory, json: payload.json, blob: payload.blob, timeoutMs: timeoutMs - 5_000 },
  });
  return new Promise((resolveResult, rejectResult) => {
    let settled = false;
    let latest = null;
    const finish = async (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate();
      if (error) rejectResult(error); else resolveResult(value);
    };
    const timer = setTimeout(() => {
      void finish(new Error(`MT slice exceeded ${timeoutMs / 1000}s; host and pthread pool terminated. Last status: ${JSON.stringify(latest)}`));
    }, timeoutMs);
    worker.on('message', (message) => {
      if (message.status) { latest = message; return; }
      if (message.error) void finish(new Error(`MT slice failed: ${message.error}; diagnostics: ${JSON.stringify(message.diagnostics)}`));
      else void finish(null, message.result);
    });
    worker.on('error', (error) => { void finish(error); });
    worker.on('exit', (code) => {
      if (!settled) void finish(new Error(`MT host exited before returning a result (code ${code})`));
    });
  });
}

/** Self-contained because it is serialized into a Node host Worker. */
async function mtWorkerMain() {
  const { parentPort, workerData } = await import('node:worker_threads');
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { directory, json, blob, timeoutMs } = workerData;
  const started = performance.now();
  // Atomics.waitAsync alone does not keep a Node Worker alive, and the
  // Emscripten pool deliberately unrefs idle pthreads.
  const keepAlive = setInterval(() => {}, 1_000);
  const diagnostics = { progress: [], stderr: [], version: null, threads: 0, sharedMemory: false, state: null };
  let mod, message;
  let inputs = [], output = 0, state = 0, gcodePtr = 0, reportPtr = 0;
  const readWord = (pointer) => { mod.csSyncHeap?.(); return mod.HEAPU32[(pointer >>> 0) >>> 2] >>> 0; };
  const copyOut = (pointer, length) => {
    mod.csSyncHeap?.();
    if (!pointer || pointer + length > mod.HEAPU8.byteLength) throw new Error('MT engine returned an invalid buffer');
    return mod.HEAPU8.slice(pointer, pointer + length);
  };
  try {
    const [wasm, data, factory] = await Promise.all([
      readFile(join(directory, 'slicer.wasm')),
      readFile(join(directory, 'slicer.data')),
      import(pathToFileURL(join(directory, 'slicer.mjs')).href).then((module) => module.default),
    ]);
    const compiled = await WebAssembly.compile(wasm);
    mod = await factory({
      csThreads: 2,
      locateFile: (file) => join(directory, file),
      // Node's Worker constructor wants an absolute native path; browsers use
      // the equivalent same-origin URL in the production runtime.
      mainScriptUrlOrBlob: join(directory, 'slicer.mjs'),
      getPreloadedPackage: () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      instantiateWasm(imports, done) {
        WebAssembly.instantiate(compiled, imports).then((instance) => done(instance, compiled));
        return {};
      },
      csProgress(percent, text) {
        diagnostics.progress.push({ percent, text });
        if (diagnostics.progress.length > 10) diagnostics.progress.shift();
        parentPort.postMessage({ status: 'progress', percent, text });
      },
      print: () => {},
      printErr: (line) => { diagnostics.stderr.push(line); if (diagnostics.stderr.length > 10) diagnostics.stderr.shift(); },
    });
    diagnostics.version = JSON.parse(mod.UTF8ToString(mod._cs_version()));
    diagnostics.threads = mod._cs_thread_count();
    diagnostics.sharedMemory = mod.HEAPU8.buffer instanceof SharedArrayBuffer;
    parentPort.postMessage({ status: 'ready', ...diagnostics });
    const allocate = (bytes) => {
      const pointer = mod._malloc(Math.max(1, bytes.byteLength)) >>> 0;
      if (!pointer) throw new Error('MT engine allocation failed');
      inputs.push(pointer);
      mod.csSyncHeap?.();
      mod.HEAPU8.set(bytes, pointer);
      return pointer;
    };
    const jobPtr = allocate(json), blobPtr = allocate(blob);
    output = allocate(new Uint8Array(16));
    state = allocate(new Uint8Array(8));
    const rc = mod._cs_slice_start(jobPtr, json.byteLength, blobPtr, blob.byteLength,
      output, output + 4, output + 8, output + 12, state);
    if (rc !== 0) throw new Error(`MT asynchronous entry point refused to start: ${rc}`);
    parentPort.postMessage({ status: 'slice-started', threads: diagnostics.threads });
    const deadline = started + timeoutMs;
    while (true) {
      mod.csSyncHeap?.();
      const shared = mod.HEAP32;
      const index = (state >>> 0) >>> 2;
      diagnostics.state = [Atomics.load(shared, index), Atomics.load(shared, index + 1)];
      if (diagnostics.state[0] !== 0) break;
      if (performance.now() >= deadline) throw new Error(`MT slice timed out after ${timeoutMs / 1000}s`);
      // Never Atomics.wait: pthread startup and proxied calls need this host's
      // event loop. waitAsync lets Emscripten process those messages.
      const waiting = Atomics.waitAsync(shared, index, 0, 100);
      if (waiting.async) await waiting.value;
      else await new Promise((resolve) => setTimeout(resolve, 0));
    }
    gcodePtr = readWord(output);
    reportPtr = readWord(output + 8);
    const report = JSON.parse(new TextDecoder().decode(copyOut(reportPtr, readWord(output + 12))));
    const gcodeLen = readWord(output + 4);
    message = { result: {
      rc: diagnostics.state[1], version: diagnostics.version, threads: diagnostics.threads,
      sharedMemory: diagnostics.sharedMemory, report,
      gcode: gcodeLen ? copyOut(gcodePtr, gcodeLen) : new Uint8Array(),
      progressEvents: diagnostics.progress.length, elapsedMs: Math.round(performance.now() - started),
    } };
  } catch (error) {
    message = { error: String(error.stack ?? error), diagnostics };
  } finally {
    // A completed slice has released its inputs. After a timeout/trap do not
    // free live data; terminate the pool and let host teardown reclaim memory.
    if (message?.result) {
      try {
        if (gcodePtr) mod._cs_free(gcodePtr);
        if (reportPtr) mod._cs_free(reportPtr);
        for (const pointer of inputs) mod._free(pointer);
      } catch { /* do not mask the useful failure */ }
    }
    try { mod?.csTerminateThreads?.(); } catch { /* parent also terminates the host */ }
    clearInterval(keepAlive);
  }
  parentPort.postMessage(message);
  parentPort.close();
}

function cubeStl(size) {
  const vertices = [[0,0,0],[size,0,0],[size,size,0],[0,size,0],[0,0,size],[size,0,size],[size,size,size],[0,size,size]];
  const triangles = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const bytes = Buffer.alloc(84 + triangles.length * 50);
  bytes.write('CubbySlicer / OrcaSlicer Web 20mm integration test');
  bytes.writeUInt32LE(triangles.length, 80);
  triangles.forEach((triangle, i) => {
    const offset = 84 + i * 50;
    triangle.forEach((vertex, corner) => vertices[vertex].forEach((coordinate, axis) => bytes.writeFloatLE(coordinate, offset + 12 + corner * 12 + axis * 4)));
  });
  return bytes;
}
