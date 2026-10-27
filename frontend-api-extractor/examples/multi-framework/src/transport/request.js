import axios from 'axios';

const client = axios.create({ baseURL: '/v1', headers: { 'X-App': 'fixture' } });
export function request(options) {
  return client(options);
}
export const get = (url, params) => request({ method: 'GET', url, params });
