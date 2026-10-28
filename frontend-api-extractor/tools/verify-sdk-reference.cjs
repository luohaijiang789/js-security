const fs = require("node:fs");
const assert = require("node:assert/strict");
const path = require("node:path");
if (!process.argv[2])
  throw Error(
    "用法: node tools/verify-sdk-reference.cjs /path/to/aliyun-sdk [output.json]",
  );
const location = path.resolve(process.argv[2]);
if (require(path.join(location, "package.json")).version !== "1.12.3")
  throw Error("需要aliyun-sdk 1.12.3");
const ALY = require(location);
(async () => {
  const { sdkModel, sdkHttpModel, encodeSdkParameters } =
    await import("../src/sdk-http-model.js");
  let attemptedNetwork = 0;
  ALY.HttpClient.getInstance().handleRequest = () => {
    attemptedNetwork++;
    throw Error("network forbidden in reference build");
  };
  const checks = [];
  for (const [service, model] of Object.entries(sdkModel.services))
    for (const [operation, spec] of Object.entries(model.operations)) {
      const params = {};
      for (const [name, type] of Object.entries(spec.types)) {
        if (name === "Action") continue;
        params[name] = ["integer", "long", "float", "double"].includes(type)
          ? 1
          : type === "boolean"
            ? true
            : name === "Policy"
              ? "张 + !()*"
              : name === "PolicyDocument"
                ? '{"Version":"1","Statement":[]}'
                : "a+b value";
      }
      const candidate = {
        candidateKind: "sdk-operation",
        module: "aliyun-sdk",
        service,
        sdkVersion: "1.12.3",
        apiVersion: model.apiVersion,
        operation,
        endpoint: "http://127.0.0.1:1/custom",
        input: structuredClone(params),
      };
      const modeled = sdkHttpModel(candidate);
      assert.ok(modeled, service + "." + operation);
      const client = new ALY[service]({
          endpoint: candidate.endpoint,
          apiVersion: model.apiVersion,
          accessKeyId: "TEST_KEY",
          secretAccessKey: "TEST_SECRET",
          region: "cn-hangzhou",
        }),
        request = client[operation](params);
      await new Promise((resolve, reject) =>
        request.build((err) => (err ? reject(err) : resolve())),
      );
      const actual = request.httpRequest,
        body = new URLSearchParams(actual.body);
      assert.equal(actual.method, modeled.method);
      assert.equal(actual.path, modeled.path);
      assert.deepEqual(
        [...body.keys()].sort(),
        Object.keys(modeled.body).sort(),
      );
      assert.deepEqual(
        Object.keys(actual.headers).sort(),
        Object.keys(modeled.headers).sort(),
      );
      for (const [name, value] of Object.entries(modeled.body))
        if (value === null || typeof value !== "object")
          assert.equal(
            body.get(name),
            String(value),
            service + "." + operation + "." + name,
          );
      const encodedKnown = encodeSdkParameters(candidate.input);
      for (const [name, value] of new URLSearchParams(encodedKnown))
        assert.equal(body.get(name), value);
      assert.equal(actual.body, ALY.util.queryParamsToString(params));
      assert.equal(encodedKnown, ALY.util.queryParamsToString(candidate.input));
      checks.push({
        service,
        operation,
        method: actual.method,
        path: actual.path,
        bodyFields: [...body.keys()],
        headerFields: Object.keys(actual.headers),
        knownValuesAndEncodingMatched: true,
      });
    }
  assert.equal(attemptedNetwork, 0);
  fs.writeFileSync(
    process.argv[3] ?? "sdk-reference-results.json",
    JSON.stringify(
      {
        module: "aliyun-sdk",
        version: "1.12.3",
        phase: "build-only",
        attemptedNetwork,
        checks,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ operations: checks.length, attemptedNetwork }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
