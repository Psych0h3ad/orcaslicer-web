import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SliceJob, WorkerRequest, WorkerResponse } from './types';

type Outcome = 'result' | 'fatal' | 'stalled' | 'crash' | 'validation' | 'pending';
type RecordedMessage = WorkerRequest | { type: 'init'; engine: string; base: string; noMt: boolean; threads: number };
const outcomes: Outcome[] = [];
const workers: FakeWorker[] = [];
const report = { ok: true, error: null, warnings: [], stats: null };

/** Exercise the real client protocol, including the outer Worker's onerror. */
class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: RecordedMessage[] = [];
  terminated = false;
  constructor() { workers.push(this); }
  terminate() { this.terminated = true; }
  postMessage(message: RecordedMessage, transfer: Transferable[] = []) {
    // Browser structured cloning catches accidental transfer/detachment of the
    // source mesh: a fallback must receive the full original model again.
    const copy = structuredClone(message, { transfer });
    this.messages.push(copy);
    if (copy.type !== 'slice') return;
    const outcome = outcomes.shift();
    if (outcome === 'pending') return;
    queueMicrotask(() => {
      if (this.terminated) return;
      if (outcome === 'crash') {
        this.onerror?.({ message: 'pthread Worker crashed', preventDefault() {} } as ErrorEvent);
        return;
      }
      let response: WorkerResponse;
      if (outcome === 'result') {
        response = { type: 'result', id: copy.id, gcode: new TextEncoder().encode('G1 X10 E1\n').buffer, report };
      } else if (outcome === 'validation') {
        response = { type: 'error', id: copy.id, message: 'Invalid layer height', fatal: false,
          report: { ok: false, error: 'Invalid layer height', warnings: [], stats: null } };
      } else {
        response = { type: 'error', id: copy.id, message: `MT ${outcome}`, fatal: true, stalled: outcome === 'stalled' };
      }
      this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
    });
  }
}

function job(): SliceJob {
  return {
    engine: 'orca', config: { layer_height: '0.2' },
    objects: [{ id: 'cube', name: 'Cube', positions: new Float32Array([0, 0, 0, 20, 0, 0, 0, 20, 0]), indices: new Uint32Array([0, 1, 2]),
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
  };
}

const sliceMessages = () => workers.flatMap((worker) => worker.messages.filter((message) => message.type === 'slice'));

beforeEach(() => {
  vi.resetModules();
  outcomes.length = 0;
  workers.length = 0;
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal('location', { href: 'https://example.test/orcaslicer-web/' });
  vi.stubGlobal('crossOriginIsolated', true);
  vi.stubGlobal('Worker', FakeWorker);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('sliceJob multi-threaded recovery', () => {
  it('honors selecting ST after an MT opt-in without reloading the editor', async () => {
    const current = { href: 'https://example.test/orcaslicer-web/?threads=multi', search: '?threads=multi' };
    vi.stubGlobal('location', current);
    const replaceState = vi.fn((_state, _title, href: string) => { current.href = href; current.search = new URL(href).search; });
    vi.stubGlobal('history', { state: null, replaceState });
    const { engineThreadsPref, setEngineThreadsPref } = await import('./client');
    setEngineThreadsPref(1);
    expect(engineThreadsPref()).toBe(1);
    expect(new URL(current.href).searchParams.get('threads')).toBe('auto');
    expect(replaceState).toHaveBeenCalledTimes(1);
  });
  it('forces the single-thread recovery URL even when MT is saved', async () => {
    localStorage.setItem('cubby-slicer:engine-threads', '8');
    vi.stubGlobal('location', { href: 'https://example.test/orcaslicer-web/?threads=single', search: '?threads=single' });
    outcomes.push('fatal');
    const { sliceJob, engineThreadsPref } = await import('./client');
    expect(engineThreadsPref()).toBe(1);
    await expect(sliceJob(job())).rejects.toMatchObject({ fatal: true });
    expect(sliceMessages()).toHaveLength(1);
    expect(workers[0].messages[0]).toMatchObject({ type: 'init', threads: 1 });
    expect(localStorage.getItem('cubby-slicer:engine-threads')).toBe('8');
  });

  it('lets an explicit MT URL override a saved single-thread preference without changing storage', async () => {
    localStorage.setItem('cubby-slicer:engine-threads', '1');
    vi.stubGlobal('location', { href: 'https://example.test/orcaslicer-web/?threads=multi', search: '?threads=multi' });
    outcomes.push('fatal', 'result');
    const { sliceJob, engineThreadsPref } = await import('./client');
    expect(engineThreadsPref()).toBe(0);
    await sliceJob(job());
    expect(sliceMessages()).toHaveLength(2);
    expect(workers[0].messages[0]).toMatchObject({ type: 'init', threads: 0 });
    expect(localStorage.getItem('cubby-slicer:engine-threads')).toBe('1');
  });

  it('reads the preference without a browser location in Node', async () => {
    vi.stubGlobal('location', undefined);
    localStorage.setItem('cubby-slicer:engine-threads', '4');
    const { engineThreadsPref } = await import('./client');
    expect(engineThreadsPref()).toBe(4);
  });

  it.each(['fatal', 'stalled', 'crash'] as const)('retries %s once in ST mode and preserves the complete source mesh', async (failure) => {
    outcomes.push(failure, 'result');
    const { sliceJob } = await import('./client');
    const source = job();
    const originalPositions = source.objects[0].positions.slice();
    const originalIndices = source.objects[0].indices.slice();
    const onProgress = vi.fn();
    const result = await sliceJob(source, onProgress);
    expect(new TextDecoder().decode(result.gcode)).toBe('G1 X10 E1\n');
    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(true);
    expect(workers.map((worker) => worker.messages.find((message) => message.type === 'init'))).toEqual([
      expect.objectContaining({ type: 'init', noMt: false }),
      expect.objectContaining({ type: 'init', noMt: true }),
    ]);
    expect(sliceMessages()).toHaveLength(2);
    for (const request of sliceMessages()) {
      expect(request.job).toEqual(source);
      expect(request.job.objects[0].positions).not.toBe(source.objects[0].positions);
    }
    expect(source.objects[0].positions).toEqual(originalPositions);
    expect(source.objects[0].indices).toEqual(originalIndices);
    expect(onProgress).toHaveBeenCalledWith({ percent: 0, message: 'Retrying with the single-threaded engine' });
  });

  it('surfaces a failed ST retry without starting a third attempt', async () => {
    outcomes.push('crash', 'fatal');
    const { sliceJob, SliceError } = await import('./client');
    await expect(sliceJob(job())).rejects.toBeInstanceOf(SliceError);
    expect(sliceMessages()).toHaveLength(2);
    expect(workers).toHaveLength(2);
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it('keeps later slices in ST mode after the session fallback', async () => {
    outcomes.push('fatal', 'result', 'fatal');
    const { sliceJob } = await import('./client');
    await sliceJob(job());
    await expect(sliceJob(job())).rejects.toMatchObject({ fatal: true, message: 'MT fatal' });
    expect(sliceMessages()).toHaveLength(3);
    expect(workers).toHaveLength(2);
  });

  it.each(['unisolated', 'single-thread preference', 'single-thread engine'] as const)('does not retry an initial ST request: %s', async (reason) => {
    const source = job();
    if (reason === 'unisolated') vi.stubGlobal('crossOriginIsolated', false);
    if (reason === 'single-thread preference') localStorage.setItem('cubby-slicer:engine-threads', '1');
    if (reason === 'single-thread engine') source.engine = 'preflight';
    outcomes.push('fatal');
    const { sliceJob } = await import('./client');
    await expect(sliceJob(source)).rejects.toMatchObject({ fatal: true });
    expect(sliceMessages()).toHaveLength(1);
    expect(workers).toHaveLength(1);
  });

  it('does not resubmit invalid configuration', async () => {
    outcomes.push('validation');
    const { sliceJob } = await import('./client');
    await expect(sliceJob(job())).rejects.toMatchObject({ fatal: false, message: 'Invalid layer height' });
    expect(sliceMessages()).toHaveLength(1);
    expect(workers[0].terminated).toBe(false);
  });

  it('cancels the in-flight request without retrying', async () => {
    outcomes.push('pending');
    const { sliceJob, SliceCancelled } = await import('./client');
    const controller = new AbortController();
    const promise = sliceJob(job(), undefined, controller.signal);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(SliceCancelled);
    expect(sliceMessages()).toHaveLength(1);
    expect(workers[0].terminated).toBe(true);
  });

  it('respects cancellation at the fallback progress notification', async () => {
    outcomes.push('crash');
    const { sliceJob, SliceCancelled } = await import('./client');
    const controller = new AbortController();
    await expect(sliceJob(job(), () => controller.abort(), controller.signal)).rejects.toBeInstanceOf(SliceCancelled);
    expect(sliceMessages()).toHaveLength(1);
    expect(workers).toHaveLength(1);
  });
});
