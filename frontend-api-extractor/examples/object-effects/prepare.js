export function prepare(config) {
  config.url='https://api.example.test'+config.url;
  const headers=config.headers;
  headers['X-App']='audit';
  delete headers['X-Old'];
  delete config.data.obsolete;
  config.data.account.id+=1;
}
