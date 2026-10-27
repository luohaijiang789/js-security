const { url } = { url: '/v1/native' };
globalThis.fetch(url);
const cache = new Map();
cache.get('/should-not-extract-map');
function local(fetch) { fetch('/should-not-extract-shadow'); }
