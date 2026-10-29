import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyze} from '../src/analyzer.js';
import {fixture} from './helpers.js';
import {requestRows} from '../src/request-table.js';

test('cross-file bind preserves live receiver, prefixed args and sending-point entry chain',async t=>{
 const root=await fixture(t,{'entry.js':`import {send} from './send.js';const context={host:'https://before.test'};const bound=send.bind(context,'/items');context.host='https://api.test';bound(7);`,'send.js':`export function send(path,id){fetch(this.host+path,{method:'POST',body:{id}})}`});
 const report=await analyze(root,{entries:['entry.js']});const rows=requestRows(report);assert.equal(rows.length,1);assert.equal(rows[0].host,'api.test');assert.equal(rows[0].method,'POST');assert.equal(rows[0].body.id,7);assert.equal(rows[0].linkState,'entry-trace');assert.equal(rows[0].sourceFile,'send.js');assert.ok(report.endpoints[0].usages[0].callChain.some(c=>c.file==='entry.js'));
});
test('rebind appends args while original receiver wins over bind, call and apply',async t=>{
 const root=await fixture(t,{'entry.js':`function send(path,a,b){fetch(this.host+path,{body:{a,b}})}const first=send.bind({host:'https://a.test'},'/items');const second=first.bind({host:'https://wrong.test'},1);second.call({host:'https://also-wrong.test'},2);second.apply(null,[3]);`});
 const r=await analyze(root);assert.deepEqual(r.endpoints.map(e=>e.url),['https://a.test/items']);assert.deepEqual(r.endpoints[0].usages.map(u=>u.body),[{a:1,b:2},{a:1,b:3}]);
});
test('instance method binding and computed bind retain receiver after extraction',async t=>{
 const root=await fixture(t,{'entry.js':`class Client{host='https://api.test';send(path,id){fetch(this.host+path,{body:{id}})}}const a=new Client();const b=a.send['bind'](a,'/items');b(9);`});
 const r=await analyze(root);assert.equal(r.endpoints[0].url,'https://api.test/items');assert.equal(r.endpoints[0].body.id,9);
});
test('bind cannot replace arrow lexical this or manufacture unknown receiver Host',async t=>{
 const root=await fixture(t,{'entry.js':`function factory(){return (path)=>fetch(this.host+path)}const arrow=factory.call({host:'https://lexical.test'});arrow.bind({host:'https://wrong.test'})('/items');function send(){fetch(this.host+'/unknown')}send.bind(runtimeContext)();`});
 const r=await analyze(root);assert.ok(r.endpoints.some(e=>e.url==='https://lexical.test/items'));assert.ok(!r.endpoints.some(e=>e.url.includes('wrong.test')));const unresolved=r.endpoints.find(e=>e.url.includes('/unknown'));assert.equal(unresolved.usages[0].address.host,null);
});
test('overridden own bind and unrelated same-name methods use their actual implementation',async t=>{
 const root=await fixture(t,{'entry.js':`function send(){fetch('https://must-not-run.test')}send.bind=()=>()=>fetch('https://override.test');send.bind(null)();const x={bind(){fetch('https://ordinary.test')}};x.bind();`});
 const r=await analyze(root,{entries:['entry.js']});const traced=r.endpoints.filter(e=>e.usages.some(u=>u.linkState==='entry-trace')).map(e=>e.url);assert.ok(traced.includes('https://override.test'));assert.ok(traced.includes('https://ordinary.test'));assert.ok(!traced.includes('https://must-not-run.test'));
});
test('bound argument budget and recursion keep diagnostics instead of unbounded expansion',async t=>{
 const root=await fixture(t,{'entry.js':`function send(...args){fetch('/items',{body:{args}})}send.bind(null,1,2).bind(null,3)();function loop(){loop.bind(null)()}loop();`});
 const r=await analyze(root,{maxCandidates:2});assert.ok(r.diagnostics.some(d=>d.code==='BOUND_ARGUMENT_LIMIT'));assert.ok(r.diagnostics.some(d=>d.code==='RECURSION'));
});
test('bound receiver and prefilled object aliases stay aligned inside conditional path clones',async t=>{
 const root=await fixture(t,{'entry.js':`function send(data){fetch(this.host+'/items',{body:data})}const context={host:'https://before.test'},data={id:0};const b=send.bind(context,data);if(flag){context.host='https://a.test';data.id=1;b()}else{context.host='https://b.test';data.id=2;b()}`});
 const r=await analyze(root);const variants=r.endpoints.flatMap(e=>e.usages.map(u=>[e.url,u.body.id]));assert.deepEqual(variants,[['https://a.test/items',1],['https://b.test/items',2]]);
});
test('new bound function does not inherit own call/apply overrides from its target',async t=>{
 const root=await fixture(t,{'entry.js':`function send(path){fetch(this.host+path)}send.call=()=>fetch('https://wrong.test');const b=send.bind({host:'https://api.test'});b.call(null,'/items');`});const r=await analyze(root);assert.ok(r.endpoints.some(e=>e.url==='https://api.test/items'));
});
test('self-authored bind scenarios agree with native JavaScript using a fake fetch only',async t=>{
 const {runInNewContext}=await import('node:vm');
 const cases=[
  `function f(path,id){fetch(this.host+path,{method:'POST',body:{id}})}f.bind({host:'https://a.test'},'/x')(7)`,
  `function f(path,a,b){fetch(this.host+path,{body:{a,b}})}f.bind({host:'https://a.test'},'/x').bind({host:'https://b.test'},1).apply(null,[2])`,
  `function make(){return path=>fetch(this.host+path)}make.call({host:'https://a.test'}).bind({host:'https://b.test'})('/x')`,
  `class C{host='https://a.test';f(path){fetch(this.host+path)}}const c=new C();c.f.bind(c,'/x')()`,
  `function f(path){fetch(this.host+path)}const ctx={host:'https://old.test'},b=f.bind(ctx);ctx.host='https://new.test';b('/x')`,
  `function f(){fetch('https://original.test')}f.bind=()=>()=>fetch('https://override.test');f.bind(null)()`,
  `function f(){fetch('https://own-this.test')}f.bind=function(){return this};f.bind(null)()`,
 ];
 for(const code of cases){const observed=[];runInNewContext(code,{fetch:(url,options={})=>observed.push({url,method:options.method??'GET',body:options.body??null})},{timeout:1000});const root=await fixture(t,{'entry.js':code});const r=await analyze(root);const rows=requestRows(r).filter(row=>row.linkState==='entry-trace').map(row=>({url:row.url,method:row.method,body:row.body}));assert.deepEqual(JSON.parse(JSON.stringify(rows)),JSON.parse(JSON.stringify(observed)),code);}
});
test('dynamic function member writes disable intrinsic assumptions; deleting known override restores native bind',async t=>{
 const root=await fixture(t,{'entry.js':`function unsafe(){fetch('https://must-not-trace.test')}unsafe[key]=replacement;unsafe.bind(null)();function safe(){fetch('https://restored.test')}safe.bind=()=>{};delete safe.bind;safe.bind(null)();`});const r=await analyze(root);const traced=requestRows(r).filter(row=>row.linkState==='entry-trace');assert.ok(!traced.some(row=>row.host==='must-not-trace.test'));assert.ok(traced.some(row=>row.host==='restored.test'));assert.ok(r.diagnostics.some(d=>d.code==='FUNCTION_MEMBER_UNMODELED'));
});
test('known JSON serialization after binding retains known fields without treating JSON braces as placeholders',async t=>{
 const root=await fixture(t,{'entry.js':`function send(id){fetch(this.host+'/items',{method:'POST',body:JSON.stringify({id})})}send.bind({host:'https://api.test'},7)();`});const r=await analyze(root);assert.equal(r.endpoints[0].resolution,'resolved');assert.equal(r.endpoints[0].body,'{"id":7}');assert.ok(r.endpoints[0].parameterFields.some(f=>f.carrier==='body'&&f.path[0]==='id'));
});
test('unknown serialized values and unsupported replacers remain partial after bind',async t=>{
 const root=await fixture(t,{'entry.js':`function send(id){fetch('https://api.test/unknown',{method:'POST',body:JSON.stringify({id})});fetch('https://api.test/replacer',{body:JSON.stringify({id:7},transform)})}send.bind(null,runtimeId)();`});const r=await analyze(root);assert.equal(r.endpoints.length,2);assert.ok(r.endpoints.every(e=>e.resolution==='partial'));
});
