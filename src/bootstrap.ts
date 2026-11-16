import { prepareThreadIsolation } from './platform/threadIsolation';

// Keep App's module-level side effects (presets, workers, autosave) behind the
// isolation handshake. A reload is only requested before any project is opened.
void prepareThreadIsolation().then((result) => {
  if (!result.reloading) return import('./main');
}).catch((error: unknown) => {
  console.error(error);
  const root = document.getElementById('app');
  if (root) {
    const message = document.createElement('p');
    message.textContent = 'アプリを読み込めませんでした。';
    const recover = document.createElement('a');
    const url = new URL(location.href);
    url.searchParams.set('threads', 'single');
    recover.href = url.href;
    recover.textContent = 'シングルスレッドで開き直す';
    root.replaceChildren(message, recover);
  }
});
