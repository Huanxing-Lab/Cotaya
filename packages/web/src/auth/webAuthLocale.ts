type WebAuthLocale = "zh-CN" | "en-US";

interface WebAuthPageCopy {
  brand: string;
  loginTitle: string;
  loginDescription: string;
  loginAction: string;
  callbackTitle: string;
  callbackDescription: string;
  callbackErrorTitle: string;
  callbackErrorDescription: string;
  retryAction: string;
  waitingTitle: string;
  waitingDescription: string;
  signedInAs: string;
  logoutAction: string;
  /** OpenAI 设备码登录面板（Web 端固定设备码流程，spec openai-oauth-provider §2.1）。 */
  openAIDeviceTitle: string;
  openAIDeviceDescription: string;
  openAIDeviceCodeLabel: string;
  openAIDeviceOpenInputPage: string;
  openAIDeviceWaiting: string;
  openAIDeviceSuccessTitle: string;
  openAIDeviceSuccessDescription: string;
  openAIDeviceExpired: string;
  openAIDeviceFailedTitle: string;
  cancelAction: string;
  continueAction: string;
}

const WEB_AUTH_COPY = {
  "zh-CN": {
    brand: "Cotaya",
    loginTitle: "登录后继续使用 Web 远程控制",
    loginDescription: "使用与桌面端一致的 Z.AI 账号身份访问当前远控入口。",
    loginAction: "用 Z.AI 登录",
    callbackTitle: "正在完成登录",
    callbackDescription: "请稍候，正在校验账号身份。",
    callbackErrorTitle: "登录失败",
    callbackErrorDescription: "授权流程未完成，请重新登录。",
    retryAction: "重新登录",
    waitingTitle: "已登录",
    waitingDescription: "设备列表能力即将接入，当前账号暂未选择远控目标。",
    signedInAs: "当前账号",
    logoutAction: "断开连接",
    openAIDeviceTitle: "登录 OpenAI",
    openAIDeviceDescription: "在 OpenAI 授权页输入以下代码完成登录，本页会自动继续。",
    openAIDeviceCodeLabel: "一次性登录码",
    openAIDeviceOpenInputPage: "打开 OpenAI 授权页",
    openAIDeviceWaiting: "等待授权完成…",
    openAIDeviceSuccessTitle: "已登录 OpenAI",
    openAIDeviceSuccessDescription: "已使用当前 OpenAI 账号完成登录。",
    openAIDeviceExpired: "登录码已过期，请重新发起登录。",
    openAIDeviceFailedTitle: "OpenAI 登录失败",
    cancelAction: "取消",
    continueAction: "继续",
  },
  "en-US": {
    brand: "Cotaya",
    loginTitle: "Sign In To Continue",
    loginDescription: "Use the same Z.AI account identity as desktop for Web remote control.",
    loginAction: "Sign in with Z.AI",
    callbackTitle: "Finishing Sign-In",
    callbackDescription: "Verifying your account identity.",
    callbackErrorTitle: "Sign-In Failed",
    callbackErrorDescription: "The authorization flow did not complete. Sign in again.",
    retryAction: "Sign In Again",
    waitingTitle: "Signed In",
    waitingDescription:
      "Device selection is coming next. No remote target is selected for this account yet.",
    signedInAs: "Signed in as",
    logoutAction: "Disconnect",
    openAIDeviceTitle: "Sign in with OpenAI",
    openAIDeviceDescription:
      "Enter the code below on the OpenAI authorization page. This page will continue automatically.",
    openAIDeviceCodeLabel: "One-time sign-in code",
    openAIDeviceOpenInputPage: "Open OpenAI authorization page",
    openAIDeviceWaiting: "Waiting for authorization…",
    openAIDeviceSuccessTitle: "Signed in with OpenAI",
    openAIDeviceSuccessDescription: "You are signed in with your OpenAI account.",
    openAIDeviceExpired: "The sign-in code has expired. Start again.",
    openAIDeviceFailedTitle: "OpenAI Sign-In Failed",
    cancelAction: "Cancel",
    continueAction: "Continue",
  },
} satisfies Record<WebAuthLocale, WebAuthPageCopy>;

function resolveWebAuthLocale(language?: string): WebAuthLocale {
  const candidate =
    language ??
    document.documentElement.lang ??
    navigator.language ??
    navigator.languages?.[0] ??
    "";

  return candidate.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function getWebAuthCopy(locale: WebAuthLocale = resolveWebAuthLocale()): WebAuthPageCopy {
  return WEB_AUTH_COPY[locale];
}
