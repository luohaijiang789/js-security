export function lookup(id){return fetch('https://api.example.test/users/lookup',{method:'POST',body:JSON.stringify({account:{id}})});}
