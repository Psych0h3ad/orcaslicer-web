import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { needsExperimentalIsolation, prepareThreadIsolation, threadModeUrl, threadPageMode } from './threadIsolation';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
function browser() {
  const container = Object.assign(new EventTarget(), {
    controller: null as { scriptURL: string } | null,
    getRegistration: vi.fn(),
    register: vi.fn(async (url: string) => { container.controller = { scriptURL: url }; return {}; }),
  });
  const location = { href: 'https://example.test/', reload: vi.fn() };
  vi.stubGlobal('navigator', { userAgent: 'AppleWebKit/537.36 Chrome/130.0 Safari/537.36', serviceWorker: container });
  vi.stubGlobal('location', location);
  vi.stubGlobal('sessionStorage', storage());
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('crossOriginIsolated', false);
  vi.stubGlobal('isSecureContext', true);
  return { container, location };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('thread startup before the editor opens', () => {
  beforeEach(() => { browser(); });
  it('uses explicit modes and keeps WebKit experimental, including iOS Chrome', () => {
    expect(threadPageMode('https://x.test/?threads=single')).toBe('single');
    expect(threadPageMode('https://x.test/?threads=multi')).toBe('multi');
    expect(threadPageMode('https://x.test/?threads=unknown')).toBe('auto');
    expect(needsExperimentalIsolation('AppleWebKit/605.1 Safari/605.1')).toBe(true);
    expect(needsExperimentalIsolation('iPhone AppleWebKit/605.1 CriOS/130.0')).toBe(true);
    expect(needsExperimentalIsolation('AppleWebKit/537.36 Chrome/130.0')).toBe(false);
  });
  it('registers in the project scope and reloads only once', async () => {
    const { container, location } = browser();
    expect((await prepareThreadIsolation()).reloading).toBe(true);
    expect(container.register).toHaveBeenCalledWith('https://example.test/thread-isolation-sw.js', { scope: '/', updateViaCache: 'none' });
    expect((await prepareThreadIsolation()).reloading).toBe(false);
    expect(location.reload).toHaveBeenCalledTimes(1);
  });
  it('does not replay model imports when restarting a saved project', () => {
    const { location } = browser();
    location.href = 'https://example.test/?model=original.stl&handoff=old&name=original&cubby-debug=1';
    const url = new URL(threadModeUrl('multi'));
    expect(url.searchParams.has('model')).toBe(false);
    expect(url.searchParams.has('handoff')).toBe(false);
    expect(url.searchParams.get('threads')).toBe('multi');
    expect(url.searchParams.get('cubby-debug')).toBe('1');
  });
  it('starts immediately when isolation is already available', async () => {
    const { container, location } = browser();
    vi.stubGlobal('crossOriginIsolated', true);
    expect((await prepareThreadIsolation()).isolated).toBe(true);
    expect(container.register).not.toHaveBeenCalled();
    expect(location.reload).not.toHaveBeenCalled();
  });
  it('does not register in Safari by default', async () => {
    const { container } = browser();
    vi.stubGlobal('navigator', { userAgent: 'AppleWebKit/605.1 Safari/605.1', serviceWorker: container });
    expect((await prepareThreadIsolation()).experimental).toBe(true);
    expect(container.register).not.toHaveBeenCalled();
  });
  it('allows an explicit experimental WebKit attempt', async () => {
    const { container, location } = browser();
    location.href += '?threads=multi';
    vi.stubGlobal('navigator', { userAgent: 'AppleWebKit/605.1 Safari/605.1', serviceWorker: container });
    expect((await prepareThreadIsolation()).reloading).toBe(true);
  });
  it('unregisters only this application when switching to single-threaded mode', async () => {
    const { container, location } = browser();
    location.href += '?threads=single';
    const owned = { scriptURL: 'https://example.test/thread-isolation-sw.js' };
    const unregister = vi.fn(async () => true);
    container.controller = owned;
    container.getRegistration.mockResolvedValue({ active: owned, unregister });
    expect((await prepareThreadIsolation()).reloading).toBe(true);
    expect(unregister).toHaveBeenCalledTimes(1);
    const unrelated = { scriptURL: 'https://example.test/another-app/sw.js' };
    container.controller = unrelated;
    const otherUnregister = vi.fn();
    container.getRegistration.mockResolvedValue({ active: unrelated, unregister: otherUnregister });
    expect((await prepareThreadIsolation()).reloading).toBe(false);
    expect(otherUnregister).not.toHaveBeenCalled();
  });
  it('does not register or reload when session storage is blocked', async () => {
    const { container, location } = browser();
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect((await prepareThreadIsolation()).reloading).toBe(false);
    expect(container.register).not.toHaveBeenCalled();
    expect(location.reload).not.toHaveBeenCalled();
  });
  it('ignores late installation after the startup deadline', async () => {
    vi.useFakeTimers();
    const { container, location } = browser();
    let settle!: (value: object) => void;
    container.register.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    const pending = prepareThreadIsolation();
    await vi.advanceTimersByTimeAsync(6001);
    expect((await pending).reloading).toBe(false);
    settle({});
    container.controller = { scriptURL: 'https://example.test/thread-isolation-sw.js' };
    container.dispatchEvent(new Event('controllerchange'));
    await Promise.resolve();
    expect(location.reload).not.toHaveBeenCalled();
  });
});

describe('project-scoped service worker', () => {
  it('adds isolation headers without changing response bytes or intercepting other apps', async () => {
    const events: Record<string, (event: unknown) => void> = {};
    const fetcher = vi.fn(async () => new Response('unchanged bytes', { headers: { 'content-type': 'text/plain' } }));
    runInNewContext(readFileSync(new URL('../../public/thread-isolation-sw.js', import.meta.url), 'utf8'), {
      self: { registration: { scope: 'https://example.test/orcaslicer-web/' }, addEventListener: (name: string, fn: (event: unknown) => void) => { events[name] = fn; } },
      URL, Headers, Response, fetch: fetcher,
    });
    let result: Promise<Response> | undefined;
    events.fetch({ request: new Request('https://example.test/orcaslicer-web/assets/engine.js'), respondWith: (value: Promise<Response>) => { result = value; } });
    const response = await result!;
    expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(await response.text()).toBe('unchanged bytes');
    for (const request of [new Request('https://example.test/other-app/'), new Request('https://printer.test/status'), new Request('https://example.test/orcaslicer-web/upload', { method: 'POST' })]) {
      const respondWith = vi.fn();
      events.fetch({ request, respondWith });
      expect(respondWith).not.toHaveBeenCalled();
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
