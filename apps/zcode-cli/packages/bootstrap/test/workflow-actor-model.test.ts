import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelection } from "@zcode/shared/model-selection";
import {
  WorkflowActorPersonaModelError,
  WorkflowActorPinnedModelError,
  workflowActorModelPolicy,
} from "../src/app/workflow-actor-model.js";

// fixture 只用已解析的 ModelSelection 形态：被测函数是纯函数，刻意不引 Registry/catalog，
// 测试同样不引。优先级：persona 声明 > run 选择 > resume pin > 父会话当前模型。
const parentSelection: ModelSelection = { providerId: "zhipu", modelId: "glm-5.3" };
const runSelection: ModelSelection = { providerId: "zhipu", modelId: "glm-5.3-flash" };
const personaSelection: ModelSelection = { providerId: "openai", modelId: "gpt-5.2" };

test("persona 声明在场时覆盖一切：run 选择让位，畸形 pin 连解析都不做、不抛", () => {
  const policy = workflowActorModelPolicy(
    { parentSelection, runSelection },
    // 畸形 pin（缺 provider 段）：若被解析会抛 WorkflowActorPinnedModelError——这里必须不被解析。
    "glm-5.3-no-provider-segment",
    personaSelection,
  );
  assert.deepEqual(policy, { configOverrides: { modelSelection: personaSelection } });
});

test("无 persona、run 选择在场：整条覆盖成 run 选择，pin 不解析（畸形也不抛）", () => {
  const policy = workflowActorModelPolicy(
    { parentSelection, runSelection },
    "glm-5.3-no-provider-segment",
  );
  assert.deepEqual(policy, { configOverrides: { modelSelection: runSelection } });
});

test("无 persona 无 run、pin 就是父会话当前模型：不覆盖（空对象交给 child 基线）", () => {
  const policy = workflowActorModelPolicy({ parentSelection }, "zhipu/glm-5.3");
  assert.deepEqual(policy, { configOverrides: {} });
});

test("无 persona 无 run、pin ≠ 父会话当前模型：覆盖成 pin 解析出的选择", () => {
  const policy = workflowActorModelPolicy({ parentSelection }, "zhipu/glm-5.3-air");
  assert.deepEqual(policy, {
    configOverrides: { modelSelection: { providerId: "zhipu", modelId: "glm-5.3-air" } },
  });
});

test("无 persona 无 run、pin 畸形（缺 provider 段）：抛 WorkflowActorPinnedModelError", () => {
  assert.throws(
    () => workflowActorModelPolicy({ parentSelection }, "glm-5.3-no-provider-segment"),
    WorkflowActorPinnedModelError,
  );
});

test("全无（无 persona、无 run、无 pin）：空对象，继承父会话当前模型", () => {
  const policy = workflowActorModelPolicy({});
  assert.deepEqual(policy, { configOverrides: {} });
});

test("persona 声明携带 reasoning 档位时整条透传（options 不丢）", () => {
  const withReasoning: ModelSelection = {
    providerId: "zhipu",
    modelId: "glm-5.3-flash",
    options: { reasoningLevel: "high" },
  };
  const policy = workflowActorModelPolicy({}, undefined, withReasoning);
  assert.deepEqual(policy, { configOverrides: { modelSelection: withReasoning } });
});

test("WorkflowActorPersonaModelError：消息含声明原文与原因，declaredModel 可编程读取", () => {
  const error = new WorkflowActorPersonaModelError("openai/gpt-5.2$high", "not_found");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "WorkflowActorPersonaModelError");
  assert.equal(error.declaredModel, "openai/gpt-5.2$high");
  assert.match(error.message, /openai\/gpt-5\.2\$high/);
  assert.match(error.message, /not_found/);
});

test("WorkflowActorPersonaModelError 带不截断标记：reason 的候选清单必须完整过 describeCause", () => {
  // spec §2.4：persona.model 解析失败要携带 resolveModelReference 的完整 message（not_found
  // 自带可用模型候选清单）。引擎错误通道（scheduler 的 DriverError 包装）默认给 cause 文本
  // 300 字符的一行上限，会把多行清单拦腰截断；错误类以 unboundedCauseMessage 标记（跨包
  // 结构类型约定，引擎侧 describeCause 按字段名识别）声明自己的 message 不受该上限。
  const candidates = Array.from({ length: 12 }, (_, i) => `  - provider${i}/model-${i}`).join("\n");
  const reason = `no model matches "openai/gpt-5.2"; available models:\n${candidates}`;
  const error = new WorkflowActorPersonaModelError("openai/gpt-5.2", reason);
  assert.equal(error.unboundedCauseMessage, true);
  // 消息总长超过 300 上限而清单必须完整在场（修复前经 describeCause 只剩前 300 字符）。
  assert.ok(error.message.length > 300, "fixture 消息应超过 300 字符上限才有截断风险");
  // message 形如 `...persona: <declared> (<reason>)`：完整 reason 原样在场（括号包裹、逐字不截）。
  assert.ok(error.message.includes(reason), "完整 reason 应原样拼进 message");
});
