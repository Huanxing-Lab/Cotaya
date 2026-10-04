import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  OPENAI_DEVICE_AUTH_TOKEN_URL,
  OPENAI_DEVICE_AUTH_USERCODE_URL,
  OPENAI_OAUTH_TOKEN_URL,
} from "@zcode/shared";

/**
 * OpenAI OAuth 端点透传代理（Web 端设备码登录用）。
 *
 * 浏览器无法直连 auth.openai.com（无 CORS 头），Web 端把设备码三条端点
 * （申请 user_code / 轮询兑换 / oauth/token 换 token 与刷新）打到同源
 * `/api/openai-oauth/*`，由本模块转发。约束（spec openai-oauth-provider §2.2）：
 * - 只做透传 + 超时，不存任何状态（不含凭据、不含 pending 会话）；
 * - 上游地址是固定 allowlist（shared 常量），不接受任意 URL，避免变成开放中继；
 * - 上游状态码与响应体原样回传：设备码轮询依赖 403/404（等待）/410（过期），
 *   token 刷新依赖 401/403（失效判定），改写状态码会破坏客户端协议语义。
 */

/** 与服务层 OpenAIProviderAdapter 的 TOKEN_REQUEST_TIMEOUT_MS 对齐。 */
const UPSTREAM_TIMEOUT_MS = 15_000;

/** 三条端点的请求体都是几十字节的 JSON/form，超限直接拒绝，防止被当作反射放大器。 */
const MAX_REQUEST_BODY_BYTES = 8 * 1024;

const PROXY_ROUTE_BASE = "/api/openai-oauth";

const PROXY_ACTIONS = {
  usercode: OPENAI_DEVICE_AUTH_USERCODE_URL,
  "device-token": OPENAI_DEVICE_AUTH_TOKEN_URL,
  token: OPENAI_OAUTH_TOKEN_URL,
} as const;

type OpenAIOAuthProxyAction = keyof typeof PROXY_ACTIONS;

function isOpenAIOAuthProxyAction(value: string): value is OpenAIOAuthProxyAction {
  return value in PROXY_ACTIONS;
}

function isInsideStatusCodeRange(status: number): boolean {
  return status >= 200 && status <= 599;
}

export function registerOpenAIOAuthProxyRoutes(app: Hono): void {
  app.post(`${PROXY_ROUTE_BASE}/:action`, async (c) => {
    const action = c.req.param("action");
    if (!isOpenAIOAuthProxyAction(action)) {
      return c.json({ error: `Unknown OpenAI OAuth proxy action: ${action}` }, 404);
    }

    const body = await c.req.text();
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
      return c.json({ error: "Request body too large" }, 413);
    }

    let upstream: Response;
    try {
      upstream = await fetch(PROXY_ACTIONS[action], {
        method: "POST",
        headers: {
          // 设备码端点是 JSON、token 端点是 form；内容类型由客户端按端点自带，这里只透传。
          "Content-Type": c.req.header("content-type") ?? "application/json",
          Accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: `OpenAI OAuth upstream request failed: ${message}` }, 502);
    }

    const responseBody = await upstream.text().catch(() => "");
    // fetch 的 status 是 number，Hono 的 c.body 要字面量联合；HTTP 状态码本就落在该区间。
    const status = (
      isInsideStatusCodeRange(upstream.status) ? upstream.status : 502
    ) as ContentfulStatusCode;
    return c.body(responseBody, status, {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-store",
    });
  });
}
