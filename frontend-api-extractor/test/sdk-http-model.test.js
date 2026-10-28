import { test } from "node:test";
import assert from "node:assert/strict";
import { sdkHttpModel, sdkModel } from "../src/sdk-http-model.js";
import { analyze } from "../src/analyzer.js";
import { requestRows } from "../src/request-table.js";
import { fixture } from "./helpers.js";
const candidate = {
  candidateKind: "sdk-operation",
  module: "aliyun-sdk",
  service: "STS",
  sdkVersion: "1.12.3",
  operation: "assumeRole",
  endpoint: "https://sts.aliyuncs.com/custom",
  input: {
    RoleArn: "acs:ram::123:role/test",
    RoleSessionName: "demo",
    Policy: '{"x":"a + 张"}',
  },
};
test("固定版本STS协议恢复POST/根路径/Body与默认字段，不猜签名值", () => {
  const h = sdkHttpModel(candidate);
  assert.equal(h.method, "POST");
  assert.equal(h.url, "https://sts.aliyuncs.com/");
  assert.equal(h.body.Action, "AssumeRole");
  assert.equal(h.body.Version, "2015-04-01");
  assert.equal(h.body.Policy, candidate.input.Policy);
  assert.ok(h.body.Signature.__unknown);
  assert.equal(
    h.headers["Content-Type"],
    "application/x-www-form-urlencoded;charset=UTF-8",
  );
});
test("版本范围/未知服务/非法输入不生成伪HTTP，RAM按记录协议而非猜测", () => {
  for (const c of [
    { ...candidate, sdkVersion: null },
    { ...candidate, service: "OSS" },
    { ...candidate, input: {} },
    { ...candidate, input: { ...candidate.input, Unexpected: "x" } },
  ])
    assert.equal(sdkHttpModel(c), null);
  const ram = sdkHttpModel({
    ...candidate,
    service: "RAM",
    operation: "listUsers",
    endpoint: "https://ram.aliyuncs.com",
    input: { MaxItems: 10, Marker: "a+b" },
  });
  assert.equal(ram.body.Action, "ListUsers");
  assert.equal(ram.body.Marker, "a+b");
  assert.equal(ram.method, sdkModel.services.RAM.operations.listUsers.method);
});
test("源码SDK候选以独立协议阶段进入表格，保留原始SDK候选与未知", async (t) => {
  const root = await fixture(t, {
    "api.js": `const ALY=require('aliyun-sdk');const sts=new ALY.STS({endpoint:'https://sts.aliyuncs.com'});sts.assumeRole({RoleArn:arn,RoleSessionName:'demo'});`,
    "package.json": '{"dependencies":{"aliyun-sdk":"1.12.3"}}',
  });
  const r = await analyze(root),
    rows = requestRows(r);
  assert.equal(r.endpoints.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, "sdk-protocol-build");
  assert.equal(rows[0].resolution, "partial");
  assert.equal(rows[0].generatedFile, null);
  assert.ok(rows[0].gaps.length);
});
