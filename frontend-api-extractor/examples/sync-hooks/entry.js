import axios from 'axios';
const api=axios.create({baseURL:'https://before.test'});
const removed=api.interceptors.request.use(c=>{c.url='/wrong';return c},null,{synchronous:true});
api.interceptors.request.use(c=>{
  c.baseURL='https://after.test';
  c.url='/items';
  c.headers['X-Order']='first';
  c.data=JSON.stringify(c.data);
  return c;
},null,{synchronous:true});
api.interceptors.request.use(c=>{
  c.headers['X-Order']='second';
  delete c.data.old;
  c.data.tag='added';
  return c;
},null,{synchronous:true});
api.interceptors.request.eject(removed);
api.post('/original',{id:7,old:true});
