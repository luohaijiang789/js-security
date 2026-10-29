import{test}from'node:test';import assert from'node:assert/strict';import{jshoundRows,verifyJshound}from'../src/jshound.js';import{fixture}from'./helpers.js';import{toDelivery}from'../src/delivery.js';
test('jshound projection separates call candidates from route/path/nav evidence and preserves unknowns',()=>{
 const records=[{kind:'xhr',sink:'codegen.request',method:'POST',template:'https://api.test/items',body_shape:{account:{id:'input:id'}},query_schema:{page:'input:page'},req_headers:{'x-token':'runtime'},_chunk:0},{_kind:'route',kind:'xhr',method:'GET',template:'/page',_chunk:0},{_kind:'path-literal',method:'UNKNOWN',template:'/string',_chunk:0},{kind:'nav',method:'GET',template:'/navigation',_chunk:0}];
 const rows=jshoundRows(records,[{file:'api.js'}]);assert.equal(rows.length,1);assert.equal(rows[0].sourceLine,null);assert.equal(rows[0].linkState,null);assert.equal(rows[0].host,'api.test');assert.equal(rows[0].resolution,'partial');assert.ok(rows[0].parameterFields.some(f=>f.path.join('.')==='account.id'&&f.state==='known-field'));assert.ok(rows[0].parameterFields.some(f=>f.carrier==='query'&&f.path[0]==='page'));assert.ok(rows[0].body.account.id.__unknown);const d=toDelivery({rows});assert.equal(d.records[0].addressState,'PARTIAL');assert.equal(d.records[0].carrierStates.body,'PARTIAL');assert.equal(d.scope.complete,false);
});
test('jshound missing carriers and unknown method do not become empty objects or GET',()=>{
 const rows=jshoundRows([{kind:'fetch',method:'UNKNOWN',template:'/{param:id}',_chunk:0}],[{file:'api.js'}]);assert.equal(rows[0].method,'{jshound.method}');assert.ok(rows[0].query.__unknown);assert.equal(rows[0].host,null);assert.throws(()=>jshoundRows([{kind:'fetch',method:'GET',template:'/x',_chunk:9}],[{file:'api.js'}]),/文件索引/);
});
test('jshound pin mismatch and missing engine fail before executing an untrusted worker',async t=>{
 const missing=await fixture(t,{}),wrong=await fixture(t,{'jshound/js/static_ast.js':'throw new Error("must not execute")'});await assert.rejects(verifyJshound({engineRoot:missing}),/git submodule update/);await assert.rejects(verifyJshound({engineRoot:wrong}),/哈希不匹配/);
});
