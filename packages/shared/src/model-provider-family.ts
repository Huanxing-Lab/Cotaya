import {
  BIGMODEL_PROVIDER_ID,
  type OAuthProviderId,
  OPENAI_PROVIDER_ID,
  ZAI_PROVIDER_ID,
} from "./oauth.js";
import { BUILTIN_MODEL_PROVIDER_IDS, type BuiltinModelProviderId } from "./model-provider-types.js";
import { ZCODE_ENV } from "./env.js";
import { buildBigModelCodingPlanTeamManageUrl } from "./zcodeEndpoint.js";

export type ModelProviderFamilyId = "zai" | "bigmodel" | "openai";
export type ProviderFamilyDomain = ModelProviderFamilyId;

/**
 * z.ai 身份域（zai ↔ bigmodel 互删、zhipu-account 套餐语义）的 family id。
 * openai 是独立身份域：无 z.ai 套餐分层与用量统计，凡把 family 传入
 * zhipu-account 身份/企业定价/团队套餐等 z.ai 域专属结构前必须先经守卫收窄。
 */
export type ZhipuAccountFamilyId = "zai" | "bigmodel";

export function isZhipuAccountProviderFamily(
  family: ModelProviderFamilyId | string | null | undefined,
): family is ZhipuAccountFamilyId {
  return family === "zai" || family === "bigmodel";
}

export interface ModelProviderFamilySpec {
  id: ModelProviderFamilyId;
  label: string;
  rootDomain: string;
  oauthProviderId: typeof ZAI_PROVIDER_ID | typeof BIGMODEL_PROVIDER_ID | typeof OPENAI_PROVIDER_ID;
  startPlanProviderId:
    | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.openaiPlan;
  individualCodingPlanProviderId:
    | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.openaiPlan;
  teamCodingPlanProviderId:
    | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.openaiPlan;
  teamCodingPlanManageUrl: string;
}

export const MODEL_PROVIDER_FAMILY_SPECS = [
  {
    id: "zai",
    label: "Z.ai",
    rootDomain: "z.ai",
    oauthProviderId: ZAI_PROVIDER_ID,
    startPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
    individualCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    teamCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
    teamCodingPlanManageUrl: "https://z.ai/manage-apikey/subscription",
  },
  {
    id: "bigmodel",
    label: "BigModel",
    rootDomain: "bigmodel.cn",
    oauthProviderId: BIGMODEL_PROVIDER_ID,
    startPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    individualCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    teamCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
    teamCodingPlanManageUrl: buildBigModelCodingPlanTeamManageUrl({ ZCODE_ENV }),
  },
  {
    // OpenAI 是独立身份域（与 z.ai 域互不删凭据），无 start/individual/team 套餐分层，
    // 三个 plan provider 字段统一指向 account:openai-plan：UI 连接选择逻辑按
    // selection kind 读对应字段，同值可让现有选择/投影代码无需 openai 特判。
    // teamCodingPlanManageUrl 仅为满足接口形状，OpenAI 无团队管理页，该值不会被
    // 使用（openai 不进团队套餐商品投影）。
    id: "openai",
    label: "OpenAI",
    rootDomain: "chatgpt.com",
    oauthProviderId: OPENAI_PROVIDER_ID,
    startPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.openaiPlan,
    individualCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.openaiPlan,
    teamCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.openaiPlan,
    teamCodingPlanManageUrl: "https://chatgpt.com/",
  },
] as const satisfies readonly ModelProviderFamilySpec[];

const MODEL_PROVIDER_FAMILY_SPEC_BY_ID = new Map<ModelProviderFamilyId, ModelProviderFamilySpec>(
  MODEL_PROVIDER_FAMILY_SPECS.map((spec) => [spec.id, spec]),
);

/**
 * 按传入 family id 保留字面量窄度的 spec 类型：传入窄 family（如
 * ZhipuAccountFamilyId）时，start/individual/team plan provider id 字段也
 * 随之收窄，避免 z.ai 域专属消费点拿到 openai plan id。
 */
export type ModelProviderFamilySpecFor<F extends ModelProviderFamilyId> = Extract<
  (typeof MODEL_PROVIDER_FAMILY_SPECS)[number],
  { id: F }
>;

const MODEL_PROVIDER_FAMILY_ID_BY_PROVIDER_ID = new Map<
  BuiltinModelProviderId,
  ModelProviderFamilyId
>(
  MODEL_PROVIDER_FAMILY_SPECS.flatMap((spec) =>
    [
      spec.startPlanProviderId,
      spec.individualCodingPlanProviderId,
      spec.teamCodingPlanProviderId,
    ].map((providerId) => [providerId, spec.id] as const),
  ),
);

export function getModelProviderFamilySpec<F extends ModelProviderFamilyId>(
  familyId: F,
): ModelProviderFamilySpecFor<F> {
  return MODEL_PROVIDER_FAMILY_SPEC_BY_ID.get(familyId) as ModelProviderFamilySpecFor<F>;
}

export function resolveModelProviderFamilyIdByProviderId(
  providerId: string,
): ModelProviderFamilyId | null {
  return MODEL_PROVIDER_FAMILY_ID_BY_PROVIDER_ID.get(providerId as BuiltinModelProviderId) ?? null;
}

export function resolveModelProviderFamilyIdByBaseURL(
  baseURL: string | null | undefined,
): ModelProviderFamilyId | null {
  const trimmed = baseURL?.trim();
  if (!trimmed) {
    return null;
  }
  let hostname: string;
  try {
    hostname = new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const spec of MODEL_PROVIDER_FAMILY_SPECS) {
    if (hostname === spec.rootDomain || hostname.endsWith(`.${spec.rootDomain}`)) {
      return spec.id;
    }
  }
  return null;
}

export function resolveModelProviderFamilySpecByProviderId(
  providerId: string,
): ModelProviderFamilySpec | null {
  const familyId = resolveModelProviderFamilyIdByProviderId(providerId);
  return familyId ? getModelProviderFamilySpec(familyId) : null;
}

export function resolveModelProviderFamilyLabelByProviderId(providerId: string): string | null {
  return resolveModelProviderFamilySpecByProviderId(providerId)?.label ?? null;
}

export function normalizeProviderFamilyDomain(
  value: string | null | undefined,
): ProviderFamilyDomain | null {
  return value === "zai" || value === "bigmodel" || value === "openai" ? value : null;
}

export function resolveProviderFamilyDomainFromOAuthProvider(
  provider: OAuthProviderId | string | null | undefined,
): ProviderFamilyDomain | null {
  if (provider === ZAI_PROVIDER_ID) {
    return "zai";
  }
  if (provider === BIGMODEL_PROVIDER_ID) {
    return "bigmodel";
  }
  // openai 是独立身份域，登录后同样写 providerFamilyDomain，
  // 使设置页按域聚焦 openai family；z.ai 域凭据保留、可切回。
  if (provider === OPENAI_PROVIDER_ID) {
    return "openai";
  }
  return null;
}

export function shouldShowModelProviderFamilyForDomain(params: {
  familyId: ModelProviderFamilyId;
  providerFamilyDomain: ProviderFamilyDomain | null | undefined;
}): boolean {
  const providerFamilyDomain = normalizeProviderFamilyDomain(params.providerFamilyDomain);
  if (!providerFamilyDomain) {
    return true;
  }
  return params.familyId === providerFamilyDomain;
}

export function shouldShowModelProviderFamilyForActiveOAuth(params: {
  familyId: ModelProviderFamilyId;
  activeOAuthProvider: OAuthProviderId | null | undefined;
}): boolean {
  return shouldShowModelProviderFamilyForDomain({
    familyId: params.familyId,
    providerFamilyDomain: resolveProviderFamilyDomainFromOAuthProvider(params.activeOAuthProvider),
  });
}

export function shouldShowBuiltinModelProviderForDomain(params: {
  providerId: string;
  providerFamilyDomain: ProviderFamilyDomain | null | undefined;
}): boolean {
  const familyId = resolveModelProviderFamilyIdByProviderId(params.providerId);
  if (!familyId) {
    return true;
  }
  return shouldShowModelProviderFamilyForDomain({
    familyId,
    providerFamilyDomain: params.providerFamilyDomain,
  });
}

export function shouldShowBuiltinModelProviderForActiveOAuth(params: {
  providerId: string;
  activeOAuthProvider: OAuthProviderId | null | undefined;
}): boolean {
  return shouldShowBuiltinModelProviderForDomain({
    providerId: params.providerId,
    providerFamilyDomain: resolveProviderFamilyDomainFromOAuthProvider(params.activeOAuthProvider),
  });
}
