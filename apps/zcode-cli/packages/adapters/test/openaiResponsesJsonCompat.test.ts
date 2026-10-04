// 规格 openai-oauth-provider §2.7：ChatGPT Codex 后端强制请求体显式 store:false，
// AI SDK 不发送该字段（400 "Store must be set to false"）。单测覆盖兼容 fetch 的
// 定向请求体补丁与既有响应归一化行为不被破坏。
import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenAIResponsesJsonCompatFetch,
  type OpenAIResponsesJsonCompatOptions,
} from "../src/model/openai-responses-json-compat.js";

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

async function callFetch(options: OpenAIResponsesJsonCompatOptions, body: unknown) {
  const captured: CapturedRequest[] = [];
  const fetch = createOpenAIResponsesJsonCompatFetch(async (input, init) => {
    captured.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  }, options);
  const response = await fetch("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return captured[0]?.init;
}

test("forceStoreFalse 在 store 缺省时补 false", async () => {
  const init = await callFetch({ forceStoreFalse: true }, { model: "gpt-5.6-terra", input: [] });
  assert.deepEqual(JSON.parse(String(init?.body)), {
    model: "gpt-5.6-terra",
    input: [],
    store: false,
  });
});

test("forceStoreFalse 不覆盖显式 store 值", async () => {
  const init = await callFetch({ forceStoreFalse: true }, { model: "m", store: true });
  assert.deepEqual(JSON.parse(String(init?.body)), { model: "m", store: true });
});

test("未开启时不改请求体", async () => {
  const init = await callFetch({}, { model: "m", input: [] });
  assert.deepEqual(JSON.parse(String(init?.body)), { model: "m", input: [] });
});

test("非法 JSON body 原样透传不阻断", async () => {
  const init = await callFetch({ forceStoreFalse: true }, "not-json");
  assert.equal(init?.body, "not-json");
});
