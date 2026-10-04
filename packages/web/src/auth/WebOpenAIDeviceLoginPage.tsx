import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@zcode/ui";
import type { OAuthDeviceCodeStartInfo, UserInfo } from "@zcode/shared";
import type { WebAuthService } from "./webAuthService.js";
import { getWebAuthCopy } from "./webAuthLocale.js";

/**
 * OpenAI 设备码登录面板：页内展示 user_code + 打开输码页 + 按 interval 轮询。
 *
 * Web 端浏览器无法监听 localhost loopback 回调（spec openai-oauth-provider §2.1），
 * openai 登录固定走设备码：不发生页面跳转，全程在本面板内完成并写同一套凭据 key。
 */

type WebOpenAIDeviceLoginPhase =
  | { kind: "starting" }
  | { kind: "waiting"; info: OAuthDeviceCodeStartInfo }
  | { kind: "success"; userInfo: UserInfo }
  | { kind: "error"; message: string };

interface WebOpenAIDeviceLoginPanelProps {
  authService: Pick<
    WebAuthService,
    | "startOpenAIDeviceCodeLogin"
    | "pollPendingOpenAIDeviceCodeLogin"
    | "cancelOpenAIDeviceCodeLogin"
    | "loadPendingOpenAIDeviceCodeLogin"
  >;
  /** 登录完成后的动作（通常由宿主页面重载以用新身份重新加载）。 */
  onFinished: () => void;
  /** 用户显式取消（关闭面板）。 */
  onCancel: () => void;
}

export function WebOpenAIDeviceLoginPanel({
  authService,
  onFinished,
  onCancel,
}: WebOpenAIDeviceLoginPanelProps) {
  const copy = getWebAuthCopy();
  const [phase, setPhase] = useState<WebOpenAIDeviceLoginPhase>({ kind: "starting" });
  /** 重试计数：递增即重跑整个 begin→poll 链。 */
  const [attempt, setAttempt] = useState(0);
  const timerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    const clearTimer = () => {
      if (timerRef.current !== null) {
        globalThis.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    const schedule = (intervalMs: number) => {
      clearTimer();
      timerRef.current = globalThis.setTimeout(() => void poll(), intervalMs);
    };

    const begin = async () => {
      try {
        // 页面刷新后 sessionStorage 里的 pending 仍有效：直接续着轮询，
        // 重新申请会让旧 user_code 作废、用户需要重新输码。
        const resumed = authService.loadPendingOpenAIDeviceCodeLogin();
        if (resumed) {
          if (resumed.expiresAt > Date.now()) {
            setPhase({ kind: "waiting", info: resumed });
            schedule(resumed.pollIntervalMs);
            return;
          }
          authService.cancelOpenAIDeviceCodeLogin();
        }
        const started = await authService.startOpenAIDeviceCodeLogin();
        if (cancelledRef.current) return;
        setPhase({ kind: "waiting", info: started });
        schedule(started.pollIntervalMs);
      } catch (error) {
        if (cancelledRef.current) return;
        setPhase({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const poll = async () => {
      try {
        const result = await authService.pollPendingOpenAIDeviceCodeLogin();
        if (cancelledRef.current) return;
        if (result.status === "pending") {
          const pending = authService.loadPendingOpenAIDeviceCodeLogin();
          schedule(pending?.pollIntervalMs ?? 5_000);
          return;
        }
        if (result.status === "authenticated") {
          setPhase({ kind: "success", userInfo: result.userInfo });
          return;
        }
        setPhase({ kind: "error", message: copy.openAIDeviceExpired });
      } catch (error) {
        if (cancelledRef.current) return;
        setPhase({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void begin();
    return () => {
      cancelledRef.current = true;
      clearTimer();
    };
    // copy 随语言固定；attempt 驱动重试。eslint exhaustive-deps 可能抱怨 copy，这里语义上只需 attempt。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, authService]);

  const handleRetry = useCallback(() => {
    setPhase({ kind: "starting" });
    setAttempt((current) => current + 1);
  }, []);

  const handleCancel = useCallback(() => {
    authService.cancelOpenAIDeviceCodeLogin();
    onCancel();
  }, [authService, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-label={copy.openAIDeviceTitle}
    >
      <section className="w-full max-w-sm rounded-lg border border-card-border bg-card p-5 shadow-sm">
        {phase.kind === "starting" && (
          <>
            <div className="mb-4 size-9 animate-spin rounded-full border-2 border-border border-t-primary" />
            <h1 className="text-ui-lg font-medium text-foreground">{copy.openAIDeviceTitle}</h1>
            <p className="mt-2 text-ui-xs leading-6 text-foreground-subtle">
              {copy.openAIDeviceDescription}
            </p>
          </>
        )}

        {phase.kind === "waiting" && (
          <>
            <h1 className="text-ui-lg font-medium text-foreground">{copy.openAIDeviceTitle}</h1>
            <p className="mt-2 text-ui-xs leading-6 text-foreground-subtle">
              {copy.openAIDeviceDescription}
            </p>
            <div className="mt-4 rounded-lg border border-border bg-surface px-3 py-3 text-center">
              <div className="text-ui-xs text-foreground-subtle">{copy.openAIDeviceCodeLabel}</div>
              {/* user_code 是一次性输码凭据而非秘密，页内明文展示是设备码流程的预期形态。 */}
              <div className="mt-1 select-all font-mono text-ui-xl font-semibold tracking-widest text-foreground">
                {phase.info.userCode}
              </div>
            </div>
            <Button
              type="button"
              size="lg"
              className="mt-4 w-full"
              onClick={() => {
                window.open(phase.info.inputPageUrl, "_blank", "noopener,noreferrer");
              }}
            >
              {copy.openAIDeviceOpenInputPage}
            </Button>
            <div className="mt-4 flex items-center gap-2 text-ui-xs text-foreground-subtle">
              <span className="size-3 animate-spin rounded-full border-2 border-border border-t-primary" />
              {copy.openAIDeviceWaiting}
            </div>
            <Button type="button" variant="secondary" size="lg" className="mt-3 w-full" onClick={handleCancel}>
              {copy.cancelAction}
            </Button>
          </>
        )}

        {phase.kind === "success" && (
          <>
            <h1 className="text-ui-lg font-medium text-foreground">{copy.openAIDeviceSuccessTitle}</h1>
            <p className="mt-2 text-ui-xs leading-6 text-foreground-subtle">
              {phase.userInfo.displayName || phase.userInfo.username}
            </p>
            <Button type="button" size="lg" className="mt-5 w-full" onClick={onFinished}>
              {copy.continueAction}
            </Button>
          </>
        )}

        {phase.kind === "error" && (
          <>
            <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-destructive text-ui-xs font-medium text-destructive-foreground">
              !
            </div>
            <h1 className="text-ui-lg font-medium text-foreground">{copy.openAIDeviceFailedTitle}</h1>
            <p className="mt-3 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs leading-5 text-foreground-subtle">
              {phase.message}
            </p>
            <div className="mt-5 flex gap-2">
              <Button type="button" variant="secondary" size="lg" className="flex-1" onClick={handleCancel}>
                {copy.cancelAction}
              </Button>
              <Button type="button" size="lg" className="flex-1" onClick={handleRetry}>
                {copy.retryAction}
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/**
 * 把「OpenAI 设备码登录」接入任意带 onLogin 回调的页面：
 * children 以函数接收 startOpenAILogin，openai 以外的 provider 仍走原有跳转式登录。
 * 挂载时若 sessionStorage 里存在未过期的 pending 设备码（页面刷新场景），面板自动恢复。
 */
export function WebOpenAIDeviceLoginGate({
  authService,
  onFinished,
  children,
}: {
  authService: Pick<
    WebAuthService,
    | "startOpenAIDeviceCodeLogin"
    | "pollPendingOpenAIDeviceCodeLogin"
    | "cancelOpenAIDeviceCodeLogin"
    | "loadPendingOpenAIDeviceCodeLogin"
  >;
  onFinished: () => void;
  children: (startOpenAILogin: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    const pending = authService.loadPendingOpenAIDeviceCodeLogin();
    return Boolean(pending && pending.expiresAt > Date.now());
  });
  const startOpenAILogin = useCallback(() => setOpen(true), []);

  return (
    <>
      {children(startOpenAILogin)}
      {open ? (
        <WebOpenAIDeviceLoginPanel
          authService={authService}
          onFinished={onFinished}
          onCancel={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
