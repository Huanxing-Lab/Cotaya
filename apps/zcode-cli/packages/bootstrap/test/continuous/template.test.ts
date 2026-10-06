// CT-05 固定模板测试：ui-ux-v1 的编译/schema 合成/降低全绿（I-09 前置），以及真实
// run service + harness 子进程 + 脚本化 actor runtime 的整轮执行（I-09/E-03/E-12/E-15 的
// 模板侧）。用例定义见 docs/testing/continuous.md §6/§8。
//
// 脚本化 provider：createActorRuntime 的替身按 actor 名 + ask 指令分发预设 typed 结果，
// 经真实 submitPort 桥接回引擎裁决（typed 校验是真实的——形状不符会被引擎拒绝并触发
// nudge/repair，所以替身结果必须符合模板接口声明的合成 schema）。CT-11 起 v2 模板：
// 测试执行/浏览器验证/Git diff/本地提交走可信工具端口（world.run 保留命令，经真实
// worldPortsFor 守卫分派；confined runner 真实 spawn、真实 git 提交落在临时 fixture 仓库；
// 隔离提供方为 test composition 的 passthrough——OS 级隔离证明在 ct11-security.test.ts）。
// 这一层证明模板编排与报告词表，不证明真实模型的改进质量（live 归 CT-09）。
//
// 运行入口：node scripts/test-continuous.mjs --suite integration（tsx + node.test）。

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { DwfSequencedReportQueries } from "@zcode/adapters/storage";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import {
  compileWorkflowScript,
  lowerWorkflowScript,
  synthesizeWorkflowSchemas,
} from "@zcode/dynamic-workflow";
import type { TraceContext } from "@zcode/contracts";
import { parseContinuousReportV1Item } from "@zcode/shared/continuous-protocol";
import { createDynamicWorkflowRunService } from "../../src/app/dynamic-workflow-run-service.js";
import {
  createContinuousExecutionAdapter,
  type ManagedCycleInput,
} from "../../src/app/continuous-execution-adapter.js";
import { guardContinuousActorIo } from "../../src/app/continuous-io-guards.js";
import type { ContinuousExecutionPolicyConfig } from "../../src/app/continuous-execution-policy.js";
import { createContinuousConfinedTestRunner } from "../../src/app/continuous-confined-execution.js";
import { createContinuousEvidenceRegistry } from "../../src/app/continuous-evidence.js";
import { createContinuousTrustedPorts } from "../../src/app/continuous-trusted-ports.js";
import { createContinuousCandidateGrantHolder } from "../../src/app/continuous-decision-adapter.js";
import { createPassthroughIsolationProvider } from "../../src/app/continuous-isolation.js";
import {
  CONTINUOUS_TEMPLATE_UI_UX_V1_ID,
  CONTINUOUS_TEMPLATE_UI_UX_V1_SCRIPT,
  CONTINUOUS_TEMPLATE_UI_UX_V1_VERSION,
  CONTINUOUS_TEMPLATES,
  resolveContinuousTemplate,
  uiUxV1Template,
} from "../../src/continuous-templates/ui-ux-v1.js";

// ── I-09 前置：模板定义与编译 ────────────────────────────────

test("模板定义：版本化注册表、稳定 hash、只经本文件暴露（不碰 saved workflow）", () => {
  const template = uiUxV1Template();
  assert.equal(template.templateId, CONTINUOUS_TEMPLATE_UI_UX_V1_ID);
  assert.equal(template.templateVersion, CONTINUOUS_TEMPLATE_UI_UX_V1_VERSION);
  assert.match(template.scriptHash, /^[0-9a-f]{64}$/);
  assert.equal(template.scriptHash, uiUxV1Template().scriptHash);
  // 评审修复（候选授权接线）：注册表保留 v3（现行）与 v2（冻结副本）两个条目——
  // 授权绑定 v2 hash 的既有 Program 按旧条目继续 resolve（规格 §6 不静默换脚本）。
  assert.equal(CONTINUOUS_TEMPLATES.length, 2);
  assert.equal(
    resolveContinuousTemplate({
      templateId: "ui-ux-v1",
      templateVersion: CONTINUOUS_TEMPLATE_UI_UX_V1_VERSION,
    })?.scriptHash,
    template.scriptHash,
  );
  assert.notEqual(
    resolveContinuousTemplate({ templateId: "ui-ux-v1", templateVersion: "2" }),
    null,
    "v2 冻结条目保留（旧 Program 按原 hash resolve）",
  );
  assert.equal(resolveContinuousTemplate({ templateId: "ui-ux-v1", templateVersion: "9" }), null);
  assert.equal(resolveContinuousTemplate({ templateId: "missing", templateVersion: "1" }), null);
});

test("编译/schema 合成/降低全绿（模板不可用必须明确失败，不静默换脚本）", () => {
  const compiled = compileWorkflowScript(CONTINUOUS_TEMPLATE_UI_UX_V1_SCRIPT);
  assert.deepEqual(compiled.diagnostics, []);
  const synthesis = synthesizeWorkflowSchemas(CONTINUOUS_TEMPLATE_UI_UX_V1_SCRIPT);
  assert.deepEqual(
    synthesis.diagnostics.map((d) => `${d.code}@${d.line}:${d.column}`),
    [],
    "typed ask 的 schema 合成必须成功",
  );
  // typed ask 站点（CT-11 v2）：observation + 每候选 impl/review（tests/browser 已改为
  // 可信工具端口的 world.run，不再是 typed ask）。
  assert.ok(Object.keys(synthesis.schemas).length >= 3);
  const lowered = lowerWorkflowScript(CONTINUOUS_TEMPLATE_UI_UX_V1_SCRIPT);
  assert.ok(lowered.ok, `lower failed: ${JSON.stringify(lowered.diagnostics)}`);
});

// ── 脚本化 actor runtime（fixture provider）───────────────────

/** 每个 actor 的 ask 应答表：按指令包含的标记串匹配（candidateKey 等）。 */
interface ScriptedActor {
  name: string;
  respond: (instructions: string) => Record<string, unknown>;
}

interface ProviderHarness {
  root: string;
  journal: JournalStorePort & DwfSequencedReportQueries;
  service: ReturnType<typeof createDynamicWorkflowRunService>;
  adapter: ReturnType<typeof createContinuousExecutionAdapter>;
  /** actor 会话创建记录（I-09：新轮 actor ID 不复用；parent 从不建 runtime）。 */
  createdSessions: Array<{ actorName: string; sessionId: string; instructions?: string }>;
  /** 浏览器证据提供方的脚本化状态（candidateKey → outcome）。 */
  setBrowserOutcome(candidateKey: string, outcome: "passed" | "failed" | "unverified"): void;
  dispose(): void;
}

/** world.run / git.* 的执行端口结果形态（contracts ExecutionPort 的窄投影）。 */
interface ScriptedExecutionResult {
  status: "completed" | "failed";
  exitCode: number;
  stdout: { text: string; bytes: number; truncated: boolean };
  stderr: { text: string; bytes: number; truncated: boolean };
}

function runArgv(cwd: string, file: string, args: string[]): ScriptedExecutionResult {
  try {
    const stdout = execFileSync(file, args, {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    }) as string;
    return {
      status: "completed",
      exitCode: 0,
      stdout: { text: stdout, bytes: stdout.length, truncated: false },
      stderr: { text: "", bytes: 0, truncated: false },
    };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    const stderr = failure.stderr ?? String(error);
    const stdout = failure.stdout ?? "";
    return {
      status: "failed",
      exitCode: failure.status ?? 1,
      stdout: { text: stdout, bytes: stdout.length, truncated: false },
      stderr: { text: stderr, bytes: stderr.length, truncated: false },
    };
  }
}

/** fixture 控制面：脚本化 actor 在实施 ask 时驱动（浏览器证据/期望退出码）。 */
interface FixtureControl {
  setBrowserOutcome(candidateKey: string, outcome: "passed" | "failed" | "unverified"): void;
  setTestExitCode(code: number): void;
}

function makeProviderHarness(
  actorsForRoot: (root: string, control: FixtureControl) => ScriptedActor[],
): ProviderHarness {
  const root = mkdtempSync(join(tmpdir(), "continuous-ct05-template-"));
  // 真实 git fixture：可信 diff/提交端口与 git 事实都落在真仓库。
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "continuous@test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "continuous test"], { cwd: root });
  writeFileSync(join(root, "README.md"), "# fixture\n");
  // fixture 助手文件（声明测试探针/退出码）不进入 diff 口径：gitignore 进基线提交。
  writeFileSync(join(root, ".gitignore"), "ct11-exit-code.js\nct11-test-exit.json\n");
  execFileSync("git", ["add", "README.md", ".gitignore"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "fixture base"], { cwd: root });

  // 生产布局同构：session store 与受控输出都在 worktree 之外（且不在仓库目录树内——
  // 它们会以 untracked 形式进入 diff/变更量口径）。
  const outsideRoot = join(dirname(root), `${basename(root)}-outside`);
  mkdirSync(join(outsideRoot, "outputs"), { recursive: true });
  const store = createSqliteSessionStore({ dbPath: join(outsideRoot, "sessions.sqlite") });
  const journal = store.workflowJournalStore() as JournalStorePort & DwfSequencedReportQueries;
  const fileSystemPort = createNodeFileSystemAdapter();
  const executionPort = {
    run: async (request: {
      command: { mode: string; file: string; args: string[] };
      cwd: string;
    }): Promise<ScriptedExecutionResult> =>
      runArgv(request.cwd, request.command.file, request.command.args),
  };
  const createdSessions: ProviderHarness["createdSessions"] = [];
  let turnCounter = 0;

  // ── CT-11 可信工具端口装配（worldPortsFor；隔离为 test-passthrough，见文件头）──
  const grants = createContinuousCandidateGrantHolder();
  const evidence = createContinuousEvidenceRegistry();
  // baseCommit 在 fixture targets 提交后再定格（actorsForRoot 内完成 targets 提交）。
  let baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  // 声明测试命令：真实 node 进程读取 fixture 写入的期望退出码。
  writeFileSync(
    join(root, "ct11-exit-code.js"),
    "const fs = require('fs');\ntry { process.exit(JSON.parse(fs.readFileSync('ct11-test-exit.json', 'utf8')).code); } catch { process.exit(0); }\n",
  );
  writeFileSync(join(root, "ct11-test-exit.json"), JSON.stringify({ code: 0 }));
  const policyConfig: ContinuousExecutionPolicyConfig = {
    executionPath: root,
    workspacePath: root,
    scope: { allowedPaths: ["src"], forbiddenPaths: [], forbiddenCapabilities: ["push", "merge"] },
    declaredTestCommands: [{ argv: ["node", "ct11-exit-code.js"] }],
    activeCandidate: null,
    pathStyle: "posix",
    caseInsensitiveFs: false,
    platformExecutionMode: "autonomous",
  };
  const policy = {
    role: "builder" as const,
    config: (): ContinuousExecutionPolicyConfig => ({
      ...policyConfig,
      activeCandidate: grants.activeGrant(),
    }),
    waitForAdmission: async () => {},
  };
  const outputRoot = join(outsideRoot, "outputs");
  const testRunner = createContinuousConfinedTestRunner({
    executionPath: root,
    outputRoot,
    isolation: createPassthroughIsolationProvider(),
  });
  const browserStates = new Map<string, "passed" | "failed" | "unverified">();
  const trusted = createContinuousTrustedPorts({
    policy,
    identity: () => ({ programId: "p", cycleId: "c", runId: "run-ct05", epoch: 1 }),
    baseCommit: () => baseCommit,
    evidence,
    testRunner,
    browser: {
      check: async (input) => {
        const outcome = browserStates.get(input.candidateKey) ?? "unverified";
        return {
          outcome,
          assertions: [{ kind: "browser", detail: `fixture ${input.widths.join("x")}` }],
          reason:
            outcome === "passed"
              ? "fixture 通过"
              : outcome === "failed"
                ? "fixture 断言失败"
                : "fixture 浏览器不可用",
        };
      },
    },
    grants,
    changeLimits: () => ({ maxFiles: 10, maxChangedLines: 400 }),
    suspendForChangeLimit: async () => {},
    outputRoot,
  });
  const worldPorts = guardContinuousActorIo(policy, { trusted, testRunner });

  const control: FixtureControl = {
    // 评审修复（候选授权接线）：授权由模板骨架经 continuous-authorize 可信端口驱动
    //（fixture 与产品同一 trusted 端口装配）——fixture 不再手动 authorize。
    setBrowserOutcome: (candidateKey, outcome) => browserStates.set(candidateKey, outcome),
    setTestExitCode: (code) =>
      writeFileSync(join(root, "ct11-test-exit.json"), JSON.stringify({ code })),
  };
  const actors = actorsForRoot(root, control);
  baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

  const service = createDynamicWorkflowRunService({
    journal,
    parentSessionId: `app-${randomUUID()}`,
    fileSystemPort,
    executionPort: executionPort as never,
    worldPortsFor: () => worldPorts,
    createActorRuntime: ({ actor, persona, sessionId, submitPort }) => {
      // actor 的有效名在 persona.name（ActorRef 只有 siteId/ordinal）。
      const actorName = persona.name ?? `anonymous-${actor.siteId}`;
      const scripted = actors.find((entry) => entry.name === actorName);
      if (!scripted) {
        return {
          getSessionModelSelection: () => ({ providerId: "fixture", modelId: "fixture-model" }),
          ensureSessionPersistedForExternalActivity: async () => {},
          resumeFromStore: async () => {},
          executeTurn: () => Promise.reject(new Error(`no scripted actor for ${actorName}`)),
          dispose: () => {},
        } as never;
      }
      return {
        getSessionModelSelection: () => ({ providerId: "fixture", modelId: "fixture-model" }),
        ensureSessionPersistedForExternalActivity: async () => {},
        resumeFromStore: async () => {},
        executeTurn: (instructions: string) =>
          new Promise((resolve) => {
            turnCounter += 1;
            createdSessions.push({ actorName: scripted.name, sessionId, instructions });
            const result = scripted.respond(instructions);
            void submitPort
              .respond({
                toolCallId: `scripted-${turnCounter}`,
                result,
                trace: { traceId: "trace-ct05" as never } satisfies TraceContext,
              })
              .then((verdict) => {
                resolve({
                  response: verdict.accept
                    ? "submitted"
                    : `violations: ${JSON.stringify(verdict.violations)}`,
                  turnId: `t-${turnCounter}` as never,
                  traceId: "trace-ct05" as never,
                  events: [],
                  projection: {} as never,
                });
              });
          }),
        dispose: () => {},
      } as never;
    },
  });
  const adapter = createContinuousExecutionAdapter({
    runService: service,
    journal,
    reportReader: journal,
  });
  return {
    root,
    journal,
    service,
    adapter,
    createdSessions,
    setBrowserOutcome: (candidateKey, outcome) => browserStates.set(candidateKey, outcome),
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function templateInput(overrides: Partial<ManagedCycleInput> = {}): ManagedCycleInput {
  const template = uiUxV1Template();
  const id = randomUUID();
  return {
    programId: `prog-${id}`,
    cycleId: `cycle-${id}`,
    executionSessionId: `ctexec-${id}`,
    workflowRunId: `dwfrun-ct-${id.slice(0, 12)}`,
    traceId: `trace-ct-${id.slice(12, 24)}`,
    executionPath: "",
    scriptText: template.scriptText,
    scriptHash: template.scriptHash,
    configurationSnapshot: { template: `${template.templateId}@${template.templateVersion}` },
    ...overrides,
  };
}

/** 从 journal 报告读面拉全量条目并按 V1 解析（模板侧断言用）。 */
async function readV1Reports(
  adapter: ReturnType<typeof createContinuousExecutionAdapter>,
  input: ManagedCycleInput,
): Promise<
  Array<{ kind: string; itemKey: string; item: ReturnType<typeof parseContinuousReportV1Item> }>
> {
  const ref = {
    cycleId: input.cycleId,
    executionSessionId: input.executionSessionId,
    workflowRunId: input.workflowRunId,
    traceId: input.traceId,
  };
  const batch = await adapter.readReports(ref, 0);
  return batch.items.map((item) => ({
    kind: item.kind,
    itemKey: item.itemKey,
    item: parseContinuousReportV1Item(item.payload),
  }));
}

// ── 场景 fixture：脚本化模型对每候选的预设结局 ────────────────

interface CandidateScript {
  itemKey: string;
  title: string;
  targetFile: string;
  classification: "autonomous" | "needs_decision";
  testsExitCode: number;
  browserOutcome: "passed" | "failed" | "unverified";
  reviewPassed: boolean;
  /** 是否真的让 builder 写文件（实施成功）。 */
  implement: boolean;
}

interface ScenarioConfig {
  candidates: CandidateScript[];
  /** 额外产出需要用户决策的事项（I-08：运行中 Decision 已保存）。 */
  decision?: { itemKey: string; relatedCandidateKey: string };
}

const OBSERVATION_EVIDENCE = [{ kind: "observation", detail: "fixture 观察" }];

function scriptedActorsFor(
  scenario: ScenarioConfig,
  root: string,
  control: FixtureControl,
): ScriptedActor[] {
  const candidates = scenario.candidates;
  const forKey = (instructions: string): CandidateScript | undefined =>
    candidates.find((candidate) => instructions.includes(candidate.itemKey));
  return [
    {
      name: "observer",
      respond: () => ({
        candidates: candidates.map((candidate) => ({
          itemKey: candidate.itemKey,
          fingerprint: `fp-${candidate.itemKey}-stable`,
          title: candidate.title,
          rationale: "fixture 候选",
          targetPaths: [candidate.targetFile],
          impact: 5,
          confidence: 0.9,
          effort: 2,
          risk: "low",
          classification: candidate.classification,
          evidence: OBSERVATION_EVIDENCE,
        })),
        decisions: scenario.decision
          ? [
              {
                itemKey: scenario.decision.itemKey,
                fingerprint: `fp-${scenario.decision.itemKey}-stable`,
                title: "Settings navigation 重构",
                context: "涉及信息结构，需要用户决策",
                options: [
                  { id: "keep", label: "保持", consequences: "无变化" },
                  { id: "split", label: "拆分", consequences: "导航层级变化" },
                ],
                recommendation: "keep",
                relatedCandidateKeys: [scenario.decision.relatedCandidateKey],
              },
            ]
          : [],
        notes: "fixture 观察",
      }),
    },
    {
      name: "builder",
      respond: (instructions) => {
        const candidate = forKey(instructions);
        if (!candidate) throw new Error(`builder: 无法识别候选: ${instructions.slice(0, 120)}`);
        if (instructions.includes("实施候选")) {
          // 实施 ask：授权已由骨架在 ask 之前经 continuous-authorize 端口完成（评审修复
          // 后的产品路径）；这里真实写入目标文件（可信 diff/提交端口据此看到真实改动），
          // 并布置本候选的验证结局。
          control.setTestExitCode(candidate.testsExitCode);
          control.setBrowserOutcome(candidate.itemKey, candidate.browserOutcome);
          if (candidate.implement) {
            writeFileSync(join(root, candidate.targetFile), `${candidate.itemKey} improved\n`);
          }
          return {
            candidateKey: candidate.itemKey,
            notes: "fixture 实施",
          };
        }
        throw new Error(`builder: 未预期的指令: ${instructions.slice(0, 120)}`);
      },
    },
    {
      name: "reviewer",
      respond: (instructions) => {
        const candidate = forKey(instructions);
        if (!candidate) throw new Error(`reviewer: 无法识别候选: ${instructions.slice(0, 120)}`);
        // CT-11 v2：浏览器证据来自可信端口；reviewer 只承担独立 Review（否决面）。
        return {
          candidateKey: candidate.itemKey,
          outcome: candidate.reviewPassed ? "passed" : "failed",
          findings: candidate.reviewPassed ? [] : ["fixture review 拒绝"],
        };
      },
    },
  ];
}

function writeScenarioTargets(root: string, scenario: ScenarioConfig): void {
  const directories = new Set(
    scenario.candidates.map((candidate) => dirname(join(root, candidate.targetFile))),
  );
  for (const directory of directories) mkdirSync(directory, { recursive: true });
  for (const candidate of scenario.candidates) {
    writeFileSync(join(root, candidate.targetFile), `${candidate.itemKey} baseline\n`);
  }
  if (scenario.candidates.length > 0) {
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "fixture targets"], { cwd: root });
  }
}

function gitCommitCount(root: string): number {
  return Number(
    execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  );
}

interface ScenarioRun {
  harness: ProviderHarness;
  input: ManagedCycleInput;
  reports: Awaited<ReturnType<typeof readV1Reports>>;
}

/** 跑一个完整模板场景到 run 终态并拉全量 V1 报告。 */
async function runTemplateScenario(scenario: ScenarioConfig): Promise<ScenarioRun> {
  const harness = makeProviderHarness((root, control) => {
    writeScenarioTargets(root, scenario);
    return scriptedActorsFor(scenario, root, control);
  });
  const input = templateInput({ executionPath: harness.root });
  const ref = await harness.adapter.submitOnce(input);
  await waitFor(() => harness.adapter.inspect(ref).then((state) => state.status === "completed"));
  await harness.adapter.waitForQuiescence(ref);
  const reports = await readV1Reports(harness.adapter, input);
  return { harness, input, reports };
}

function candidateResultOf(
  reports: ScenarioRun["reports"],
  candidateKey: string,
): { status: string; commits: string[] } | undefined {
  const entry = reports.find(
    (report) =>
      report.item.ok &&
      report.item.item.kind === "candidate_result" &&
      report.item.item.candidateKey === candidateKey,
  );
  if (!entry || !entry.item.ok || entry.item.item.kind !== "candidate_result") return undefined;
  return { status: entry.item.item.status, commits: entry.item.item.commits };
}

function cycleResultOf(
  reports: ScenarioRun["reports"],
): { outcome: string; commits: string[] } | undefined {
  const entry = reports.find(
    (report) => report.item.ok && report.item.item.kind === "cycle_result",
  );
  if (!entry || !entry.item.ok || entry.item.item.kind !== "cycle_result") return undefined;
  return { outcome: entry.item.item.outcome, commits: entry.item.item.commits };
}

// ── I-09/E-03：三个独立改进完整验证 ──────────────────────────

test("I-09/E-03: 三个独立候选逐项实施+三验证全过才提交；单 builder 串行；报告全为 V1", async (t) => {
  const scenario: ScenarioConfig = {
    candidates: [
      {
        itemKey: "cand-header",
        title: "Header spacing",
        targetFile: "src/ui/Header.tsx",
        classification: "autonomous",
        testsExitCode: 0,
        browserOutcome: "passed",
        reviewPassed: true,
        implement: true,
      },
      {
        itemKey: "cand-sidebar",
        title: "Mobile sidebar overflow",
        targetFile: "src/ui/Sidebar.tsx",
        classification: "autonomous",
        testsExitCode: 0,
        browserOutcome: "passed",
        reviewPassed: true,
        implement: true,
      },
      {
        itemKey: "cand-empty",
        title: "Empty state contrast",
        targetFile: "src/ui/Empty.tsx",
        classification: "autonomous",
        testsExitCode: 0,
        browserOutcome: "passed",
        reviewPassed: true,
        implement: true,
      },
    ],
  };
  const run = await runTemplateScenario(scenario);
  t.after(() => run.harness.dispose());
  const { reports, harness } = run;
  // 全部条目都是合法 V1（读侧不丢行；模板词表与导入 schema 对齐）。
  for (const report of reports) {
    assert.ok(
      report.item.ok,
      `report ${report.itemKey} 不是合法 V1: ${JSON.stringify(report.item)}`,
    );
  }
  const kinds = reports.map((report) => (report.item.ok ? report.item.item.kind : undefined));
  assert.equal(kinds.filter((kind) => kind === "candidate").length, 3);
  assert.equal(kinds.filter((kind) => kind === "validation").length, 9); // 3 候选 × 3 阶段
  assert.equal(kinds.filter((kind) => kind === "candidate_result").length, 3);

  // 三项全 done，各带真实 commit。
  for (const key of ["cand-header", "cand-sidebar", "cand-empty"]) {
    const result = candidateResultOf(reports, key);
    assert.ok(result, `missing candidate_result for ${key}`);
    assert.equal(result!.status, "done");
    assert.equal(result!.commits.length, 1);
    assert.match(result!.commits[0]!, /^[0-9a-f]{7,40}$/);
  }
  const cycle = cycleResultOf(reports);
  assert.ok(cycle);
  assert.equal(cycle!.outcome, "changes_verified");
  assert.equal(cycle!.commits.length, 3);
  assert.equal(gitCommitCount(harness.root), 5); // base + targets + 3 个候选提交

  // 单 builder：builder 会话恰好一个（不并行）；reviewer 是独立只读会话。
  const builderSessions = new Set(
    harness.createdSessions.filter((s) => s.actorName === "builder").map((s) => s.sessionId),
  );
  assert.equal(builderSessions.size, 1, "builder 不并行（一个持久会话逐项实施）");
  const reviewerSessions = new Set(
    harness.createdSessions.filter((s) => s.actorName === "reviewer").map((s) => s.sessionId),
  );
  assert.equal(reviewerSessions.size, 1, "reviewer 独立只读会话");
});

// ── E-12：测试/浏览器/Review 失败与验证不可用 ─────────────────

test("E-12: 失败/不可用候选不 done 不提交，独立项照常完成；不可用明确 unverified", async (t) => {
  const scenario: ScenarioConfig = {
    candidates: [
      {
        itemKey: "cand-broken",
        title: "Broken spacing",
        targetFile: "src/ui/Broken.tsx",
        classification: "autonomous",
        testsExitCode: 1, // 测试失败
        browserOutcome: "failed",
        reviewPassed: false,
        implement: true,
      },
      {
        itemKey: "cand-nobrowser",
        title: "No browser available",
        targetFile: "src/ui/NoBrowser.tsx",
        classification: "autonomous",
        testsExitCode: 0,
        browserOutcome: "unverified", // 浏览器不可用 → unverified
        reviewPassed: true,
        implement: true,
      },
      {
        itemKey: "cand-good",
        title: "Good tweak",
        targetFile: "src/ui/Good.tsx",
        classification: "autonomous",
        testsExitCode: 0,
        browserOutcome: "passed",
        reviewPassed: true,
        implement: true,
      },
    ],
  };
  const run = await runTemplateScenario(scenario);
  t.after(() => run.harness.dispose());
  const { reports, harness } = run;

  assert.equal(candidateResultOf(reports, "cand-broken")!.status, "rejected");
  assert.deepEqual(candidateResultOf(reports, "cand-broken")!.commits, []);
  assert.equal(candidateResultOf(reports, "cand-nobrowser")!.status, "unverified");
  assert.deepEqual(candidateResultOf(reports, "cand-nobrowser")!.commits, []);
  assert.equal(candidateResultOf(reports, "cand-good")!.status, "done");
  assert.equal(candidateResultOf(reports, "cand-good")!.commits.length, 1);

  // 只有独立可验证项产生提交（base + targets + 1）。
  assert.equal(gitCommitCount(harness.root), 3);
  const cycle = cycleResultOf(reports);
  assert.equal(cycle!.outcome, "partial");
  assert.equal(cycle!.commits.length, 1);

  // 不可用的 validation 事实带原因上报（模型“已通过”文本不能覆盖事实）。
  const unverifiedBrowser = reports.find(
    (report) =>
      report.item.ok &&
      report.item.item.kind === "validation" &&
      report.item.item.stage === "browser" &&
      report.item.item.candidateKey === "cand-nobrowser",
  );
  assert.ok(unverifiedBrowser && unverifiedBrowser.item.ok, "unverified browser validation 上报");
  const validation = unverifiedBrowser!.item;
  if (validation.ok && validation.item.kind === "validation") {
    assert.equal(validation.item.outcome, "unverified");
    assert.ok((validation.item.reason ?? "").length > 0, "unverified 必须带原因");
  } else {
    assert.fail("validation 形状不符");
  }
});

// ── E-15：无改进（空候选）正常收尾 ───────────────────────────

test("E-15: 空候选一轮 outcome=no_changes，不实施不提交，cycle_result 完整上报", async (t) => {
  const run = await runTemplateScenario({ candidates: [] });
  t.after(() => run.harness.dispose());
  const { reports, harness } = run;
  const cycle = cycleResultOf(reports);
  assert.ok(cycle);
  assert.equal(cycle!.outcome, "no_changes");
  assert.deepEqual(cycle!.commits, []);
  assert.equal(gitCommitCount(harness.root), 1); // 仅 fixture base（无候选文件时不加 targets 提交）
  // 没有 candidate_result / validation（无候选可实施）。
  const kinds = reports.map((report) => (report.item.ok ? report.item.item.kind : undefined));
  assert.equal(kinds.filter((kind) => kind === "candidate_result").length, 0);
  assert.equal(kinds.filter((kind) => kind === "validation").length, 0);
});

// ── I-08/I-09：运行中 Decision 已上报；needs_decision 不自主实施；新轮 actor 不复用 ──

test("I-08: 需要 Decision 的候选只上报不实施；Decision 报告先于实施落 journal", async (t) => {
  const run = await runTemplateScenario({
    candidates: [
      {
        itemKey: "cand-settings",
        title: "Settings navigation",
        targetFile: "src/ui/Settings.tsx",
        classification: "needs_decision",
        testsExitCode: 0,
        browserOutcome: "passed",
        reviewPassed: true,
        implement: true,
      },
      {
        itemKey: "cand-independent",
        title: "Independent tweak",
        targetFile: "src/ui/Independent.tsx",
        classification: "autonomous",
        testsExitCode: 0,
        browserOutcome: "passed",
        reviewPassed: true,
        implement: true,
      },
    ],
    decision: { itemKey: "dec-settings", relatedCandidateKey: "cand-settings" },
  });
  t.after(() => run.harness.dispose());
  const { reports, harness } = run;

  // needs_decision 候选未被实施（无 candidate_result、无提交）。
  assert.equal(candidateResultOf(reports, "cand-settings"), undefined);
  assert.equal(candidateResultOf(reports, "cand-independent")!.status, "done");
  assert.equal(gitCommitCount(harness.root), 3); // base + targets + 1
  // Decision 与候选都在报告流里（运行中已保存——监督轮询即时消费）。
  const decision = reports.find((report) => report.item.ok && report.item.item.kind === "decision");
  assert.ok(decision && decision.item.ok && decision.item.item.kind === "decision");
  if (decision!.item.ok && decision!.item.item.kind === "decision") {
    assert.deepEqual(decision!.item.item.blockingScope.candidateKeys, ["cand-settings"]);
    assert.equal(decision!.item.item.classification, "blocking");
  }
  const cycle = cycleResultOf(reports);
  // 自主项 1/1 完成验证 → changes_verified；决策项按 §8 正常暂缓（不是未完成的自主工作）。
  assert.equal(cycle!.outcome, "changes_verified");
});

test("I-09: 两轮（两个 run）actor 会话 id 全不复用——新轮不继承旧 actor 身份", async (t) => {
  const scenario: ScenarioConfig = {
    candidates: [
      {
        itemKey: "cand-only",
        title: "Single tweak",
        targetFile: "src/ui/Single.tsx",
        classification: "autonomous",
        testsExitCode: 0,
        browserOutcome: "passed",
        reviewPassed: true,
        implement: true,
      },
    ],
  };
  const first = await runTemplateScenario(scenario);
  const second = await runTemplateScenario(scenario);
  t.after(() => first.harness.dispose());
  t.after(() => second.harness.dispose());

  const firstIds = new Set(first.harness.createdSessions.map((s) => s.sessionId));
  const secondIds = new Set(second.harness.createdSessions.map((s) => s.sessionId));
  assert.ok(firstIds.size >= 3, "observer/builder/reviewer 各一会话");
  for (const id of secondIds) {
    assert.equal(firstIds.has(id), false, `新轮复用了旧 actor 会话 ${id}`);
  }
  // 命名 actor 同名（observer/builder/reviewer）但会话身份按 run 派生——跨 run 全新。
  assert.equal(secondIds.size >= 3, true);
});
