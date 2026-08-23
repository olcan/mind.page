import {} from '@sapper/service-worker'

// minimal service worker that enables installation
// see https://developers.google.com/web/ilt/pwa/caching-files-with-service-worker#network_only
// NOTE: the no-op fetch handler below is only required for Chrome's automatic install prompt;
// installation from the menu no longer requires it (since Chrome 108 on mobile, 112 on desktop),
// and Chrome warns that a no-op handler adds overhead on every navigation, so it is disabled for
// now. Bring it back if its absence becomes inconvenient.
// self.addEventListener('fetch', event => {})

// activate new versions immediately instead of waiting for all controlled tabs to close, so that
// e.g. the previous no-op fetch handler is replaced on next load; this also keeps the worker
// bundle non-empty, avoiding the rollup warning 'Generated an empty chunk: "service-worker"'
self.addEventListener('install', () => (self as unknown as ServiceWorkerGlobalScope).skipWaiting())
