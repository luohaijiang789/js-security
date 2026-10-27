import {prepare} from './prepare.js';
import {send} from './transport.js';

const body={account:{id:7},obsolete:true};
const config={url:'/v1/items',method:'POST',headers:{'X-Old':'remove'},data:body};
prepare(config);
send(config);
body.account.id=9;
send(config);
