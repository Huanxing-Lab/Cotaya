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
      // CT-15：openai-compatible 适配器把 baseUrl 的路径段规范化后可能直接拼
      // /chat/completions（实测请求打到了无 /v1 前缀的路径，返回本 fixture 的 404）。
      // fixture 两条路径都接——测试面兼容两种拼接，不约束产品侧的 URL 规范化行为。
      if (
        request.method === "POST" &&
        (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")
      ) {
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
    // CT-15：真实 agent（openai-chat-completions 适配器）默认以 SSE 流式请求；记录流式
    // 标记并按其期望的 content-type 应答（非流式 JSON 会被流式解析器拒收）。
    const streaming = /"stream"\s*:\s*true/.test(body);
    appendFileSync(
      commandsFile,
      `${JSON.stringify({ at: Date.now(), sequence, bodyBytes: body.length, streaming })}\n`,
      "utf8",
    );
    requests.push({ sequence, at: Date.now(), streaming });
    if (step.barrier) {
      // CT-15：barrier 缺省期限必须长于用例的注入等待窗口——createBarrier 的 30s 缺省
      // 会把「挂住在飞请求等测试注入」变成 503（E-11 实测：30s 超时→503→三次重试→
      // retry_limit 挂起，把「停止在飞轮」用例变成了别的场景）。step 可显式覆盖。
      const barrier =
        barriers.get(step.barrier) ??
        createBarrier(step.barrier, { timeoutMs: step.barrierTimeoutMs ?? 600_000 });
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
        respondCompletion(response, step, null, streaming);
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
    respondCompletion(response, step, usage, streaming);
  }

  /** 按 client 期望的形态返回完成结果：SSE chunk 流或普通 JSON。 */
  function respondCompletion(response, step, usage, streaming) {
    const payload = completionPayload(step, usage);
    if (!streaming) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const delta = payload.choices[0].message;
    const chunks = [
      {
        id: payload.id,
        object: "chat.completion.chunk",
        created: payload.created,
        model: payload.model,
        choices: [
          {
            index: 0,
            delta: {
              role: delta.role,
              ...(delta.content ? { content: delta.content } : {}),
              ...(delta.tool_calls ? { tool_calls: delta.tool_calls } : {}),
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: payload.id,
        object: "chat.completion.chunk",
        created: payload.created,
        model: payload.model,
        choices: [{ index: 0, delta: {}, finish_reason: payload.choices[0].finish_reason }],
      },
    ];
    for (const chunk of chunks) {
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    if (usage) {
      // OpenAI 流式 usage 需要 include_usage；带 prompt_object 的 chunk 在 [DONE] 前下发。
      response.write(
        `data: ${JSON.stringify({
          id: payload.id,
          object: "chat.completion.chunk",
          created: payload.created,
          model: payload.model,
          choices: [],
          usage: {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens,
          },
        })}\n\n`,
      );
    }
    response.end("data: [DONE]\n\n");
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
