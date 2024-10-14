import {} from '@sapper/service-worker'

// minimal network-only service worker that enables installation
// see https://developers.google.com/web/ilt/pwa/caching-files-with-service-worker#network_only
self.addEventListener('fetch', event => {})
