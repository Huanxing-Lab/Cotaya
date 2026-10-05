// CT-09 脚本化模型 provider fixture（docs/testing/continuous.md §3「脚本化模型」）。
//
// 通过实际模型 HTTP 接口接入（chat completions 形状），返回合法模型事件、tool calls、
// typed submit_result 与 usage；禁止直接注入最终 Cycle 成功状态、禁止绕过 AgentRuntime/
// Engine/journal——provider 只能像真实模型一样「说话」，业务事实必须由产品链路产生。
//
// 可控点：
// - 按脚本步进（steps 按请求序号返回内容，支持 candidates/decision/tool 载荷）；
// - barrier：请求进入后可停在命名 barrier，测试在事件到达后精确注入 kill/重复/乱序；
// - 故障：transient/permanent failure、取消、usage 缺失/重复/晚到（同 requestKey 重放）；
// - 记录全部请求（脱敏后入 artifacts：usage.jsonl / commands.json）。
//
// 价格用虚构固定值（微美元/百万 token 整数），账本断言可精确计算（§3）。

import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createBarrier } from "./fixtures.mjs";

// 虚构固定价目（微美元 / 百万 token）：输入 1_000_000、输出 2_000_000。
export const SCRIPTED_PROVIDER_PRICES = {
  version: "e2e-scripted-1",
  perMillionMicros: { input: 1_000_000, output: 2_000_000 },
};

export function createScriptedProvider(run, { name = "scripted-provider" } = {}) {
  const artifactsDir = path.join(run.dirs.artifacts, "provider");
  mkdirSync(artifactsDir, { recursive: true });
  const usageFile = path.join(artifactsDir, "usage.jsonl");
  const commandsFile = path.join(artifactsDir, "commands.jsonl");
  const barriers = new Map();
  const requests = [];
  let sequence = 0;
  const script = { steps: [], defaultUsage: { inputTokens: 1_000, outputTokens: 500 } };

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        handleCompletion(body, response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/__e2e/release") {
        const { barrier } = JSON.parse(body || "{}");
        barriers.get(barrier)?.release();
        response.writeHead(204).end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/__e2e/script") {
        Object.assign(script, JSON.parse(body || "{}"));
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end("not found");
    });
  });

  async function handleCompletion(body, response) {
    sequence += 1;
    const step = script.steps[(sequence - 1) % Math.max(script.steps.length, 1)] ?? {};
    appendFileSync(
      commandsFile,
      `${JSON.stringify({ at: Date.now(), sequence, bodyBytes: body.length })}\n`,
      "utf8",
    );
    requests.push({ sequence, at: Date.now() });
    if (step.barrier) {
      const barrier = barriers.get(step.barrier) ?? createBarrier(step.barrier);
      barriers.set(step.barrier, barrier);
      barrier.arrive();
      try {
        await barrier.wait();
      } catch {
        response.writeHead(503).end(JSON.stringify({ error: { message: "barrier timeout" } }));
        return;
      }
    }
    if (step.fault) {
      if (step.fault.kind === "drop-usage") {
        // 请求成功但不发布 usage：晚到/缺失 usage 的注入点（账本必须保留 unknown 预留）。
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(completionPayload(step, null)));
        return;
      }
      const status = step.fault.status ?? (step.fault.kind === "transient" ? 502 : 401);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `injected ${step.fault.kind} fault` } }));
      return;
    }
    const usage = step.usage ?? script.defaultUsage;
    if (step.fault?.kind !== "drop-usage" && usage) {
      const record = {
        at: Date.now(),
        sequence,
        requestKey: `req-${sequence}`,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        duplicate: false,
      };
      appendFileSync(usageFile, `${JSON.stringify(record)}\n`, "utf8");
      if (step.fault?.kind === "duplicate-usage") {
        appendFileSync(usageFile, `${JSON.stringify({ ...record, duplicate: true })}\n`, "utf8");
      }
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(completionPayload(step, usage)));
  }

  function completionPayload(step, usage) {
    const message = {
      role: "assistant",
      content: step.content ?? "",
      ...(step.toolCalls ? { tool_calls: step.toolCalls } : {}),
    };
    return {
      id: `chatcmpl-e2e-${sequence}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "continuous-e2e-scripted",
      choices: [{ index: 0, message, finish_reason: step.toolCalls ? "tool_calls" : "stop" }],
      usage: usage
        ? {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens,
          }
        : undefined,
    };
  }

  const started = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
  const close = async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    // Node 的 keep-alive socket 会挂住测试进程事件循环；关闭时主动断开全部连接。
    server.closeAllConnections?.();
    for (const barrier of barriers.values()) barrier.dispose();
  };
  run.cleanupFns.push(close);
  return {
    name,
    started,
    url: async () => `http://127.0.0.1:${(await started).port}`,
    control: {
      async setScript(next) {
        Object.assign(script, next);
      },
      async release(barrier) {
        barriers.get(barrier)?.release();
      },
      barrierState: (barrier) => ({
        arrived: barriers.get(barrier)?.isArrived() ?? false,
        released: barriers.get(barrier)?.isReleased() ?? false,
      }),
    },
    facts: () => ({
      prices: SCRIPTED_PROVIDER_PRICES,
      requestCount: sequence,
      usageFile,
      commandsFile,
    }),
    close,
  };
}
