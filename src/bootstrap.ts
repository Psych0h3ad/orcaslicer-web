import { prepareThreadIsolation } from './platform/threadIsolation';

// Keep App's module-level side effects (presets, workers, autosave) behind the
// isolation handshake. A reload is only requested before any project is opened.
void prepareThreadIsolation().then((result) => {
  if (!result.reloading) return import('./main');
}).catch((error: unknown) => {
  console.error(error);
  const root = document.getElementById('app');
  if (root) root.textContent = 'アプリを読み込めませんでした。ページを再読み込みしてください。';
});
