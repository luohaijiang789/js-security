var t=atob("aHR0cHM6Ly9hcGkuZXhhbXBsZS50ZXN0");var s=(o,r)=>fetch(t+"/"+o,{method:"POST",body:JSON.stringify(r)});var p=o=>s(["v2","users","lookup"].join("/"),{account:o});export{p as load};
