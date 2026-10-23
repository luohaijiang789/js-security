import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";
import {
  OPTIONAL_FIELDS,
  savedFieldSet,
  selectRecordFields,
} from "../src/field-selection";
import { defaults } from "../src/model";
import { workspaceFixture } from "./fixtures";

describe("optional saved fields", () => {
  const source = () => workspaceFixture().records[98];

  it("defaults to every optional field, including legacy configs", () => {
    const config = defaults();
    expect(config.saved_fields).toEqual([...OPTIONAL_FIELDS]);
    delete config.saved_fields;
    expect([...savedFieldSet(config)]).toEqual([...OPTIONAL_FIELDS]);
    expect(selectRecordFields(source(), config)).toEqual(source());
  });

  it("removes unchecked payloads while preserving required identity fields", () => {
    const original = source();
    const config = { ...defaults(), saved_fields: ["query_params"] };
    const selected = selectRecordFields(original, config);

    expect(selected).not.toBe(original);
    expect(selected.request_id).toBe(original.request_id);
    expect(selected.request_url).toBe(original.request_url);
    expect(selected.method).toBe(original.method);
    expect(selected.status_code).toBe(original.status_code);
    expect(selected.query_params).toEqual(original.query_params);
    expect(selected.request_headers).toEqual([]);
    expect(selected.request_body).toEqual({
      representation: "unavailable",
      parsed: null,
    });
    expect(selected.response_headers).toEqual([]);
    expect(selected.response_headers_raw).toBeNull();
    expect(selected.response_body).toEqual({
      representation: "unavailable",
      parsed: null,
    });
    expect(selected.response_content_type).toBe("");
    expect(selected.response_metadata).toBeUndefined();
    expect(selected.content_type).toBe("");
    expect(selected.page_url).toBeNull();
    expect(selected.initiator).toBeUndefined();
    expect(selected.initiator_url).toBeNull();
    expect(selected.initiator_stack).toBeNull();
    expect(selected.capture_status.headers.reason).toBe("任务未选择保存请求头");
    expect(selected.capture_status.body.reason).toBe("任务未选择保存请求体");
    expect(selected.capture_status.response_headers?.reason).toBe(
      "任务未选择保存响应头",
    );
    expect(selected.capture_status.response_body?.reason).toBe(
      "任务未选择保存响应体",
    );
    expect(selected.capture_status.response_metadata?.reason).toBe(
      "任务未选择保存响应元数据",
    );
    expect(selected.capture_status.page.reason).toBe("任务未选择保存页面来源");
    expect(selected.capture_status.stack.reason).toBe("任务未选择保存调用栈");
    expect(original.request_headers.length).toBeGreaterThan(0);
  });

  it("rejects unknown or duplicate field selections", () => {
    expect(() =>
      validateConfig({ ...defaults(), saved_fields: ["unknown"] }),
    ).toThrow("保存字段配置无效");
    expect(() =>
      validateConfig({
        ...defaults(),
        saved_fields: ["request_headers", "request_headers"],
      }),
    ).toThrow("保存字段配置无效");
  });
});
