// CT-15 E2E 隔离实例的应用配置种子（packages/services/test 下，经 `node --import tsx`
// 由桌面 runner 调用；不是 node:test 用例，manifest 不枚举它）。
//
// 为什么需要：隔离 Electron 实例要到达 Automations/Continuous 页并执行受管 Cycle，
// 首屏欢迎/登录门（useProviderAvailabilityLoginEntryGuard：!providerFamilyDomain ||
// (!user && !hasUsableProvider)）与 workspace 上下文（AutomationsSection 的
// workspacePath 来自当前打开的 workspace tab）都是真实产品前置。种子按产品自己的
// 持久化格式写入隔离数据根（不碰开发者真实 home；HOME 已由 buildIsolationEnv 指进
// 临时根），并用产品自己的 codec/schema 校验——不是向 UI store 塞目标状态：
//   1. <dataDir>/.cotaya/v2/provider_config.json —— 指向脚本化 provider 的个人
//      provider（api-key access + openai-chat-completions baseUrl）+ 手动模型规则 +
//      defaultModelSelection；Host 与 agent CLI 读同一份（node.ts 下发同一路径）。
//   2. <homeDir>/.cotaya/v2/setting.json —— recentProjects/lastWorkspaceSession 指向
//      临时 Git 原仓库（产品「恢复上次会话」路径真实打开 workspace，不经系统目录选择框）。
//   3. <dataDir>/.cotaya/v2/continuous/pricing-snapshot.json —— CT-12 装配的价格快照
//      （缺席则 managed run 结构化拒绝；这里写入脚本化 provider 的虚构固定价）。
// argv：--data-dir <dir> --home-dir <dir> --provider-base-url <url> --workspace-path <p>
//       [--provider-id <id>] [--model-id <id>]；任一校验失败以非零退出（fail closed）。

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeProviderConfigFile } from "@zcode/provider-node";
import { appSettingsSchema } from "@zcode/shared";

function parseArgs(argv: string[]) {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === "--data-dir" ||
      arg === "--home-dir" ||
      arg === "--provider-base-url" ||
      arg === "--workspace-path" ||
      arg === "--provider-id" ||
      arg === "--model-id"
    ) {
      parsed[arg.slice(2)] = argv[(index += 1)];
    } else {
      console.error(`[seed] 未知参数: ${arg}`);
      process.exit(2);
    }
  }
  for (const required of ["data-dir", "home-dir", "provider-base-url", "workspace-path"]) {
    if (!parsed[required]) {
      console.error(`[seed] 缺少 --${required}`);
      process.exit(2);
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const providerId = args["provider-id"] ?? "personal-e2e-scripted";
const modelId = args["model-id"] ?? "continuous-e2e-scripted";
const apiKey = "e2e-fixture-key";

// 个人 provider + 手动模型规则（manualProviderModelRules）。字段形状以产品 schema 为准
//（rule-data-schema.ts / manual-model-config.ts / model-config.ts），写盘前整体过
// decodeProviderConfigFile（与 NodePersonalProviderConfigRepository 读路径同一实现）。
const providerConfig = {
  schemaVersion: 1,
  config: {
    providerOrder: [providerId],
    providerConfigRules: {
      providerRules: [
        {
          providerId,
          providerName: "Continuous E2E Scripted",
          enabled: true,
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey },
            api: { type: "openai-chat-completions", baseUrl: args["provider-base-url"] },
            personalModelIds: [modelId],
            modelOrder: [modelId],
          },
        },
      ],
    },
    modelConfigRules: {
      providerModelRules: [],
      manualProviderModelRules: [
        {
          providerId,
          modelId,
          config: {
            enabled: true,
            properties: {
              contextWindow: 128_000,
              inputFormat: {
                supportsImage: false,
                supportsVideo: false,
                supportsPdf: false,
              },
              supportsJsonSchemaOutput: true,
              supportsNativeWebSearch: false,
              supportsMidConversationSystem: true,
            },
            optionSpecs: {
              reasoningLevel: {
                values: ["minimal", "low", "medium", "high"],
                map: '{"reasoning_effort": reasoningLevel}',
              },
              maxOutputTokens: {
                max: 128_000,
              },
            },
          },
        },
      ],
    },
    defaultModelSelection: {
      providerId,
      modelId,
      options: { reasoningLevel: "minimal" },
    },
  },
};

async function main() {
  // 1. provider 配置：先过产品解码器（parse 全部 zod schema），失败即非零退出。
  decodeProviderConfigFile(providerConfig);
  const providerFile = path.join(args["data-dir"]!, ".cotaya", "v2", "provider_config.json");
  await mkdir(path.dirname(providerFile), { recursive: true });
  await writeFile(providerFile, `${JSON.stringify(providerConfig, null, 2)}\n`, "utf8");

  // 2. 应用设置：恢复上次 workspace 会话（产品「恢复会话」真实打开 fixture 仓库）。
  //    providerFamilyDomain 三字段 = 登录页「跳过」动作写入的同一组设置
  //    （LoginApiKeyForm.helpers buildLoginApiKeySkipSettings）——缺它时启动守卫
  //    （useProviderAvailabilityLoginEntryGuard：!providerFamilyDomain || …）仍会弹欢迎页。
  const settings = {
    providerFamilyDomain: "zai",
    providerFamilyDomainUpdatedAt: Date.now(),
    providerFamilyDomainMigrated: true,
    recentProjects: [args["workspace-path"]!],
    lastWorkspaceSession: [
      { kind: "local", workspacePath: args["workspace-path"]!, workspacePurpose: "project" },
    ],
    lastActiveTabIndex: 0,
  };
  appSettingsSchema.parse(settings);
  const settingsFile = path.join(args["home-dir"]!, ".cotaya", "v2", "setting.json");
  await mkdir(path.dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  // 3. 价格快照（与 fixturesProvider 的虚构固定价一致；单位：微美元/百万 token）。
  const pricing = {
    pricingVersion: "e2e-scripted-1",
    prices: [
      {
        providerId,
        modelId,
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
      },
    ],
  };
  const pricingFile = path.join(
    args["data-dir"]!,
    ".cotaya",
    "v2",
    "continuous",
    "pricing-snapshot.json",
  );
  await mkdir(path.dirname(pricingFile), { recursive: true });
  await writeFile(pricingFile, `${JSON.stringify(pricing, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify({
      providerFile,
      settingsFile,
      pricingFile,
      providerId,
      modelId,
      workspacePath: args["workspace-path"],
    }),
  );
}

main().catch((error) => {
  console.error(
    `[seed] 应用配置种子失败: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
