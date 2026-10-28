export function send(path,body) {
  fetch('https://api.example.test'+path,{method:'POST',body});
}
