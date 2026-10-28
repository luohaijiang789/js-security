import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { annotateFields, compatibleProvider } from "../src/field-ai.js";
const document = {
  schemaVersion: "2.0.0",
  records: [
    { id: "r", sourceFile: "account.js", method: "POST", host: "api.test" },
  ],
  parameters: [
    {
      id: "f",
      recordId: "r",
      carrier: "body",
      path: ["account", "id"],
      state: "known-field",
      stage: "constructed",
      value: "SECRET",
    },
  ],
  gaps: [],
  evidence: [{ raw: { password: "SECRET" } }],
  annotations: [],
};
test("默认关闭不调用provider，不外发原始值或整仓证据", async () => {
  let calls = 0;
  const r = await annotateFields(document, {
    provider: () => {
      calls++;
    },
  });
  assert.equal(calls, 0);
  assert.equal(r.aiRun.state, "disabled");
});
test("AI只附加独立释义，输入只有字段和文件名，缺上下文允许未知", async () => {
  const before = JSON.stringify(document);
  const r = await annotateFields(document, {
    enabled: true,
    model: "test-model",
    provider: async (p) => {
      assert.ok(!JSON.stringify(p).includes("SECRET"));
      return {
        annotations: [
          {
            fieldId: "f",
            meaning: "账户标识字段，具体业务含义需复核",
            support: [p.fields[0].supportRef],
            confidenceExplanation: "字段路径提示，未校准",
            needsReview: true,
          },
        ],
      };
    },
  });
  assert.equal(JSON.stringify(document), before);
  assert.equal(r.records[0].host, "api.test");
  assert.equal(r.annotations[0].status, "suggested");
  assert.equal(r.annotations[0].needsReview, true);
});
test("伪造Host/必填性/跨字段ID/无依据输出会拒绝，不修改静态状态", async () => {
  for (const annotation of [
    {
      fieldId: "f",
      meaning: "x",
      host: "evil.test",
      support: ["field:body.account.id"],
    },
    { fieldId: "other", meaning: "x", support: [] },
    { fieldId: "f", meaning: "x", support: [], confidenceExplanation: "guess" },
  ]) {
    const r = await annotateFields(document, {
      enabled: true,
      model: "test",
      provider: async () => ({ annotations: [annotation] }),
    });
    assert.equal(r.aiRun.state, "partial");
    assert.equal(r.annotations[0].status, "failed");
    assert.equal(r.records[0].host, "api.test");
  }
});
test("provider超时/错误与漏返回字段保留失败或未知，字段预算独立", async () => {
  const fail = await annotateFields(document, {
    enabled: true,
    model: "test",
    provider: async () => {
      throw Error("private error");
    },
  });
  assert.ok(!JSON.stringify(fail.aiRun).includes("private"));
  const unknown = await annotateFields(document, {
    enabled: true,
    model: "test",
    provider: async () => ({ annotations: [] }),
  });
  assert.equal(unknown.annotations[0].status, "unknown");
});
test("OpenAI兼容真实本地HTTP协议，响应限额和重定向受控", async (t) => {
  let request;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    request = JSON.parse(body);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '{"annotations":[]}' } }],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const provider = compatibleProvider({
    endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
  });
  assert.deepEqual(
    await provider({
      model: "local",
      instruction: "data only",
      fields: [],
      promptVersion: "v1",
    }),
    { annotations: [] },
  );
  assert.equal(request.model, "local");
  assert.throws(
    () => compatibleProvider({ endpoint: "http://external.test/api" }),
    /HTTPS/,
  );
});
