import { createServer, type Server } from "node:http";

/** OpenAI loopback 回调 server 句柄：收 code 即关闭，只服务本次登录会话。 */
export interface OpenAILoopbackCallbackServer {
  readonly port: number;
  /** 立即停止监听；幂等。 */
  stop(): void;
}

export interface OpenAILoopbackCallbackServerOptions {
  /** 监听端口；OpenAI 端注册的 redirect_uri 固定 1455，测试可注入其他端口。 */
  port: number;
  /** 收到 /auth/callback?code&state 回调时上报完整 URL（含 query）。 */
  onCallback: (url: string) => void;
  onError?: (error: Error) => void;
}

const CALLBACK_PATH = "/auth/callback";

/**
 * 启动只服务本次登录的 loopback HTTP server（RFC 8252 语义）。
 *
 * - 只监听 127.0.0.1，不暴露到局域网；
 * - 只接受 GET /auth/callback，其余路径 404；
 * - 收到第一个回调后立即停止监听（授权码一次性，之后的请求无意义）；
 * - listen 失败（典型为 EADDRINUSE，端口 1455 被占）通过 reject 返回，
 *   由调用方降级到设备码流程。
 */
export function startOpenAILoopbackCallbackServer(
  options: OpenAILoopbackCallbackServerOptions,
): Promise<OpenAILoopbackCallbackServer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    let boundPort = options.port;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      server.close();
      // keep-alive 连接会阻止 close 完成；Node>=18.2 提供 closeAllConnections。
      (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    };

    const server = createServer((request, response) => {
      const requestUrl = request.url ?? "";
      let pathname = "";
      try {
        pathname = new URL(requestUrl, `http://127.0.0.1:${boundPort}`).pathname;
      } catch {
        pathname = "";
      }

      if (request.method !== "GET" || pathname !== CALLBACK_PATH) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not Found");
        return;
      }

      // 先回浏览器再停 server：授权码一次性，收到即结束监听。
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        Connection: "close",
      });
      response.end(
        '<!doctype html><html><head><meta charset="utf-8"><title>Cotaya</title></head>' +
          '<body style="font-family:system-ui;padding:48px;text-align:center">' +
          "<h2>OpenAI 登录成功</h2><p>请返回 Cotaya 继续使用。</p></body></html>",
      );
      stop();
      try {
        // 回调 URL 与 OpenAI 注册的 redirect_uri 形态一致（localhost + 实际监听端口）。
        options.onCallback(`http://localhost:${boundPort}${requestUrl}`);
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      reject(error);
    });

    server.listen(options.port, "127.0.0.1", () => {
      if (settled) return;
      settled = true;
      const address = server.address();
      boundPort = typeof address === "object" && address ? address.port : options.port;
      resolve({
        port: boundPort,
        stop,
      });
    });
  });
}

/** 判断 loopback 启动失败是否为端口占用（用于触发设备码 fallback）。 */
export function isLoopbackPortInUseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EADDRINUSE"
  );
}
