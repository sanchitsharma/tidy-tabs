// Shows the RUNNING version and its update time (manifest version_name, set by ../bump.sh).
(() => {
  const m = chrome.runtime.getManifest();
  const label = m.version_name || m.version;
  const tag = document.createElement('div');
  tag.id = 'build-badge';
  tag.textContent = `v${label.replace(/\((.+)\)/, '· updated $1')}`;
  tag.style.cssText = 'font:11px/1.4 system-ui,sans-serif;color:#6b7280;margin:2px 0 6px';
  const anchor = document.querySelector('h1');
  if (anchor) anchor.after(tag);
  else document.body.prepend(tag);
})();
