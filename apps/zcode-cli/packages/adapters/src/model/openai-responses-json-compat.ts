import { randomUUID } from "node:crypto";

type ProviderFetch = typeof globalThis.fetch;

export interface OpenAIResponsesJsonCompatOptions {
  /**
   * ChatGPT Codex 后端（chatgpt.com/backend-api/codex）强制请求体显式
   * store:false（非公开 API 约定，spec openai-oauth-provider §2.7）；AI SDK 的
   * OpenAIResponsesLanguageModel 不发送该字段，缺省会收到
   * 400 "Store must be set to false"。开启后仅在 store 缺省时补 false，
   * 不覆盖显式设置；api.openai.com 等其他 baseUrl 不受影响。
   */
  readonly forceStoreFalse?: boolean;
}

export function createOpenAIResponsesJsonCompatFetch(
  baseFetch: ProviderFetch,
  options: OpenAIResponsesJsonCompatOptions = {},
): ProviderFetch {
  return async (input, init) => {
    const response = await baseFetch(
      input,
      options.forceStoreFalse ? withStoreFalseRequestBody(init) : init,
    );
    if (!response.ok || isEventStream(response)) {
      return response;
    }

    const body = await parseJsonObject(response);
    if (!body) {
      return response;
    }

    const normalized = normalizeOpenAIResponsesJson(body);
    if (!normalized) {
      return response;
    }

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");

    return new Response(JSON.stringify(normalized), {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

function withStoreFalseRequestBody(init: RequestInit | undefined): RequestInit | undefined {
  // AI SDK 的 JSON 请求体是字符串；流式等其他 body 形态保持原样（best-effort 补丁，
  // 解析失败也不得阻断请求）。
  if (!init?.body || typeof init.body !== "string") return init;
  let body: unknown;
  try {
    body = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return init;
  const record = body as Record<string, unknown>;
  if (record.store !== undefined) return init;
  return { ...init, body: JSON.stringify({ ...record, store: false }) };
}

function normalizeOpenAIResponsesJson(value: unknown): Record<string, unknown> | undefined {
  const response = asRecord(value);
  if (!response || !Array.isArray(response.output)) {
    return undefined;
  }

  const responseId =
    typeof response.id === "string" && response.id.length > 0 ? response.id : undefined;
  let changed = false;
  const output = response.output.map((item) => {
    const message = asRecord(item);
    if (message?.type !== "message") {
      return item;
    }

    let normalizedMessage = message;
    if (message.id === undefined && responseId) {
      // 部分 Responses-compatible 服务在非流式 compact 响应里省略
      // message.id，AI SDK 会在读取正文前拒绝整个 HTTP 200 响应。
      normalizedMessage = {
        ...normalizedMessage,
        id: `msg_${randomUUID()}`,
      };
      changed = true;
    }

    if (!Array.isArray(message.content)) {
      return normalizedMessage;
    }

    let contentChanged = false;
    const content = message.content.map((itemContent) => {
      const outputText = asRecord(itemContent);
      if (outputText?.type !== "output_text" || outputText.annotations !== undefined) {
        return itemContent;
      }

      contentChanged = true;
      return { ...outputText, annotations: [] };
    });

    if (!contentChanged) {
      return normalizedMessage;
    }

    changed = true;
    return { ...normalizedMessage, content };
  });

  return changed ? { ...response, output } : undefined;
}

function isEventStream(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("event-stream") === true;
}

async function parseJsonObject(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    return asRecord(JSON.parse(await response.clone().text()));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
