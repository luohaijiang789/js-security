import {send} from './transport.js';
const body={id:7,old:true};
delete body.old;
send('/items',body);
body.id=8;
send('/items',body);
fetch('/relative?limit=2',{headers:{'X-App':'audit'}});
