export function send(path, orderId, view) {
  return fetch(this.host + path, {
    method: 'POST',
    headers: {'X-View': view},
    body: JSON.stringify({orderId, view}),
  });
}
