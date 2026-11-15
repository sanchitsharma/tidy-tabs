// Dev auto-reload for unpacked installs: popup/options files are read from disk on every open,
// but the service worker keeps running the code from load time. If manifest.json on disk has a
// different version than the running extension, reload so the new code takes effect.
(async () => {
  try {
    if (chrome.runtime.getManifest().update_url) return; // store build: never self-reload
    const running = chrome.runtime.getManifest().version;
    const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    const onDisk = (await res.json()).version;
    if (onDisk && onDisk !== running) {
      document.body.prepend(Object.assign(document.createElement('p'), {
        textContent: `Updating Tidy Tabs ${running} → ${onDisk}… reopen this popup in a second.`,
      }));
      setTimeout(() => chrome.runtime.reload(), 300);
    }
  } catch (e) {
    console.warn('dev-reload check failed', e);
  }
})();
