import type { ProviderSettingsView } from "@zcode/services";
import { type ZCodeProviderAccountAccess, zcodeProviderAccountAccessSchema } from "@zcode/shared";

/**
 * z.ai 域（zhipu-account）的 Registry Access。
 * chatgpt-account（openai 域）没有 planKind/套餐分层语义，不进入 z.ai 域套餐与
 * 权益查询链路（spec openai-oauth-provider §2.7：openai 以本地 token 有效性为
 * entitled，无 zcode 后端套餐校验），这里在 UI 边界统一收窄，避免下游逐点判联合。
 */
export type ZhipuProviderAccountAccess = Extract<
  ZCodeProviderAccountAccess,
  { type: "zhipu-account" }
>;

interface EntitledAccountProviderAccess {
  readonly providerId: string;
  readonly access: ZhipuProviderAccountAccess;
  readonly label?: string;
}

export function resolveEntitledAccountProviderAccess(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): EntitledAccountProviderAccess | null {
  const provider = view?.providers.find((entry) => entry.providerId === providerId);
  if (provider?.effectiveConfig.access?.type !== "zhipu-account") {
    return null;
  }

  // Registry Access 是静态 accountType/mode 约束，动态 planKind 与 Team scope
  // 只能由账号服务在请求期解析。旧 Schema 会把所有真实 Registry Provider 误判为空。
  const parsed = zcodeProviderAccountAccessSchema.safeParse(provider.effectiveConfig.access);
  // 入参已按 type==="zhipu-account" 门禁；此处判断只为把 schema 的联合返回值
  // 收窄回 z.ai 域成员，语义上不可达。
  if (!parsed.success || parsed.data.type !== "zhipu-account" || parsed.data.entitled !== true)
    return null;
  const label = provider.providerName?.trim();
  return {
    providerId,
    access: parsed.data,
    ...(label ? { label } : {}),
  };
}

export function resolveEntitledAccountProviderAccessFingerprint(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): string {
  const access = resolveEntitledAccountProviderAccess(view, providerId);
  return access ? JSON.stringify([view?.revision, access.providerId, access.access]) : "";
}

/**
 * 套餐只读查询不等于执行模型。pending/未选中的账号仍需展示权益，不能要求 current。
 * 本函数只给余额/订阅查询使用，不得用于模型请求或 ModelSelection completion。
 */
export function resolveAccountProviderInspectionAccess(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): EntitledAccountProviderAccess | null {
  const provider = view?.providers.find((entry) => entry.providerId === providerId);
  if (!provider) return null;
  // 明确无 Start 权益仍需只读查询过期原因；执行权限仍由 entitled 门禁控制。
  if (
    provider.accountState?.availability === "unavailable" &&
    !(
      provider.effectiveConfig.access?.type === "zhipu-account" &&
      provider.effectiveConfig.access.mode === "start-plan" &&
      provider.accountState.unavailableReason === "not-entitled"
    )
  )
    return null;
  const parsed = zcodeProviderAccountAccessSchema.safeParse(provider.effectiveConfig.access);
  // chatgpt-account（openai 域）无套餐可查：只读套餐访问只描述 z.ai 域，
  // openai 的可用性走 provider accountState/执行投影，不经此函数。
  if (!parsed.success || parsed.data.type !== "zhipu-account") return null;
  if (parsed.data.mode === "off-peak") return null;
  if (!provider.accountState && parsed.data.entitled !== true) return null;
  return { providerId, access: parsed.data };
}
