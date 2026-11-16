// Ship a source download next to the app so AGPL source remains discoverable
// even when this dist directory is deployed without a GitHub repository link.
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean);
const files = {};
for (const path of paths) {
  if (path.startsWith('.openai/') || path.startsWith('.git/')) continue;
  files[path] = new Uint8Array(readFileSync(resolve(root, path)));
}
files['SOURCE-INFO.txt'] = strToU8([
  'OrcaSlicer Web · CubbySlicer — frontend source',
  'License: AGPL-3.0-or-later; see LICENSE.',
  'Dependencies: install from package-lock.json using npm ci.',
  'WASM artifacts and their separate source repositories/observed revisions:',
  'see scripts/pages-assets.lock.json and public/wasm/pages-assets-provenance.json.',
  'The frontend source archive does not include engine binaries or npm dependencies.',
  '',
].join('\n'));
writeFileSync(resolve(root, 'public/source.zip'), zipSync(files, { level: 6 }));
copyFileSync(resolve(root, 'LICENSE'), resolve(root, 'public/LICENSE.txt'));
console.log(`Prepared source.zip (${paths.length} frontend files) and LICENSE.txt`);
