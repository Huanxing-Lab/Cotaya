// 一期未决 4（capability 探测堆积）修复的回归：关闭态 stub 必须让 capability 探测
// 「立即以『未开启』拒绝落定」、其余命令一律拒绝——ChannelServer 对未注册 channel 的
// 请求只缓存等注册、永不应答（每次打开 Automations 页累积 1-2 条 pending，无上界），
// 本修复正是用「始终注册 stub」从源头消除该堆积。产品语义：「未开启」必须与「不支持」
// 分开——capability 若回答 supported:false 会被 UI 判 unsupported、让关闭态多出一个 tab
// （破坏 E-24 关闭态断言与「默认关闭 = 隐藏」回滚位），因此 stub 以含
// continuous_not_enabled 标记的错误拒绝，UI 落 disabled 隐藏态。行为级「不挂起、tab 仍
// 缺席」由 e2e E-24 关闭态实例断言覆盖；本文件锁定 stub 的拒绝形状与 fail closed 语义。
// 运行入口：node scripts/test-continuous.mjs --suite unit。

import assert from "node:assert/strict";
import test from "node:test";
import {
  ContinuousDisabledService,
  CONTINUOUS_NOT_ENABLED_CODE,
} from "../../src/continuous/application/continuousDisabledService.js";
import type { IContinuousServiceFacade } from "../../src/continuous/contract-interfaces.js";

test("关闭态 stub：capability 立即以「未开启」拒绝（消息含稳定标记，不进 pending 队列的前提）", async () => {
  const stub = new ContinuousDisabledService();
  await assert.rejects(stub.capability(), (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    // renderer 侧靠消息标记判 disabled（error.code 不保证跨 RPC 序列化存活）。
    assert.ok(
      text.includes(CONTINUOUS_NOT_ENABLED_CODE),
      `拒绝消息必须含 ${CONTINUOUS_NOT_ENABLED_CODE} 标记（实际：${text}）`,
    );
    return true;
  });
});

test("关闭态 stub：命令面与查询面全部 fail closed（不得退回普通 prompt 自主执行）", async () => {
  const stub: IContinuousServiceFacade = new ContinuousDisabledService();
  const methods = [
    "snapshot",
    "createProgram",
    "runNow",
    "pauseProgram",
    "resumeProgram",
    "stopCurrentCycle",
    "resolveDecision",
    "dismissDecision",
    "archiveProgram",
    "resolveContinuation",
    "listTemplates",
    "programDetail",
  ] as const;
  for (const name of methods) {
    await assert.rejects(
      stub[name]({} as never),
      (error: unknown) => {
        assert.match(error instanceof Error ? error.message : String(error), /未开启/);
        return true;
      },
      `${name} 在关闭态必须拒绝`,
    );
  }
});

test("关闭态 stub：重复探测（每次页面挂载一次）全部立即落定，无状态累积", async () => {
  const stub = new ContinuousDisabledService();
  for (let i = 0; i < 20; i += 1) {
    await assert.rejects(stub.capability(), /continuous_not_enabled/);
  }
});
