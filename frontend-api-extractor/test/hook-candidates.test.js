import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/analyzer.js";
import { requestRows } from "../src/request-table.js";
import { toDelivery } from "../src/delivery.js";
import { fixture } from "./helpers.js";
test("未知异步/条件hook字段只作为未应用候选，不污染调用处/最终字段", async (t) => {
  const root = await fixture(t, {
    "api.js": `import axios from 'axios';const c=axios.create();c.interceptors.request.use(config=>{if(runtimeToken){config.params.username=username;config.headers=Object.assign({},config.headers,{accessToken});}if(config.method==='post'){config.data=qs.stringify(config.data);config.headers['Content-Type']='application/x-www-form-urlencoded';}return config;});c.post('/items',{id:7});`,
  });
  const r = await analyze(root),
    u = r.endpoints[0].usages[0];
  assert.equal(u.postHookState, "unknown");
  assert.deepEqual(u.body, { id: 7 });
  assert.equal(u.headers, null);
  assert.ok(
    u.hookFieldCandidates.some(
      (f) =>
        f.path[0] === "username" &&
        f.conditions[0].expression === "runtimeToken",
    ),
  );
  assert.ok(u.hookFieldCandidates.some((f) => f.path[0] === "accessToken"));
  assert.ok(!u.parameterFields.some((f) => f.path[0] === "accessToken"));
  const d = toDelivery({ rows: requestRows(r) });
  assert.ok(
    d.parameters.some(
      (f) =>
        f.path[0] === "accessToken" &&
        f.stage === "unapplied-request-hook" &&
        f.state === "candidate-field",
    ),
  );
});
test("response hook和普通同名函数不进入请求hook候选", async (t) => {
  const root = await fixture(t, {
    "api.js": `import axios from 'axios';axios.interceptors.response.use(config=>{config.headers.fake='x';return config});axios.get('/x')`,
  });
  const r = await analyze(root);
  assert.equal(r.endpoints[0].usages[0].hookFieldCandidates.length, 0);
});
