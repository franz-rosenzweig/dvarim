import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { installShellBridge } from './lib/shell.js';
import { setupBackend } from './lib/backend.js';

// Server, or a vault on this device: decided before anything asks for data.
// It is quick when it is the server (nothing is loaded) and a moment when it is
// local (the engine and the vault are).
let app;
setupBackend()
  .catch((e) => console.error('Dvarim: could not open this device\'s vault; using the server', e))
  .finally(() => { app = mount(App, { target: document.getElementById('app') }); });

// window.dvarim: how the macOS shell builds its menu bar. Harmless in a browser.
installShellBridge();

// The service worker keeps the app for offline use when it comes from a
// server. A shell that carries the app inside itself (docs/BRIDGE.md) has
// nothing to keep, and a cached copy would only outlive the next update.
const bundled = !/^https?:$/.test(location.protocol) || location.hostname === 'appassets.androidplatform.net'
  || !!(window.webkit?.messageHandlers?.dvarimStorage || window.DvarimStorage);
if (import.meta.env.PROD && 'serviceWorker' in navigator && !bundled) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// The notes editor is a chunk of its own that only an open card needs. Fetch it
// once the app has settled, so the first card opens with it — and so the
// service worker, which keeps whatever it has fetched, has it for offline too.
if (typeof window !== 'undefined') {
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 2000));
  window.addEventListener('load', () => idle(() => import('./lib/notes-editor.js').catch(() => {})));
}

export { app };
