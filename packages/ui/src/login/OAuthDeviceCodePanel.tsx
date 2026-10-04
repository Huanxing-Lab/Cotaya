/**
 * OAuthDeviceCodePanel —— OpenAI 设备码 fallback 展示面板
 *
 * 1455 loopback 端口被占时，host 会自动降级设备码流程：浏览器打开的是输码页，
 * 用户需要把面板上的一次性 user_code 输入到该页面完成授权（spec
 * openai-oauth-provider §2.2）。本面板只负责展示等宽码、复制与重新打开输码页，
 * 登录完成态仍由 Root 层 pollPendingOAuth 轮询收敛，不在此组件内自建状态。
 */
import { useEffect, useRef, useState } from "react";
import type { OAuthDeviceCodeStartInfo } from "@zcode/shared";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

export function OAuthDeviceCodePanel({ deviceCode }: { deviceCode: OAuthDeviceCodeStartInfo }) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [copied, setCopied] = useState(false);
  const resetCopiedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetCopiedTimerRef.current !== null) {
        window.clearTimeout(resetCopiedTimerRef.current);
      }
    };
  }, []);

  const copyUserCode = () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      logger.warn("[OAuthDeviceCodePanel] 剪贴板不可用，无法复制设备码");
      return;
    }
    void navigator.clipboard.writeText(deviceCode.userCode).then(
      () => {
        setCopied(true);
        if (resetCopiedTimerRef.current !== null) {
          window.clearTimeout(resetCopiedTimerRef.current);
        }
        resetCopiedTimerRef.current = window.setTimeout(() => {
          setCopied(false);
        }, 2_000);
      },
      (error: unknown) => {
        logger.warn("[OAuthDeviceCodePanel] 复制设备码失败", { error });
      },
    );
  };

  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface p-3">
      <div className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "login.oauth.deviceCode.title" })}
      </div>
      <div className="text-ui-base/relaxed text-foreground-subtle">
        {intl.formatMessage({ id: "login.oauth.deviceCode.description" })}
      </div>
      {/* 等宽展示 + 逐字间隔，用户抄写/核对一次性码时不易串位；只读展示，不提供输入。 */}
      <div className="flex items-center justify-center gap-1 rounded-md border border-border bg-background px-3 py-2 select-all">
        <span className="font-mono text-ui-lg font-semibold tracking-[0.35em] text-foreground">
          {deviceCode.userCode}
        </span>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-9 flex-1 text-ui-base"
          onClick={copyUserCode}
        >
          {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
          {intl.formatMessage({
            id: copied ? "login.oauth.deviceCode.copied" : "login.oauth.deviceCode.copy",
          })}
        </Button>
        {/* 授权页可能被弹窗拦截或被用户关闭，这里保留再次打开输码页的入口。 */}
        <Button
          type="button"
          variant="outline"
          className="h-9 flex-1 text-ui-base"
          onClick={() => {
            platform.openExternal(deviceCode.inputPageUrl);
          }}
        >
          <ExternalLinkIcon className="size-4" />
          {intl.formatMessage({ id: "login.oauth.deviceCode.openAuthorizationPage" })}
        </Button>
      </div>
    </div>
  );
}
