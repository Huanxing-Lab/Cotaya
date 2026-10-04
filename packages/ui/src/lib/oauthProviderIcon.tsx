import type { OAuthProviderId } from "@zcode/shared";
import { BIGMODEL_PROVIDER_ID, OPENAI_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import { LogInIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import bigModelIcon from "@/assets/provider-icons/logo-bigmodel.svg";
import openAiIcon from "@/assets/provider-icons/model-provider-openai.png";
import zaiIcon from "@/assets/provider-icons/logo-zai.svg";

const OAUTH_PROVIDER_ICON_SRC: Partial<Record<OAuthProviderId, string>> = {
  [BIGMODEL_PROVIDER_ID]: bigModelIcon,
  [ZAI_PROVIDER_ID]: zaiIcon,
  // 复用在案的 OpenAI 官方图标（来源见 model-provider-logo-sources.json "OpenAI" 条目），
  // 不为登录入口另造占位 svg，避免同一品牌出现两套视觉。
  [OPENAI_PROVIDER_ID]: openAiIcon,
};

export function renderOAuthProviderIcon(provider: OAuthProviderId, className?: string) {
  const src = OAUTH_PROVIDER_ICON_SRC[provider];
  if (!src) {
    return <LogInIcon className={cn("shrink-0", className)} />;
  }

  return (
    <img src={src} alt="" aria-hidden="true" className={cn("shrink-0 object-contain", className)} />
  );
}
