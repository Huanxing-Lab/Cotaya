import type { IServiceAccessor } from "@zcode/services";
import type { EnterpriseCodingPlanPricingProduct, ZhipuAccountFamilyId } from "@zcode/shared";
import { logger } from "@/logger.js";

type EnterprisePricingProductsResult =
  | { status: "success"; productList: EnterpriseCodingPlanPricingProduct[] }
  | { status: "error" };

export async function getEnterprisePricingProducts(
  services: IServiceAccessor,
  domain: ZhipuAccountFamilyId,
): Promise<EnterprisePricingProductsResult> {
  // 两个账号域均须按自身 Family 查询；失败与明确空列表分开，不能据此自动改掉已有连接。
  // 企业定价是 z.ai 身份域专属；openai 无此体系。
  try {
    const pricing = await services.codingPlanSubscriptionService.getEnterprisePricing({
      authenticated: true,
      family: domain,
    });
    return { status: "success", productList: pricing.productList };
  } catch (error) {
    logger.warn("[Root] 刷新登录后团队套餐失败", { domain, error });
    return { status: "error" };
  }
}

export async function getEnterprisePricingProductsOrEmpty(
  services: IServiceAccessor,
  domain: ZhipuAccountFamilyId,
): Promise<EnterpriseCodingPlanPricingProduct[]> {
  const pricing = await getEnterprisePricingProducts(services, domain);
  return pricing.status === "success" ? pricing.productList : [];
}
