import { ofetch } from 'ofetch';
import ky from 'ky';

const api = ofetch.create({ baseURL: '/v2', query: { locale: 'zh' } });
api('/search', { query: { q: 'example' } });

const uploads = ky.create({ prefixUrl: '/v2/' });
uploads.post('uploads', { json: { name: 'example' } });

// Preserve the pairing between URL and method in the same runtime branch.
let url: string, method: string;
if (runtimeMode) {
  url = '/v2/preview';
  method = 'GET';
} else {
  url = '/v2/publish';
  method = 'POST';
}
fetch(url, { method });

for (const resource of ['teams', 'projects']) {
  fetch(`/v2/${resource}`);
}

const request = new Request(new URL('/profile', 'https://example.test'), { method: 'PATCH', body: 'example' });
fetch(request);
