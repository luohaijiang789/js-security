import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {analyze} from '../src/analyzer.js';
import {fixture} from './helpers.js';

test('固定跨文件样例匹配独立预期：Host、URL、Header、删除和两个调用快照',async()=>{
  const root=fileURLToPath(new URL('../examples/object-effects/',import.meta.url));
  const expected=JSON.parse(await fs.readFile(root+'expected.json','utf8'));
  const manifest=JSON.parse(await fs.readFile(root+'manifest.json','utf8'));
  for(const file of manifest.files)assert.equal(createHash('sha256').update(await fs.readFile(root+file.path)).digest('hex'),file.sha256);
  const r=await analyze(root,manifest.config);
  assert.equal(r.endpoints.length,1);
  const e=r.endpoints[0];
  assert.equal(e.method,expected.method);assert.equal(e.url,expected.url);
  assert.equal(e.address.host,'api.example.test');
  assert.deepEqual(e.usages.map(u=>u.body),expected.bodies);
  assert.ok(e.usages.every(u=>JSON.stringify(u.headers)===JSON.stringify(expected.headers)));
  assert.ok(e.usages[0].objectChanges.some(c=>c.operation==='delete'&&c.carrier==='headers'&&c.path[0]==='X-Old'&&c.file===expected.changeSource));
  assert.ok(e.usages[0].objectChanges.some(c=>c.operation==='set'&&c.carrier==='body'&&c.path.join('.')==='account.id'&&c.value===8));
});

test('属性读取与嵌套对象字面量保留别名，不把引用当值拷贝',async t=>{
  const root=await fixture(t,{'entry.js':`const headers={};const cfg={headers};const alias=cfg.headers;alias.token='value';fetch('/alias',cfg)`});
  const r=await analyze(root);assert.deepEqual(r.endpoints[0].headers,{token:'value'});
});

test('传入同一个对象两次仍保持实参别名',async t=>{
  const root=await fixture(t,{'entry.js':`function update(a,b){a.id=3;b.trace=a.id}const body={};update(body,body);fetch('/same',{method:'POST',body})`});
  assert.deepEqual((await analyze(root)).endpoints[0].body,{id:3,trace:3});
});

test('两个调用者的不同配置互不污染',async t=>{
  const root=await fixture(t,{'entry.js':`function send(cfg,id){cfg.headers.id=id;fetch(cfg.url,cfg)}send({url:'/one',headers:{}},1);send({url:'/two',headers:{}},2)`});
  const r=await analyze(root);assert.deepEqual(r.endpoints.map(e=>[e.url,e.headers.id]),[['/one',1],['/two',2]]);
});

test('对象展开只浅拷贝：共享嵌套对象，顶层字段分离',async t=>{
  const root=await fixture(t,{'entry.js':`const a={url:'/old',headers:{}};const b={...a};b.url='/new';b.headers.token='shared';fetch(a.url,a);fetch(b.url,b)`});
  const r=await analyze(root);assert.deepEqual(r.endpoints.map(e=>e.url),['/new','/old']);
  assert.ok(r.endpoints.every(e=>e.headers.token==='shared'));
});

test('属性计算键只求值一次，并先于右侧表达式解析',async t=>{
  const root=await fixture(t,{'entry.js':`const headers={};let key='first';headers[key]=(key='second');fetch('/order',{headers})`});
  assert.deepEqual((await analyze(root)).endpoints[0].headers,{first:'second'});
});

test('未知属性写入不保留伪确定旧值，也不生成占位键字段',async t=>{
  const root=await fixture(t,{'entry.js':`const headers={token:'before'};headers[runtimeKey]='after';fetch('/dynamic',{headers})`});
  const r=await analyze(root),e=r.endpoints[0];
  assert.ok(e.headers.token.__unknown);assert.equal(e.resolution,'partial');
  assert.ok(!e.parameterFields.some(f=>f.path.some(p=>p.includes('runtimeKey'))));
  assert.ok(r.diagnostics.some(d=>d.code==='DYNAMIC_PROPERTY_MUTATION'));
});

test('未知 delete 同样保留结构缺口',async t=>{
  const root=await fixture(t,{'entry.js':`const body={id:7};delete body[key];fetch('/delete',{method:'POST',body})`});
  const r=await analyze(root);assert.ok(r.endpoints[0].body.__unknown);
  assert.ok(r.endpoints[0].objectChanges.some(c=>c.operation==='unknown-write'));
});

test('条件内嵌套属性删除和赋值保持路径隔离',async t=>{
  const root=await fixture(t,{'entry.js':`const cfg={headers:{old:true}};if(flag){delete cfg.headers.old;cfg.headers.a=1}else{cfg.headers.b=2}fetch('/branches',cfg)`});
  const r=await analyze(root),usages=r.endpoints[0].usages;
  assert.equal(usages.length,2);
  assert.ok(usages.some(u=>u.headers.a===1&&!Object.hasOwn(u.headers,'old')&&!Object.hasOwn(u.headers,'b')));
  assert.ok(usages.some(u=>u.headers.b===2&&u.headers.old===true&&!Object.hasOwn(u.headers,'a')));
  assert.ok(usages.flatMap(u=>u.objectChanges).filter(c=>c.operation==='delete').every(c=>c.conditions.some(c=>c.expression==='flag'&&c.outcome===true)));
});

test('函数内部条件副作用未合并时不能在调用方继续输出旧值',async t=>{
  const root=await fixture(t,{'entry.js':`function edit(cfg){if(flag)cfg.headers.token='changed'}const cfg={headers:{token:'old'}};edit(cfg);fetch('/conditional',cfg)`});
  const r=await analyze(root);assert.notEqual(r.endpoints[0].headers?.token,'old');
  assert.notEqual(r.endpoints[0].resolution,'resolved');
  assert.ok(r.diagnostics.some(d=>d.code==='CONDITIONAL_CALL_EFFECTS'));
});

test('JSON 序列化快照保留改写依据，后续写入不改变已编码内容',async t=>{
  const root=await fixture(t,{'entry.js':`const body={id:1,old:true};delete body.old;body.id=2;const encoded=JSON.stringify(body);body.id=3;fetch('/json',{method:'POST',body:encoded})`});
  const e=(await analyze(root)).endpoints[0];assert.equal(e.body,'{"id":2}');
  assert.ok(e.objectChanges.some(c=>c.operation==='delete'&&c.path[0]==='old'));
  assert.ok(!e.objectChanges.some(c=>c.value===3));
});

test('加法复合赋值更新地址与数字，其他运算显式未知',async t=>{
  const root=await fixture(t,{'entry.js':`const cfg={url:'https://api.example.test',body:{id:2}};cfg.url+='/items';cfg.body.id*=3;fetch(cfg.url,{method:'POST',body:cfg.body})`});
  const r=await analyze(root);assert.equal(r.endpoints[0].url,'https://api.example.test/items');
  assert.ok(r.endpoints[0].body.id.__unknown);assert.ok(r.diagnostics.some(d=>d.code==='UNRESOLVED_ASSIGNMENT'));
  const other=await fixture(t,{'entry.js':`let total=0;total+=fetch('/compound-rhs')`});
  assert.ok((await analyze(other)).endpoints.some(e=>e.url==='/compound-rhs'));
});

test('未知字面量计算键不冒充真实参数名',async t=>{
  const root=await fixture(t,{'entry.js':`fetch('/literal',{method:'POST',body:{id:1,[runtimeKey]:2}})`});
  const r=await analyze(root);assert.equal(r.endpoints[0].resolution,'partial');
  assert.ok(!r.endpoints[0].parameterFields.some(f=>f.path.some(p=>p.includes('runtimeKey'))));
});

test('业务 objectChanges/operation 字段不会被误认为内部证据',async t=>{
  const root=await fixture(t,{'entry.js':`const body={objectChanges:'business',operation:'set'};body.id=1;fetch('/business',{method:'POST',body})`});
  const e=(await analyze(root)).endpoints[0];assert.deepEqual(e.body,{objectChanges:'business',operation:'set',id:1});
  assert.equal(e.objectChanges.length,1);
});

test('Object.assign 记录覆盖证据并保留目标别名',async t=>{
  const root=await fixture(t,{'entry.js':`const headers={old:1};const cfg={headers};Object.assign(headers,{old:2,trace:'yes'});fetch('/assign',cfg)`});
  const e=(await analyze(root)).endpoints[0];assert.deepEqual(e.headers,{old:2,trace:'yes'});
  assert.ok(e.objectChanges.some(c=>c.path[0]==='old'&&c.previous===1&&c.value===2));
});

test('未知 Object.assign 来源使可能被覆盖的值未知',async t=>{
  const root=await fixture(t,{'entry.js':`const body={id:1};Object.assign(body,runtimeObject);fetch('/assign-unknown',{method:'POST',body})`});
  const e=(await analyze(root)).endpoints[0];assert.ok(e.body.id.__unknown);assert.equal(e.resolution,'partial');
});

test('未知外部调用的对象副作用不保留确定旧值',async t=>{
  const root=await fixture(t,{'entry.js':`const cfg={headers:{token:'old'}};externalEdit(cfg);fetch('/external',cfg)`});
  const r=await analyze(root);assert.notEqual(r.endpoints[0].headers?.token,'old');
  assert.notEqual(r.endpoints[0].resolution,'resolved');assert.ok(r.diagnostics.some(d=>d.code==='UNKNOWN_CALL_EFFECTS'));
});

test('条件选择对象后的间接写入不能留下其他别名的伪确定值',async t=>{
  const root=await fixture(t,{'entry.js':`const a={token:'a'},b={token:'b'};const target=flag?a:b;target.token='new';fetch('/ambiguous',{headers:a})`});
  const r=await analyze(root);assert.notEqual(r.endpoints[0].headers?.token,'a');
  assert.notEqual(r.endpoints[0].resolution,'resolved');
});

test('大量改写证据有上限，截断不伪装完整',async t=>{
  const writes=Array.from({length:150},(_,i)=>`body.id=${i};`).join('');
  const root=await fixture(t,{'entry.js':`const body={};${writes}fetch('/bounded',{method:'POST',body})`});
  const r=await analyze(root);assert.equal(r.endpoints[0].body.id,149);
  assert.equal(r.endpoints[0].objectChanges.length,128);
  assert.ok(r.diagnostics.some(d=>d.code==='OBJECT_CHANGE_LIMIT'));assert.equal(r.stats.complete,false);
});

test('未知覆盖之后的明确 Object.assign 字段仍可恢复，整体保持部分解析',async t=>{
  const root=await fixture(t,{'entry.js':`const body={};Object.assign(body,runtimeObject,{id:7});fetch('/restore',{method:'POST',body})`});
  const e=(await analyze(root)).endpoints[0];assert.equal(e.body.id,7);assert.equal(e.resolution,'partial');
});

test('不能沿原型链取得宿主对象并执行属性改写',async t=>{
  const root=await fixture(t,{'entry.js':`const cfg={};cfg['__proto__'].__extractor_test_property__='bad';fetch('/safe',{headers:cfg})`});
  const r=await analyze(root);assert.equal(Object.hasOwn(Object.prototype,'__extractor_test_property__'),false);
  assert.ok(r.diagnostics.some(d=>d.code==='UNRESOLVED_ASSIGNMENT'));
});

test('展开合并的改写历史同样有界且保留截断诊断',async t=>{
  const writes=name=>Array.from({length:90},(_,i)=>`${name}.id=${i};`).join('');
  const root=await fixture(t,{'entry.js':`const a={},b={};${writes('a')}${writes('b')}fetch('/merge',{method:'POST',body:{...a,...b}})`});
  const r=await analyze(root);assert.equal(r.endpoints[0].objectChanges.length,128);
  assert.ok(r.diagnostics.some(d=>d.code==='OBJECT_CHANGE_LIMIT'));
});

test('三元表达式里的字段副作用不能丢失或合成错误组合',async t=>{
  const root=await fixture(t,{'entry.js':`const cfg={headers:{token:'old'}};flag?(cfg.headers.token='a'):(cfg.headers.token='b');fetch('/ternary',cfg)`});
  const r=await analyze(root);assert.deepEqual(r.endpoints[0].usages.map(u=>u.headers.token).sort(),['a','b']);
});

test('函数条件内未知外部改写也不能在调用方留下旧值',async t=>{
  const root=await fixture(t,{'entry.js':`function change(cfg){if(flag)external(cfg)}const cfg={headers:{token:'old'}};change(cfg);fetch('/unknown-branch',cfg)`});
  const r=await analyze(root);assert.notEqual(r.endpoints[0].headers?.token,'old');
  assert.notEqual(r.endpoints[0].resolution,'resolved');
});

test('未建模的属性自增仍要使原值失效',async t=>{
  const root=await fixture(t,{'entry.js':`const body={id:1};body.id++;fetch('/increment',{method:'POST',body})`});
  const r=await analyze(root);assert.ok(r.endpoints[0].body.id.__unknown);
  assert.ok(r.diagnostics.some(d=>d.code==='UNRESOLVED_ASSIGNMENT'));
});
