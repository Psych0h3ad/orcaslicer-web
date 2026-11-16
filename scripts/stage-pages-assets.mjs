#!/usr/bin/env node
/**
 * Download the single-threaded OrcaSlicer/CAD builds and their resource library.
 * Normal runs accept only the SHA-256/length pairs in pages-assets.lock.json,
 * restoring missing assets from its immutable, separately hashed release ZIP.
 * Maintainers can deliberately refresh the snapshot with --update-lock, inspect
 * its diff, publish an immutable ZIP, and set lock.snapshot before committing.
 * --add-covers preserves every existing locked byte and adds only printer
 * selection thumbnails, followed by publication of an expanded snapshot ZIP.
 * --add-mt similarly adds the matching pthreads engine without refreshing ST,
 * profiles or covers. Startup validation is separate from a real slice test.
 * No assets are fetched by the deployed app from CubbyCAD: everything is staged
 * under public/ and served by the same GitHub Pages origin as the application.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MT_CORE_BUDGET_TRANSFORM, transformMtCoreBudget } from './transform-mt-core-budget.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = join(root, 'public');
const lockPath = join(root, 'scripts/pages-assets.lock.json');
const update = process.argv.includes('--update-lock');
const verifyOnly = process.argv.includes('--verify');
const addCovers = process.argv.includes('--add-covers');
const addMt = process.argv.includes('--add-mt');
const patchMt = process.argv.includes('--patch-mt');
if (process.argv.slice(2).some((arg) => !['--update-lock', '--verify', '--add-covers', '--add-mt', '--patch-mt'].includes(arg)) || [update, verifyOnly, addCovers, addMt, patchMt].filter(Boolean).length > 1) {
  throw new Error('Usage: node scripts/stage-pages-assets.mjs [--verify | --update-lock | --add-covers | --add-mt | --patch-mt]');
}
const base = 'https://cubbycad.com/slicer/';
const concurrency = 4;
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');
// Some vendor originals carry a UTF-8 BOM. Response.json() accepts it in the
// browser; Buffer.toString() keeps it, so strip only the initial BOM here.
const parseJson = (text) => JSON.parse(text.replace(/^\uFEFF/, ''));
let downloaded = 0, reused = 0;

function targetFor(path) {
  if (typeof path !== 'string' || path.includes('\\') || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe asset path: ${path}`);
  }
  const target = resolve(publicRoot, path);
  if (!relative(publicRoot, target) || relative(publicRoot, target).startsWith(`..${sep}`)) throw new Error(`Path escapes public/: ${path}`);
  return target;
}

async function parallel(items, run) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await run(items[i], i);
    }
  }));
  return results;
}

async function fetchBytes(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000), headers: { 'User-Agent': 'CubbySlicer-GitHub-Pages-assets' } });
      if (!response.ok) {
        const error = new Error(`${url}: HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error.status === 404) throw error;
      lastError = error;
      if (attempt < 2) await new Promise((done) => setTimeout(done, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function save(path, bytes) {
  const target = targetFor(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(`${target}.download`, bytes);
  await rename(`${target}.download`, target);
}

function check(path, bytes, entry) {
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
    throw new Error(`Integrity mismatch for ${path}. Refusing changed or incomplete upstream assets; restore the pinned snapshot or explicitly review --update-lock.`);
  }
  if (/\.wasm$/.test(path) && !bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) throw new Error(`Invalid WebAssembly file: ${path}`);
  if (/_cover\.png$/i.test(path) && !checkCover(bytes)) throw new Error(`Invalid printer-cover PNG: ${path}`);
  if (/\.json$/.test(path)) parseJson(bytes.toString('utf8'));
}

async function hasVerifiedLocalAsset(entry) {
  let bytes;
  try { bytes = await readFile(targetFor(entry.path)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes || bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) return false;
  check(entry.path, bytes, entry);
  reused++;
  return true;
}

async function stageLockedSnapshot(lock) {
  const known = new Map();
  for (const entry of lock.files) {
    targetFor(entry.path);
    if (known.has(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Invalid or duplicate locked asset: ${entry.path}`);
    }
    known.set(entry.path, entry);
  }
  const local = await parallel(lock.files, hasVerifiedLocalAsset);
  const missing = lock.files.filter((entry, i) => !local[i]);
  if (!missing.length) return;
  if (verifyOnly) throw new Error(`Missing or modified staged asset: ${missing[0].path} (${missing.length} in total; --verify never downloads files)`);
  if (!lock.snapshot) throw new Error('The asset lock has no immutable snapshot. Publish a ZIP containing exactly lock.files, then record its URL, byte length and SHA-256 in lock.snapshot before staging or CI deployment.');
  const { url, bytes: expectedBytes, sha256: expectedHash } = lock.snapshot;
  let sourceUrl;
  try { sourceUrl = new URL(url); } catch { throw new Error('Invalid immutable snapshot URL'); }
  if (sourceUrl.protocol !== 'https:' || sourceUrl.username || sourceUrl.password || !Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error('Invalid immutable snapshot metadata in pages-assets.lock.json');
  }
  console.log(`Restoring ${missing.length} assets from the pinned release snapshot...`);
  const archive = await fetchBytes(sourceUrl.href);
  if (archive.length !== expectedBytes || sha256(archive) !== expectedHash) throw new Error('Immutable snapshot ZIP integrity mismatch; refusing to extract or modify staged assets.');
  const { unzipSync } = await import('fflate');
  const seen = new Set();
  // Check names and expanded lengths before inflation. Reject extra entries,
  // directory entries, duplicates and traversal rather than silently ignoring
  // them. The archive contains public-relative file paths, never a public/ prefix.
  const contents = unzipSync(archive, {
    filter: ({ name, originalSize }) => {
      targetFor(name);
      const entry = known.get(name);
      if (!entry || seen.has(name) || originalSize !== entry.bytes) throw new Error(`Unexpected, duplicate or wrong-sized snapshot entry: ${name}`);
      seen.add(name);
      return true;
    },
  });
  if (seen.size !== known.size) throw new Error(`Incomplete immutable snapshot: expected ${known.size} files, found ${seen.size}`);
  // Verify the complete archive before the first write, even when only one
  // local file needs repair. A partially invalid ZIP cannot damage good files.
  for (const entry of lock.files) {
    const content = contents[entry.path];
    if (!content) throw new Error(`Missing snapshot entry: ${entry.path}`);
    check(entry.path, Buffer.from(content.buffer, content.byteOffset, content.byteLength), entry);
  }
  for (const entry of missing) {
    await save(entry.path, contents[entry.path]);
    downloaded++;
  }
}

async function readJson(path) { return parseJson(await readFile(targetFor(path), 'utf8')); }

function checkCover(bytes) {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return bytes.length >= 24 && bytes.subarray(0, 8).equals(png)
    && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
}

async function capturePrinterCovers(files, omitted, sourceCommit) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '')) throw new Error('A pinned Orca source commit is required to discover printer covers.');
  const vendors = await readJson('wasm/orca/profiles/_index.json');
  const models = new Map();
  for (const vendor of vendors) {
    const catalog = await readJson(`wasm/orca/profiles/${vendor}.json`);
    const bundle = await readJson(`wasm/orca/profiles/_bundles/${vendor}.json`);
    for (const model of catalog.machine_model_list ?? []) {
      const raw = bundle[model.sub_path] ?? await readJson(`wasm/orca/profiles/${vendor}/${model.sub_path}`);
      const name = raw?.name || model.name;
      if (typeof name !== 'string' || !name || /[\\/]/.test(name)) throw new Error(`Invalid printer model name in ${vendor}: ${String(name)}`);
      const path = `wasm/orca/profiles/${vendor}/${name}_cover.png`;
      targetFor(path);
      models.set(path, { path, vendor, name });
    }
  }
  let added = 0, available = 0;
  await parallel([...models.values()], async ({ path, vendor, name }) => {
    if (files.has(path)) { available++; return; }
    const originalPath = `resources/profiles/${vendor}/${name}_cover.png`;
    const urls = [base + encodePath(path), `https://raw.githubusercontent.com/OrcaSlicer/OrcaSlicer/${sourceCommit}/${encodePath(originalPath)}`];
    const attempts = [];
    for (const url of urls) {
      let bytes;
      try { bytes = await fetchBytes(url); } catch (error) {
        if (![404, 410].includes(error.status)) throw error;
        attempts.push({ url, status: error.status, reason: 'not-found' });
        continue;
      }
      if (!checkCover(bytes)) { attempts.push({ url, status: 200, reason: 'not-a-valid-png' }); continue; }
      const entry = { path, bytes: bytes.length, sha256: sha256(bytes), sourceUrl: url };
      check(path, bytes, entry);
      await save(path, bytes);
      files.set(path, entry);
      available++;
      added++;
      downloaded++;
      return;
    }
    omitted.push({ path, kind: 'printer-cover', vendor, model: name, reasonCode: 'cover-unavailable-in-live-and-pinned-upstream', reason: 'No valid manufacturer-provided PNG was available from the live distribution or pinned Orca source; the UI should display its missing-image fallback.', attempts });
  });
  return { observedAt: new Date().toISOString(), sourceCommit, models: models.size, available, unavailable: models.size - available, added };
}

async function validateSnapshot() {
  const version = await readJson('wasm/orca/version.json');
  if (version.engine !== 'orca' || version.version !== '2.5.0' || version.bridge !== 1) throw new Error(`Unsupported Orca engine: ${JSON.stringify(version)}`);
  const cad = await readJson('wasm/cad/version.json');
  if (cad.module !== 'orca-cad' || cad.orca !== version.version || cad.abi !== 1) throw new Error(`Unsupported CAD engine: ${JSON.stringify(cad)}`);
  const vendors = await readJson('wasm/orca/profiles/_index.json');
  const paths = new Set(lock.files.map((entry) => entry.path));
  const mtPaths = ['slicer.mjs', 'slicer.wasm', 'slicer.data', 'version.json'].map((file) => `wasm/orca/mt/${file}`);
  const hasMt = mtPaths.some((path) => paths.has(path));
  if (hasMt) {
    for (const path of mtPaths) if (!paths.has(path)) throw new Error(`Incomplete multi-threaded engine: ${path} is not locked`);
    const mt = await readJson('wasm/orca/mt/version.json');
    for (const key of ['engine', 'version', 'bridge']) {
      if (mt[key] !== version[key] || lock.multiThreadedEngine?.version?.[key] !== version[key]) throw new Error(`Multi-threaded ${key} must match the single-threaded engine metadata`);
    }
    if (lock.multiThreadedEngine.workerEntrypoint !== 'wasm/orca/mt/slicer.mjs') throw new Error('Multi-threaded worker entrypoint is not locked');
    const glue = lock.files.find((entry) => entry.path === 'wasm/orca/mt/slicer.mjs');
    if (glue.sha256 !== MT_CORE_BUDGET_TRANSFORM.output.sha256 || glue.transformation?.id !== MT_CORE_BUDGET_TRANSFORM.id) throw new Error('MT JS does not include the reviewed core-budget guard. Run --patch-mt before publishing.');
  } else if (lock.multiThreadedEngine) throw new Error('Multi-threaded metadata exists without its engine assets');
  const omittedCovers = new Set((lock.omittedOptionalAssets ?? []).filter((entry) => entry.kind === 'printer-cover' && entry.reasonCode && entry.reason).map((entry) => entry.path));
  let presets = 0;
  const covers = new Set();
  for (const vendor of vendors) {
    const catalog = await readJson(`wasm/orca/profiles/${vendor}.json`);
    const bundle = await readJson(`wasm/orca/profiles/_bundles/${vendor}.json`);
    for (const key of ['machine_model_list', 'machine_list', 'process_list', 'filament_list']) {
      for (const entry of catalog[key] ?? []) {
        if (!entry.sub_path) throw new Error(`Vendor ${vendor} contains an invalid entry`);
        if (!bundle[entry.sub_path]) {
          // The upstream bundle generator omits a few BOM-prefixed originals.
          // Keep their original bytes as the catalog's existing per-file fallback.
          await readJson(`wasm/orca/profiles/${vendor}/${entry.sub_path}`);
        }
      }
    }
    for (const entry of catalog.machine_model_list ?? []) {
      const raw = bundle[entry.sub_path] ?? await readJson(`wasm/orca/profiles/${vendor}/${entry.sub_path}`);
      const name = raw?.name || entry.name;
      const cover = `wasm/orca/profiles/${vendor}/${name}_cover.png`;
      targetFor(cover);
      if (!paths.has(cover) && !omittedCovers.has(cover)) throw new Error(`Printer cover was not staged or explicitly classified as unavailable: ${cover}. Run --add-covers before publishing a new snapshot.`);
      covers.add(cover);
    }
    presets += Object.keys(bundle).length;
  }
  if (lock.printerCovers?.models !== covers.size) throw new Error(`Printer-cover coverage metadata is stale: expected ${covers.size} models`);
  return { version, cad, vendors: vendors.length, presets, covers: covers.size, hasMt };
}

async function validateEngineRuntime(expected, mt = false) {
  const dir = mt ? 'wasm/orca/mt/' : 'wasm/orca/';
  const { default: createEngine } = await import(pathToFileURL(targetFor(`${dir}slicer.mjs`)).href);
  const data = await readFile(targetFor(`${dir}slicer.data`));
  let engine;
  try {
    engine = await createEngine({
      ...(mt ? { csThreads: 2 } : {}),
      locateFile: (file) => targetFor(`${dir}${file}`),
      wasmBinary: await readFile(targetFor(`${dir}slicer.wasm`)),
      getPreloadedPackage: () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      print: () => {},
      printErr: () => {},
    });
    const actual = JSON.parse(engine.UTF8ToString(engine._cs_version()));
    for (const key of ['engine', 'version', 'bridge']) {
      if (actual[key] !== expected[key]) throw new Error(`${mt ? 'MT' : 'ST'} WASM runtime ${key} ${actual[key]} disagrees with version.json ${expected[key]}`);
    }
    if (mt && (!(engine.HEAPU8.buffer instanceof SharedArrayBuffer) || engine._cs_thread_count?.() !== 2 || typeof engine._cs_slice_start !== 'function')) throw new Error('Multi-threaded WASM did not start its two-thread shared-memory runtime');
    return { version: actual, ...(mt ? { threads: engine._cs_thread_count(), sharedMemory: true, heapBytes: engine.HEAPU8.byteLength } : {}) };
  } finally {
    engine?.csTerminateThreads?.();
  }
}

async function captureMultiThreadedEngine(files, expected) {
  const existing = files.size;
  const dir = 'wasm/orca/mt/';
  await parallel(['slicer.mjs', 'slicer.wasm', 'slicer.data'], async (file) => {
    const path = dir + file;
    if (files.has(path)) return;
    const sourceUrl = base + path;
    const bytes = await fetchBytes(sourceUrl);
    const entry = { path, bytes: bytes.length, sha256: sha256(bytes), sourceUrl };
    check(path, bytes, entry);
    await save(path, bytes);
    files.set(path, entry);
    downloaded++;
  });
  const transformed = await patchMtGlue(files);
  // This Emscripten build boots workers by re-importing slicer.mjs itself.
  // The successful factory startup below loads the actual pthread pool; a
  // missing external worker dependency consequently fails before lock changes.
  const runtime = await validateEngineRuntime(expected, true);
  const path = `${dir}version.json`;
  let metadataSource = { kind: 'existing-locked-version' };
  if (!files.has(path)) {
    const sourceUrl = base + path;
    let bytes, metadata;
    try {
      bytes = await fetchBytes(sourceUrl);
      try { metadata = parseJson(bytes.toString('utf8')); } catch { /* SPA HTML is not version metadata. */ }
    } catch (error) { if (![404, 410].includes(error.status)) throw error; }
    if (metadata) {
      for (const key of ['engine', 'version', 'bridge']) if (metadata[key] !== runtime.version[key]) throw new Error(`Distributed MT version metadata disagrees with the actual WASM ${key}`);
      metadataSource = { kind: 'upstream-json', sourceUrl };
    } else {
      bytes = Buffer.from(`${JSON.stringify(runtime.version, null, 2)}\n`);
      metadataSource = { kind: 'wasm-runtime', generatedFrom: `${dir}slicer.wasm:_cs_version`, probedUrl: sourceUrl, reason: 'The upstream URL did not provide JSON version metadata; recorded the actual compiled engine version.' };
    }
    const entry = { path, bytes: bytes.length, sha256: sha256(bytes), ...(metadata ? { sourceUrl } : { generatedFrom: metadataSource.generatedFrom }) };
    check(path, bytes, entry);
    await save(path, bytes);
    files.set(path, entry);
    downloaded++;
  } else {
    const metadata = await readJson(path);
    for (const key of ['engine', 'version', 'bridge']) if (metadata[key] !== runtime.version[key]) throw new Error(`Locked MT metadata disagrees with the actual WASM ${key}`);
  }
  return { observedAt: new Date().toISOString(), version: runtime.version, workerEntrypoint: `${dir}slicer.mjs`, metadataSource, startupValidation: { threads: runtime.threads, sharedMemory: runtime.sharedMemory, heapBytes: runtime.heapBytes }, added: files.size - existing, transformed };
}

async function patchMtGlue(files) {
  const path = 'wasm/orca/mt/slicer.mjs';
  const entry = files.get(path);
  if (!entry) throw new Error('No locked MT JS to patch; run --add-mt first');
  const source = await readFile(targetFor(path));
  check(path, source, entry);
  const result = transformMtCoreBudget(source);
  if (result.changed) await save(path, result.bytes);
  files.set(path, { ...entry, bytes: result.bytes.length, sha256: sha256(result.bytes), transformation: MT_CORE_BUDGET_TRANSFORM });
  return result.changed;
}

let lock;
if (update) {
  const files = new Map();
  const omittedOptionalAssets = [];
  async function capture(path, optional = false) {
    if (files.has(path)) return files.get(path);
    let bytes;
    try { bytes = await fetchBytes(base + encodePath(path)); } catch (error) {
      if (!optional || error.status !== 404) throw error;
      omittedOptionalAssets.push({ path, reason: 'Upstream returned HTTP 404 during snapshot discovery; decorative bed visual only.' });
      return null;
    }
    const entry = { path, bytes: bytes.length, sha256: sha256(bytes) };
    check(path, bytes, entry);
    await save(path, bytes);
    files.set(path, entry);
    downloaded++;
    return entry;
  }
  await parallel(['wasm/orca/slicer.mjs', 'wasm/orca/slicer.wasm', 'wasm/orca/slicer.data', 'wasm/orca/schema.json', 'wasm/orca/version.json', 'wasm/cad/cad.mjs', 'wasm/cad/cad.wasm', 'wasm/cad/version.json', 'wasm/orca/profiles/_index.json', 'textures/displacement/index.json'], (path) => capture(path));
  const vendors = await readJson('wasm/orca/profiles/_index.json');
  await parallel(vendors.flatMap((vendor) => [`wasm/orca/profiles/${vendor}.json`, `wasm/orca/profiles/_bundles/${vendor}.json`]), (path) => capture(path));
  const supplementalProfiles = new Set();
  const bedAssets = new Set();
  for (const vendor of vendors) {
    const catalog = await readJson(`wasm/orca/profiles/${vendor}.json`);
    const bundle = await readJson(`wasm/orca/profiles/_bundles/${vendor}.json`);
    for (const key of ['machine_model_list', 'machine_list', 'process_list', 'filament_list']) {
      for (const entry of catalog[key] ?? []) if (!bundle[entry.sub_path]) supplementalProfiles.add(`wasm/orca/profiles/${vendor}/${entry.sub_path}`);
    }
    for (const raw of Object.values(bundle)) {
      for (const [key, pattern] of [['bed_model', /\.stl$/i], ['bed_texture', /\.(svg|png)$/i]]) {
        const filename = raw[key];
        if (typeof filename === 'string' && pattern.test(filename) && !/[\\/]/.test(filename)) bedAssets.add(`wasm/orca/profiles/${vendor}/${filename}`);
      }
    }
  }
  await parallel([...supplementalProfiles], (path) => capture(path));
  await parallel([...bedAssets], (path) => capture(path, true));
  const textures = await readJson('textures/displacement/index.json');
  await parallel(textures.textures.map((texture) => `textures/displacement/${texture.file}`), (path) => capture(path));
  // Destination filenames are the public contract of the existing staging script.
  const calibrationScript = await readFile(join(root, 'scripts/stage-calib.mjs'), 'utf8');
  const calibration = [...calibrationScript.matchAll(/\['[^']+', '([^']+\.(?:stl|3mf))'\]/g)].map((match) => `calib/${match[1]}`);
  for (const range of ['230_190', '240_210', '250_230', '270_230', '280_240', '320_280']) calibration.push(`calib/temperature_tower/belt_temp_tower_${range}.stl`);
  await parallel(calibration, (path) => capture(path));
  const observedAt = new Date().toISOString();
  const api = async (path) => JSON.parse((await fetchBytes(`https://api.github.com/repos/${path}`)).toString('utf8'));
  const source = await api('JoshTheDerf/orcaslicer-wasm/commits/main');
  const submodule = await api(`JoshTheDerf/orcaslicer-wasm/contents/orca?ref=${source.sha}`);
  const printerCovers = await capturePrinterCovers(files, omittedOptionalAssets, submodule.sha);
  lock = {
    format: 1,
    baseUrl: base,
    observedAt,
    license: 'AGPL-3.0-or-later',
    engine: await readJson('wasm/orca/version.json'),
    cad: await readJson('wasm/cad/version.json'),
    provenance: {
      binaryDistributor: 'https://cubbycad.com/slicer/',
      portRepository: 'https://github.com/JoshTheDerf/orcaslicer-wasm',
      observedPortCommit: source.sha,
      observedOrcaSubmoduleCommit: submodule.sha,
      sourceCommitCaveat: 'The distributor version metadata does not record a build commit. These are source commits observed when the snapshot was taken, not an assertion that the binaries were built from those exact commits. Artifact SHA-256 values pin the actual distributed bytes.',
    },
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')),
    omittedOptionalAssets: omittedOptionalAssets.sort((a, b) => a.path.localeCompare(b.path, 'en')),
    printerCovers,
  };
  await validateSnapshot();
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.warn('Updated from upstream without an immutable snapshot. Publish the reviewed assets ZIP and add lock.snapshot { url, bytes, sha256 } before CI deployment.');
} else {
  lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (lock.format !== 1 || lock.baseUrl !== base || !Array.isArray(lock.files) || !lock.files.length) throw new Error('Invalid pages-assets.lock.json');
  await stageLockedSnapshot(lock);
  if (addCovers) {
    const original = lock.files;
    const files = new Map(original.map((entry) => [entry.path, entry]));
    const omitted = (lock.omittedOptionalAssets ?? []).filter((entry) => entry.kind !== 'printer-cover');
    const printerCovers = await capturePrinterCovers(files, omitted, lock.provenance?.observedOrcaSubmoduleCommit);
    // This maintenance mode never recaptures an engine, profile, or prior image.
    // Keep old entry objects intact and assert their hashes before changing lock.
    for (const entry of original) if (files.get(entry.path) !== entry) throw new Error(`Existing locked asset was replaced: ${entry.path}`);
    lock = { ...lock, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')), omittedOptionalAssets: omitted.sort((a, b) => a.path.localeCompare(b.path, 'en')), printerCovers };
    if (printerCovers.added) delete lock.snapshot;
    await validateSnapshot();
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`Printer covers: ${printerCovers.available}/${printerCovers.models} available; ${printerCovers.added} added, ${printerCovers.unavailable} unavailable in both upstream sources.`);
    if (printerCovers.added) console.warn('Existing asset hashes were preserved. Publish the expanded immutable ZIP and add lock.snapshot { url, bytes, sha256 } before CI deployment.');
  }
  if (addMt) {
    const original = lock.files;
    const files = new Map(original.map((entry) => [entry.path, entry]));
    const captured = await captureMultiThreadedEngine(files, lock.engine);
    const multiThreadedEngine = captured.added || !lock.multiThreadedEngine ? captured : lock.multiThreadedEngine;
    for (const entry of original) if (entry.path !== 'wasm/orca/mt/slicer.mjs' && files.get(entry.path) !== entry) throw new Error(`Existing locked asset was replaced: ${entry.path}`);
    lock = { ...lock, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')), multiThreadedEngine };
    if (captured.added || captured.transformed) delete lock.snapshot;
    await validateSnapshot();
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`Multi-threaded engine: ${multiThreadedEngine.version.version}, bridge ${multiThreadedEngine.version.bridge}; two-thread startup passed, ${captured.added} assets added.`);
    console.warn('Run the real asynchronous MT slicing integration check before enabling this engine. Publish an expanded immutable snapshot before CI deployment.');
  }
  if (patchMt) {
    const original = lock.files;
    const files = new Map(original.map((entry) => [entry.path, entry]));
    const changed = await patchMtGlue(files);
    for (const entry of original) if (entry.path !== 'wasm/orca/mt/slicer.mjs' && files.get(entry.path) !== entry) throw new Error(`Existing locked asset was replaced: ${entry.path}`);
    lock = { ...lock, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')) };
    if (changed) delete lock.snapshot;
    await validateSnapshot();
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`MT core-budget guard ${changed ? 'applied' : 'already present'}; WASM and all other asset hashes preserved.`);
    if (changed) console.warn('Publish the reviewed guarded MT snapshot and add lock.snapshot before CI deployment.');
  }
}

const result = await validateSnapshot();
await validateEngineRuntime(result.version);
if (result.hasMt) await validateEngineRuntime(result.version, true);
const totalBytes = lock.files.reduce((total, entry) => total + entry.bytes, 0);
if (!verifyOnly) await writeFile(join(publicRoot, 'wasm/pages-assets-provenance.json'), `${JSON.stringify({ ...lock, files: undefined }, null, 2)}\n`);
console.log(`Staged OrcaSlicer ${result.version.version} / bridge ${result.version.bridge}; CAD ABI ${result.cad.abi}; ${result.vendors} vendors / ${result.presets} presets.`);
console.log(`${lock.files.length} assets, ${(totalBytes / 1048576).toFixed(1)} MiB; ${downloaded} downloaded, ${reused} verified locally.`);
if (lock.omittedOptionalAssets.length) console.warn(`${lock.omittedOptionalAssets.length} optional visual assets are unavailable upstream (listed in the lock); all slicing profiles are present.`);
