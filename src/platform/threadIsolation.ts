import { readString, removeKey, writeString } from '../lib/storage';

export type ThreadPageMode = 'auto' | 'multi' | 'single';
export interface ThreadStartup {
  isolated: boolean;
  reloading: boolean;
  experimental: boolean;
  reason: string;
}

const SCRIPT = 'thread-isolation-sw.js';
const GENERATION = 'v1';
const TIMEOUT_MS = 6000;
export let threadStartup: ThreadStartup = { isolated: false, reloading: false, experimental: false, reason: '' };

export function threadPageMode(href: string): ThreadPageMode {
  const value = new URL(href).searchParams.get('threads');
  if (value === 'multi' || value === 'single') return value;
  return 'auto';
}

/** Safari and iOS browsers use the experimental path because of WebKit 322883. */
export function needsExperimentalIsolation(userAgent: string): boolean {
  return /AppleWebKit\//.test(userAgent) && !/(?:Chrome|Chromium|Edg|OPR)\//.test(userAgent);
}

function retryKey(scope: string, action: 'enable' | 'disable'): string {
  return `cubby-slicer:thread-isolation:${GENERATION}:${scope}:${action}`;
}

/** Only a deliberate editor restart clears failed attempts, never a late SW event. */
export function clearThreadStartupAttempts(): void {
  const scope = new URL(import.meta.env.BASE_URL, location.href).pathname;
  removeKey(retryKey(scope, 'enable'), 'session');
  removeKey(retryKey(scope, 'disable'), 'session');
}

export function threadModeUrl(mode: ThreadPageMode): string {
  const url = new URL(location.href);
  // This is an editor restart after saving. Replaying an old import/handoff
  // would bypass restoreAutosave() and reopen the source instead of the edits.
  for (const key of ['model', 'name', 'handoff', 'workspace', 'path', 'arrange', 'spacing', 'rotate', 'cloud']) url.searchParams.delete(key);
  url.searchParams.set('threads', mode);
  return url.href;
}

/** Runs before importing main.ts: the editor can never be reloaded by a late event. */
export async function prepareThreadIsolation(): Promise<ThreadStartup> {
  const finish = (reason: string, isolated = false, reloading = false, experimental = false) => {
    threadStartup = { reason, isolated, reloading, experimental };
    return threadStartup;
  };
  const mode = threadPageMode(location.href);
  const experimental = needsExperimentalIsolation(navigator.userAgent);
  const scope = new URL(import.meta.env.BASE_URL, location.href);
  const script = new URL(SCRIPT, scope);
  const owned = (worker: ServiceWorker | null | undefined) => worker?.scriptURL === script.href;
  const deadline = Date.now() + TIMEOUT_MS;
  const bounded = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Thread startup timed out')), Math.max(0, deadline - Date.now()));
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
  const reloadOnce = (action: 'enable' | 'disable'): boolean => {
    const key = retryKey(scope.pathname, action);
    if (readString(key, 'session') || !writeString(key, 'attempted', 'session')) return false;
    location.reload();
    return true;
  };
  try {
    const sw = navigator.serviceWorker;
    const single = mode === 'single' || (mode !== 'multi' && Number(readString('cubby-slicer:engine-threads')) === 1) || (experimental && mode !== 'multi');
    if (single) {
      if (sw) {
        const registration = await bounded(sw.getRegistration(scope.href));
        if (registration && [registration.active, registration.waiting, registration.installing].some(owned)) {
          await bounded(registration.unregister());
        }
        if (owned(sw.controller) && reloadOnce('disable')) return finish('シングルスレッドへ切り替え中', false, true, experimental);
      }
      return finish(experimental && mode !== 'single' ? 'Safari / iPadではマルチスレッドは実験オプションです' : 'シングルスレッドを選択しています', false, false, experimental);
    }
    if (globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function') {
      removeKey(retryKey(scope.pathname, 'enable'), 'session');
      return finish('マルチスレッドを利用できます', true, false, experimental);
    }
    if (!globalThis.isSecureContext || !sw) return finish('このブラウザではマルチスレッドを有効にできません', false, false, experimental);
    const key = retryKey(scope.pathname, 'enable');
    if (readString(key, 'session')) return finish('起動条件を満たせないためシングルスレッドを使います', false, false, experimental);
    // Without a session marker, automatic reload could loop indefinitely.
    if (!writeString(key, 'checking', 'session')) return finish('ブラウザの保存領域が使えないためシングルスレッドを使います', false, false, experimental);
    removeKey(key, 'session');
    await bounded(sw.register(script.href, { scope: scope.pathname, updateViaCache: 'none' }));
    if (!owned(sw.controller)) {
      await new Promise<void>((resolve, reject) => {
        const done = (error?: Error) => { clearTimeout(timer); sw.removeEventListener('controllerchange', changed); if (error) reject(error); else resolve(); };
        const changed = () => { if (owned(sw.controller)) done(); };
        const timer = setTimeout(() => done(new Error('Thread controller timed out')), Math.max(0, deadline - Date.now()));
        sw.addEventListener('controllerchange', changed);
        changed();
      });
    }
    if (reloadOnce('enable')) return finish('マルチスレッドを準備しています', false, true, experimental);
    return finish('自動再読み込みを省略しました。シングルスレッドを使います', false, false, experimental);
  } catch {
    return finish('準備できなかったためシングルスレッドを使います', false, false, experimental);
  }
}
