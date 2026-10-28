export function query(id){return fetch('https://deep.example.test/v2/query',{method:'POST',body:JSON.stringify({id})});}
