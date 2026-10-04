// 规格 openai-oauth-provider §2.2/2.4：OpenAI adapter 协议状态机单测。
// 覆盖：PKCE authorize URL、loopback 换 token 表单与必填字段校验、id_token 解析、
// 设备码 403/404/410/2xx 状态语义、refresh 轮换与失效码、loopback server 行为、
// 请求鉴权 refresher 的 60s 窗口与 single-flight。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import type { ApiClient, ApiRequestInit } from "@zcode/shared";
import { ApiError } from "@zcode/shared";
import {
  OpenAIProviderAdapter,
  parseOpenAIIdTokenProfile,
} from "../src/oauth/providers/openaiProviderAdapter.js";
import { startOpenAILoopbackCallbackServer } from "../src/oauth/providers/openaiLoopbackCallbackServer.js";
import { createOpenAIProviderRuntimeConfig } from "../src/oauth/providers/openaiProviderConfig.js";
import { createOpenAIRequestAuthRefresher } from "../src/oauth/openaiRequestAuthRefresher.js";

/** 判定 loopback 启动失败是否为端口占用：生产路径对所有 listen 错误统一降级设备码
 *（见 oauthService.startOpenAIOAuth 注释），该判定只有测试断言需要，留在测试文件内。 */
function isLoopbackPortInUseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EADDRINUSE"
  );
}

interface ScriptedRoute {
  pathname: string;
  handler: (init?: ApiRequestInit & { body?: string }) => Response | Promise<Response>;
}

/** 按路径分发的假 ApiClient：记录请求形态并返回脚本化 Response。 */
function createScriptedApiClient(routes: ScriptedRoute[]): ApiClient & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    async request(input: string | URL, init?: ApiRequestInit) {
      const url = new URL(input.toString());
      const headers = init?.headers;
      const contentType =
        headers instanceof Headers
          ? headers.get("content-type")
          : headers && typeof headers === "object" && "Content-Type" in headers
            ? String((headers as Record<string, string>)["Content-Type"])
            : undefined;
      requests.push({
        method: init?.method ?? "GET",
        pathname: url.pathname,
        contentType,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      const route = routes.find((candidate) => candidate.pathname === url.pathname);
      if (!route) {
        return new Response(JSON.stringify({ error: `no route for ${url.pathname}` }), {
          status: 404,
        });
      }
      return route.handler(init);
    },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function makeIdToken(payload: Record<string, unknown>): string {
  return `${base64Url('{"alg":"RS256"}')}.${base64Url(JSON.stringify(payload))}.sig`;
}

const DEFAULT_TOKEN_PAYLOAD = {
  access_token: "at-1",
  refresh_token: "rt-1",
  id_token: makeIdToken({
    sub: "user-sub",
    email: "dev@example.com",
    chatgpt_account_id: "acct-1",
  }),
  expires_in: 1800,
};

function createAdapter(routes: ScriptedRoute[], now: () => number = () => 1_000_000) {
  const apiClient = createScriptedApiClient(routes);
  const config = createOpenAIProviderRuntimeConfig({});
  const adapter = new OpenAIProviderAdapter(config, apiClient);
  const context = {
    providerId: adapter.providerId,
    state: "state-1",
    redirectUri: adapter.redirectUri,
    now,
  };
  return { adapter, apiClient, context, config };
}

test("buildAuthorizeUrl 携带 PKCE S256 与固定 scope/redirect_uri", async () => {
  const { adapter, apiClient, context } = createAdapter([
    { pathname: "/oauth/token", handler: () => jsonResponse(DEFAULT_TOKEN_PAYLOAD) },
  ]);
  const url = new URL(adapter.buildAuthorizeUrl(context));
  assert.equal(url.origin + url.pathname, "https://auth.openai.com/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "openid profile email offline_access");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "state-1");
  const challenge = url.searchParams.get("code_challenge")!;

  // challenge 必须能由 exchangeToken 实际使用的 verifier 推导（S256）。
  await adapter.exchangeToken({ code: "code-1", state: "state-1" }, context);
  const tokenRequest = apiClient.requests.find(
    (request) => (request as { pathname: string }).pathname === "/oauth/token",
  ) as { body?: string };
  const form = new URLSearchParams(tokenRequest.body!);
  const verifier = form.get("code_verifier")!;
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge);
});

test("exchangeToken 按表单交换并归一化 expiresAt，user_info 来自 id_token", async () => {
  const { adapter, apiClient, context } = createAdapter([
    { pathname: "/oauth/token", handler: () => jsonResponse(DEFAULT_TOKEN_PAYLOAD) },
  ]);
  adapter.buildAuthorizeUrl(context);
  const tokenSet = await adapter.exchangeToken({ code: "code-1", state: "state-1" }, context);
  assert.equal(tokenSet.accessToken, "at-1");
  assert.equal(tokenSet.refreshToken, "rt-1");
  assert.equal(tokenSet.expiresAt, 1_000_000 + 1800 * 1000);

  const tokenRequest = apiClient.requests.at(-1) as {
    contentType?: string;
    body?: string;
  };
  assert.equal(tokenRequest.contentType, "application/x-www-form-urlencoded");
  const form = new URLSearchParams(tokenRequest.body!);
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "code-1");
  assert.equal(form.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(form.get("code_verifier")?.length >= 43, true);

  const profile = await adapter.fetchUserInfo(tokenSet, context);
  assert.equal(profile.id, "acct-1");
  assert.equal(profile.username, "dev@example.com");
});

test("exchangeToken 缺 refresh_token 或 id_token 视为登录失败", async () => {
  const { adapter, context } = createAdapter([
    {
      pathname: "/oauth/token",
      handler: () => jsonResponse({ ...DEFAULT_TOKEN_PAYLOAD, refresh_token: null }),
    },
  ]);
  adapter.buildAuthorizeUrl(context);
  await assert.rejects(
    adapter.exchangeToken({ code: "code-1", state: "state-1" }, context),
    /缺少 refresh_token/,
  );

  const second = createAdapter([
    {
      pathname: "/oauth/token",
      handler: () => jsonResponse({ ...DEFAULT_TOKEN_PAYLOAD, id_token: null }),
    },
  ]);
  second.adapter.buildAuthorizeUrl(second.context);
  await assert.rejects(
    second.adapter.exchangeToken({ code: "code-1", state: "state-1" }, second.context),
    /缺少 id_token/,
  );
});

test("expires_in 缺省按 3600s", async () => {
  const { adapter, context } = createAdapter([
    {
      pathname: "/oauth/token",
      handler: () => {
        const { expires_in: _omit, ...payload } = DEFAULT_TOKEN_PAYLOAD;
        return jsonResponse(payload);
      },
    },
  ]);
  adapter.buildAuthorizeUrl(context);
  const tokenSet = await adapter.exchangeToken({ code: "c", state: "state-1" }, context);
  assert.equal(tokenSet.expiresAt, 1_000_000 + 3600 * 1000);
});

test("id_token 解析：顶层与命名空间 chatgpt_account_id、email 缺省回退 sub", () => {
  const top = parseOpenAIIdTokenProfile(
    makeIdToken({ sub: "s1", email: "a@b.c", chatgpt_account_id: "acct-top" }),
  )!;
  assert.equal(top.id, "acct-top");
  assert.equal(top.username, "a@b.c");

  const namespaced = parseOpenAIIdTokenProfile(
    makeIdToken({
      sub: "s2",
      email: "x@y.z",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-ns" },
    }),
  )!;
  assert.equal(namespaced.id, "acct-ns");

  const noEmail = parseOpenAIIdTokenProfile(makeIdToken({ sub: "s3" }))!;
  assert.equal(noEmail.id, "s3");
  assert.equal(noEmail.username, "s3");

  assert.equal(parseOpenAIIdTokenProfile("not-a-jwt"), null);
});

test("设备码：usercode 请求体仅 client_id；403/404 继续、410 过期、2xx 拿服务端 verifier", async () => {
  const { adapter, apiClient, context } = createAdapter([
    {
      pathname: "/api/accounts/deviceauth/usercode",
      handler: () => jsonResponse({ device_auth_id: "da-1", user_code: "ABCD-EFGH", interval: 1 }),
    },
    {
      pathname: "/api/accounts/deviceauth/token",
      handler: (init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, string>;
        assert.deepEqual(body, { device_auth_id: "da-1", user_code: "ABCD-EFGH" });
        return jsonResponse({
          authorization_code: "auth-code-1",
          code_verifier: "server-verifier",
        });
      },
    },
    { pathname: "/oauth/token", handler: () => jsonResponse(DEFAULT_TOKEN_PAYLOAD) },
  ]);

  const challenge = await adapter.requestDeviceCode(context);
  assert.equal(challenge.deviceAuthId, "da-1");
  assert.equal(challenge.userCode, "ABCD-EFGH");
  assert.equal(challenge.inputPageUrl, "https://auth.openai.com/codex/device");
  assert.equal(challenge.pollIntervalMs, 1000);

  const usercodeRequest = apiClient.requests[0] as { body?: string };
  assert.deepEqual(JSON.parse(usercodeRequest.body!), {
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
  });

  const ready = await adapter.pollDeviceCodeToken(challenge);
  assert.deepEqual(ready, {
    status: "ready",
    authorizationCode: "auth-code-1",
    codeVerifier: "server-verifier",
  });

  const tokenSet = await adapter.exchangeDeviceCodeToken(
    { authorizationCode: ready.authorizationCode, codeVerifier: ready.codeVerifier },
    context,
  );
  assert.equal(tokenSet.accessToken, "at-1");
  const tokenRequest = apiClient.requests.at(-1) as { body?: string };
  const form = new URLSearchParams(tokenRequest.body!);
  assert.equal(form.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
  assert.equal(form.get("code_verifier"), "server-verifier");
});

test("设备码轮询状态语义：403/404 pending、410 expired、其他 4xx 抛错", async () => {
  for (const status of [403, 404]) {
    const { adapter } = createAdapter([
      { pathname: "/api/accounts/deviceauth/token", handler: () => jsonResponse({}, status) },
    ]);
    const result = await adapter.pollDeviceCodeToken({
      deviceAuthId: "da",
      userCode: "U",
      inputPageUrl: "https://auth.openai.com/codex/device",
      pollIntervalMs: 1000,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(result.status, "pending", `status ${status}`);
  }
  const expired = createAdapter([
    { pathname: "/api/accounts/deviceauth/token", handler: () => jsonResponse({}, 410) },
  ]);
  const expiredResult = await expired.adapter.pollDeviceCodeToken({
    deviceAuthId: "da",
    userCode: "U",
    inputPageUrl: "https://auth.openai.com/codex/device",
    pollIntervalMs: 1000,
    expiresAt: Date.now() + 60_000,
  });
  assert.equal(expiredResult.status, "expired");

  const bad = createAdapter([
    { pathname: "/api/accounts/deviceauth/token", handler: () => jsonResponse({}, 400) },
  ]);
  await assert.rejects(
    bad.adapter.pollDeviceCodeToken({
      deviceAuthId: "da",
      userCode: "U",
      inputPageUrl: "https://auth.openai.com/codex/device",
      pollIntervalMs: 1000,
      expiresAt: Date.now() + 60_000,
    }),
  );
});

test("refresh：轮换持久化语义（新值替换/缺省保留）、401 与失效码判定", async () => {
  const rotated = createAdapter([
    {
      pathname: "/oauth/token",
      handler: () =>
        jsonResponse({
          access_token: "at-2",
          refresh_token: "rt-2",
          expires_in: 600,
        }),
    },
  ]);
  const refreshed = await rotated.adapter.refreshToken(
    { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1 },
    rotated.context,
  );
  assert.equal(refreshed.refreshToken, "rt-2");
  assert.equal(refreshed.expiresAt, 1_000_000 + 600 * 1000);
  const form = new URLSearchParams((rotated.apiClient.requests[0] as { body?: string }).body!);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "rt-1");
  assert.equal(form.get("scope"), "openid profile email");

  const noRotation = createAdapter([
    { pathname: "/oauth/token", handler: () => jsonResponse({ access_token: "at-3" }) },
  ]);
  const kept = await noRotation.adapter.refreshToken(
    { accessToken: "at-1", refreshToken: "rt-keep", expiresAt: 1 },
    noRotation.context,
  );
  assert.equal(kept.refreshToken, "rt-keep");

  const unauthorized = createAdapter([
    {
      pathname: "/oauth/token",
      handler: () => jsonResponse({ error: "invalid_grant" }, 401),
    },
  ]);
  await assert.rejects(
    unauthorized.adapter.refreshToken(
      { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1 },
      unauthorized.context,
    ),
    (error: unknown) => error instanceof Error && error.name === "OpenAIRefreshTokenInvalidError",
  );

  const reused = createAdapter([
    {
      pathname: "/oauth/token",
      handler: () => jsonResponse({ error: "refresh_token_reused" }, 400),
    },
  ]);
  await assert.rejects(
    reused.adapter.refreshToken(
      { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1 },
      reused.context,
    ),
    (error: unknown) => error instanceof Error && error.name === "OpenAIRefreshTokenInvalidError",
  );

  const serverError = createAdapter([
    { pathname: "/oauth/token", handler: () => jsonResponse({}, 503) },
  ]);
  await assert.rejects(
    serverError.adapter.refreshToken(
      { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1 },
      serverError.context,
    ),
    (error: unknown) => error instanceof ApiError && error.status === 503,
  );
});

test("loopback server：只应答回调路径、收 code 即停、端口占用可识别", async () => {
  const callbacks: string[] = [];
  const server = await startOpenAILoopbackCallbackServer({
    port: 0,
    onCallback: (url) => callbacks.push(url),
  });
  assert.ok(server.port > 0);

  const other = await fetch(`http://127.0.0.1:${server.port}/other`);
  assert.equal(other.status, 404);

  const callback = await fetch(`http://127.0.0.1:${server.port}/auth/callback?code=abc&state=st`);
  assert.equal(callback.status, 200);
  const body = await callback.text();
  assert.match(body, /OpenAI 登录成功/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(callbacks, [`http://localhost:${server.port}/auth/callback?code=abc&state=st`]);
  // 收到回调后 server 已停止监听。
  await assert.rejects(fetch(`http://127.0.0.1:${server.port}/auth/callback?code=2`));
  server.stop();

  // 用户在授权页点取消：302 回调带 error=access_denied（无 code）时，浏览器侧必须回
  // 中性“授权未完成”页（不能显示“登录成功”），onCallback 仍原样上报给应用侧校验。
  {
    const cancelled: string[] = [];
    const cancelServer = await startOpenAILoopbackCallbackServer({
      port: 0,
      onCallback: (url) => cancelled.push(url),
    });
    const cancelledResponse = await fetch(
      `http://127.0.0.1:${cancelServer.port}/auth/callback?error=access_denied`,
    );
    assert.equal(cancelledResponse.status, 200);
    const cancelledBody = await cancelledResponse.text();
    assert.match(cancelledBody, /授权未完成/);
    assert.doesNotMatch(cancelledBody, /登录成功/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(cancelled, [
      `http://localhost:${cancelServer.port}/auth/callback?error=access_denied`,
    ]);
    cancelServer.stop();
  }

  // 端口占用：同端口起第二个 server 必须 reject EADDRINUSE（触发设备码 fallback）。
  const holder = http.createServer(() => undefined);
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const holderPort = (holder.address() as { port: number }).port;
  try {
    await assert.rejects(
      startOpenAILoopbackCallbackServer({ port: holderPort, onCallback: () => undefined }),
      (error: unknown) => isLoopbackPortInUseError(error),
    );
  } finally {
    holder.close();
  }
});

test("requestAuthRefresher：60s 窗口主动刷新、single-flight、失效清理回调", async () => {
  let refreshCalls = 0;
  let nowMs = 1_000_000;
  const store = new Map<string, string>();
  const invalidCalls: number[] = [];
  const apiClient: ApiClient = {
    async request(input: string | URL) {
      const url = new URL(input.toString());
      if (url.pathname !== "/oauth/token") {
        return jsonResponse({ error: "no route" }, 404);
      }
      refreshCalls += 1;
      // 慢响应放大并发窗口，验证 single-flight。
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (refreshCalls === 1 && url.searchParams.get("mode") !== "second") {
        return jsonResponse({
          access_token: "at-new",
          refresh_token: "rt-new",
          expires_in: 3600,
        });
      }
      return jsonResponse({ error: "refresh_token_expired" }, 401);
    },
  };
  const refresher = createOpenAIRequestAuthRefresher({
    apiClient,
    env: {},
    now: () => nowMs,
    loadTokenSet: async () => {
      const accessToken = store.get("at") ?? null;
      if (!accessToken) return null;
      return {
        accessToken,
        ...(store.get("rt") ? { refreshToken: store.get("rt")! } : {}),
        ...(store.get("exp") ? { expiresAt: Number(store.get("exp")) } : {}),
      };
    },
    saveTokenSet: async (tokenSet) => {
      store.set("at", tokenSet.accessToken);
      if (tokenSet.refreshToken) store.set("rt", tokenSet.refreshToken);
      if (tokenSet.expiresAt) store.set("exp", String(tokenSet.expiresAt));
    },
    loadChatGPTAccountId: async () => "acct-1",
    onCredentialInvalid: async () => {
      invalidCalls.push(refreshCalls);
    },
  });

  // 无凭据 → null。
  assert.equal(await refresher.resolveRequestAuth(), null);

  // 未到刷新窗口：直接返回当前 token，不打刷新请求。
  store.set("at", "at-1");
  store.set("rt", "rt-1");
  store.set("exp", String(nowMs + 600_000));
  let material = await refresher.resolveRequestAuth();
  assert.equal(material?.apiKey, "at-1");
  assert.deepEqual(material?.headers, { "chatgpt-account-id": "acct-1" });
  assert.equal(refreshCalls, 0);

  // 距过期 <60s：并发解析只触发一次刷新，且返回新 token。
  store.set("exp", String(nowMs + 30_000));
  const [first, second, third] = await Promise.all([
    refresher.resolveRequestAuth(),
    refresher.resolveRequestAuth(),
    refresher.resolveRequestAuth(),
  ]);
  assert.equal(first?.apiKey, "at-new");
  assert.equal(second?.apiKey, "at-new");
  assert.equal(third?.apiKey, "at-new");
  assert.equal(refreshCalls, 1);
  assert.equal(store.get("at"), "at-new");
  assert.equal(store.get("rt"), "rt-new");

  // 刷新返回 401 失效码：返回 null 并回调清理。
  nowMs += 3600_000;
  store.set("exp", String(nowMs - 1));
  assert.equal(await refresher.resolveRequestAuth(), null);
  assert.equal(invalidCalls.length, 1);
});

test("requestAuthRefresher：刷新在途期间凭据被清除时跳过写回，不复活已清凭据", async () => {
  let nowMs = 1_000_000;
  const store = new Map<string, string>();
  const saved: string[] = [];
  let loggedOutDuringRefresh = false;
  const apiClient: ApiClient = {
    async request() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      // 模拟刷新返回前用户登出：磁盘上的 oauth:openai:* 已被清空。
      loggedOutDuringRefresh = true;
      return jsonResponse({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 });
    },
  };
  const refresher = createOpenAIRequestAuthRefresher({
    apiClient,
    env: {},
    now: () => nowMs,
    loadTokenSet: async () => {
      if (loggedOutDuringRefresh) return null;
      const accessToken = store.get("at");
      return accessToken
        ? { accessToken, refreshToken: "rt-1", expiresAt: Number(store.get("exp")) }
        : null;
    },
    saveTokenSet: async (tokenSet) => {
      saved.push(tokenSet.accessToken);
      store.set("at", tokenSet.accessToken);
    },
    loadChatGPTAccountId: async () => "acct-1",
  });
  store.set("at", "at-1");
  store.set("exp", String(nowMs + 30_000));

  const material = await refresher.resolveRequestAuth();
  // 刷新出的 access_token 仍可服务本次请求，但已清除的凭据不得写回（不凭空复活）。
  assert.equal(material?.apiKey, "at-new");
  assert.deepEqual(saved, []);
});
