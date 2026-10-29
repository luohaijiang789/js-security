import {send} from './send.js';
const client = {host: 'https://api.example.test'};
const loadOrder = send.bind(client, '/orders');
loadOrder(42, 'summary');
