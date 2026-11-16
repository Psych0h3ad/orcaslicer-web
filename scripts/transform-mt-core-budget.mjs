/**
 * Orca's initial TBB warmup waits for max_concurrency() participants. The
 * upstream JS reports physical CPU cores while the engine limits TBB with
 * csThreads, so a 24-core host with a 2-thread budget can wait forever.
 * Use the actual engine budget in the host and every re-imported pthread.
 * The WASM and all slicing code remain byte-for-byte unchanged.
 *
 * Fail closed on any unreviewed upstream JS. Changing this transform requires
 * reviewing both exact expressions, updating the pinned hashes, and passing
 * real asynchronous slicing with 2, 4 and automatic thread budgets.
 */
import { createHash } from 'node:crypto';

export const MT_CORE_BUDGET_TRANSFORM = Object.freeze({
  id: 'orca-mt-core-budget-v1',
  helper: 'scripts/transform-mt-core-budget.mjs',
  reason: 'Keep TBB warmup concurrency equal to the actual engine thread budget, including child pthreads, instead of the physical host core count.',
  source: { bytes: 99884, sha256: '3f7beb280eeb133d43e7443f68f0cf18c4701adae423bb36de9cea7a8ef6837e' },
  output: { bytes: 100020, sha256: 'b1b81b018827cb8113e57a2ee354c1ac82b934cef9b115283a0616de6ea8185e' },
  find: "_emscripten_num_logical_cores=()=>ENVIRONMENT_IS_NODE?require(\"node:os\").cpus().length:navigator[\"hardwareConcurrency\"]",
  replace: "_emscripten_num_logical_cores=/* OrcaSlicer Web: TBB warmup concurrency must match the active engine thread budget. See scripts/transform-mt-core-budget.mjs. */()=>typeof Module[\"_cs_thread_count\"]===\"function\"?Module[\"_cs_thread_count\"]():csThreadCount()",
});

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const count = (text, pattern) => text.split(pattern).length - 1;

export function transformMtCoreBudget(input) {
  const bytes = Buffer.from(input);
  const text = bytes.toString('utf8');
  const rule = MT_CORE_BUDGET_TRANSFORM;
  if (bytes.length === rule.output.bytes && hash(bytes) === rule.output.sha256) {
    if (count(text, rule.replace) !== 1 || count(text, rule.find) !== 0) throw new Error('Guarded MT JS does not contain exactly one expected replacement');
    return { bytes, changed: false };
  }
  if (bytes.length !== rule.source.bytes || hash(bytes) !== rule.source.sha256) throw new Error('Unreviewed MT JS source: core-budget transform refuses an unexpected source SHA-256');
  if (count(text, rule.find) !== 1 || count(text, rule.replace) !== 0) throw new Error('MT core-budget transform requires exactly one original expression and no existing replacement');
  const output = Buffer.from(text.replace(rule.find, rule.replace));
  if (output.length !== rule.output.bytes || hash(output) !== rule.output.sha256) throw new Error('MT core-budget transform output does not match its pinned derived SHA-256');
  return { bytes: output, changed: true };
}
