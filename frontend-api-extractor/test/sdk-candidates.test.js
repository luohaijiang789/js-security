import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/analyzer.js";
import { fixture } from "./helpers.js";
test("固定SDK初始化、工厂和操作输入独立于HTTP候选，不导出凭证", async (t) => {
  const root = await fixture(t, {
    "api.js": `const ALY=require('aliyun-sdk');function getClient(){return new ALY.STS({endpoint:'https://sts.aliyuncs.com',accessKeyId:'secret',secretAccessKey:'private'})}function assume(arn){const sts=getClient();sts.assumeRole({Action:'AssumeRole',RoleArn:arn,DurationSeconds:3600})}`,
    "package.json": '{"dependencies":{"aliyun-sdk":"^1.12.3"}}',
  });
  const r = await analyze(root);
  assert.equal(r.endpoints.length, 0);
  assert.equal(r.sdkCandidates.length, 2);
  const op = r.sdkCandidates.find((c) => c.operation === "assumeRole");
  assert.equal(op.endpoint, "https://sts.aliyuncs.com");
  assert.equal(op.sdkVersion, null);
  assert.equal(op.httpState, "unmodeled");
  assert.ok(op.inputFields.some((p) => p[0] === "RoleArn"));
  assert.ok(!JSON.stringify(r.sdkCandidates).includes("private"));
});
test("普通对象的STS和同名操作不冒充阿里SDK，精确版本单独记录", async (t) => {
  const root = await fixture(t, {
    "api.js": `const fake={STS(){}};new fake.STS({endpoint:'https://wrong.test'});const ALY=require('aliyun-sdk');const ram=new ALY.RAM({endpoint:'https://ram.aliyuncs.com'});ram.listUsers({MaxItems:100});`,
    "package.json": '{"dependencies":{"aliyun-sdk":"1.12.3"}}',
  });
  const r = await analyze(root);
  assert.equal(r.sdkCandidates.length, 2);
  assert.equal(r.sdkCandidates[0].sdkVersion, "1.12.3");
});

test("被重绑定的SDK接收者与局部require不能被提升为协议HTTP", async (t) => {
  const root = await fixture(t, {
    "api.js": `const ALY=require('aliyun-sdk');let ram=new ALY.RAM({});ram=other;ram.listUsers({});function fake(require){const Local=require('aliyun-sdk');new Local.RAM({})}`,
    "package.json": '{"dependencies":{"aliyun-sdk":"1.12.3"}}',
  });
  const r = await analyze(root);
  assert.equal(
    r.sdkCandidates.filter((c) => c.candidateKind === "sdk-operation").length,
    0,
  );
  assert.equal(
    r.sdkCandidates.filter((c) => c.candidateKind === "sdk-initialization")
      .length,
    1,
  );
});

test("SDK未知配置展开和自定义API版本不冒充固定协议", async (t) => {
  const root = await fixture(t, {
    "api.js": `const ALY=require('aliyun-sdk');const a=new ALY.STS({endpoint:'https://old.test',...options});a.assumeRole({RoleArn:'x',RoleSessionName:'s'});const b=new ALY.STS({apiVersion:'1900-01-01'});b.assumeRole({RoleArn:'x',RoleSessionName:'s'});`,
    "package.json": '{"dependencies":{"aliyun-sdk":"1.12.3"}}',
  });
  const r = await analyze(root);
  assert.equal(r.sdkCandidates.filter((c) => c.modeledHttp).length, 0);
});

test("SDK工厂返回局部实例再被操作使用，保留初始化和调用位置", async (t) => {
  const root = await fixture(t, {
    "api.js": `const ALY=require('aliyun-sdk');function assume(){const sts=getClient();sts.assumeRole({RoleArn:'role',RoleSessionName:'s'})}function getClient(){const client=new ALY.STS({endpoint:'https://sts.aliyuncs.com'});return client}`,
    "package.json": '{"dependencies":{"aliyun-sdk":"^1.12.3"}}',
  });
  const r = await analyze(root);
  const op = r.sdkCandidates.find((c) => c.operation === "assumeRole");
  assert.ok(op);
  assert.equal(op.endpoint, "https://sts.aliyuncs.com");
  assert.equal(op.httpState, "unmodeled");
  assert.ok(op.creation.column !== op.location.column);
});
