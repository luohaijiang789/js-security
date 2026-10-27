import axios from 'axios';

const client = axios.create({ baseURL: '/api' });
export const get = (url: string, config: object) => client({ ...config, url, method: 'GET' });
