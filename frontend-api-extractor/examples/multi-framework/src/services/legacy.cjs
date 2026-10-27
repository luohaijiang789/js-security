const http = require('axios').create({ baseURL: '/v1' });
exports.load = id => http.get(`/cjs/${id}`);
