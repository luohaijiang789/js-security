import {host} from './config.js';
export const send=(path,body)=>fetch(host+'/'+path,{method:'POST',body:JSON.stringify(body)});
