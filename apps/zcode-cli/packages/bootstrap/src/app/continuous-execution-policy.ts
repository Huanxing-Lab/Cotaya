// Continuous 执行策略（CT-02，规格 §7/§8）：actor 角色只读边界、候选授权路径、
// 路径检查（traversal/symlink/大小写/空格/Windows 路径）、argv 测试命令白名单、
// Git/能力面禁令与 builder 单候选互斥。全部纯函数：文件/进程事实由调用方
// （CT-03 执行适配器）在操作前采集后传入，本模块不做 IO。
//
// 拒绝统一返回 scope_denied（协议错误词表），reason 提供细化审计原因。
// yolo 等权限 mode 不进入本模块：Continuous 限制独立于普通权限模式，不能被其绕过。

import { posix, win32 } from "node:path";
import type { ContinuousPlatformExecutionMode, ContinuousScopePolicy } from "@zcode/shared";
import { continuousProtectedPathReason } from "./continuous-protected-paths.js";

export type ContinuousActorRole = "observer" | "builder" | "reviewer";

export interface ContinuousDeclaredTestCommand {
  /** 完整 argv；执行使用 spawn(file, args)，绝不经 shell 拼接（规格 §7）。 */
  argv: string[];
}

export interface ContinuousCandidateGrant {
  candidateId: string;
  /** 候选授权路径（executionPath 相对，"/" 分隔）；builder 写入只允许这些前缀。 */
  targetPaths: string[];
}

export interface ContinuousExecutionPolicyConfig {
  /** Program worktree：actor 实际 cwd；一切文件操作只能发生在其内部。 */
  executionPath: string;
  /** 原始仓库：只用于身份与展示，禁止执行期读写（E-02）。 */
  workspacePath: string;
  scope: ContinuousScopePolicy;
  declaredTestCommands: ContinuousDeclaredTestCommand[];
  /** 当前授权候选（builder 一次一个）；observer/reviewer 忽略。 */
  activeCandidate: ContinuousCandidateGrant | null;
  /** 路径风格与文件系统大小写策略：win32 恒不敏感；darwin 默认不敏感（APFS）。 */
  pathStyle: "posix" | "win32";
  caseInsensitiveFs: boolean;
  /**
   * 平台执行模式（CT-10，规格 §13 固定能力规则）：observe_only 平台只提供观察——
   * 一切写入/删除/声明命令/本地提交在操作前拒绝（platform_read_only），读与观察放行。
   * 必填：装配者必须经 shared assessContinuousPlatformExecution 显式回答平台能力，
   * 不允许缺省视为 autonomous（fail closed）。supervisor 启动门是第一层拒绝；
   * 本层是工具执行点的纵深防御，两层共用同一评估函数的输出。
   */
  platformExecutionMode: ContinuousPlatformExecutionMode;
}

export type ContinuousDenyReason =
  | "invalid_path"
  | "backslash_path"
  | "outside_execution_path"
  | "original_workspace_out_of_scope"
  | "symlink_escape"
  | "role_read_only"
  | "platform_read_only"
  | "not_in_allowed_paths"
  | "forbidden_path"
  | "protected_path"
  | "candidate_inactive"
  | "not_in_candidate_paths"
  | "invalid_command"
  | "undeclared_command"
  | "forbidden_capability"
  | "candidate_busy"
  | "validation_required";

export interface ContinuousPolicyDecision {
  allowed: boolean;
  /** 拒绝时恒为 scope_denied（协议词表）；允许时为 allowed。 */
  code: "allowed" | "scope_denied";
  reason?: ContinuousDenyReason;
}

const ALLOWED: ContinuousPolicyDecision = { allowed: true, code: "allowed" };

function denied(reason: ContinuousDenyReason): ContinuousPolicyDecision {
  return { allowed: false, code: "scope_denied", reason };
}

function styleOf(config: ContinuousExecutionPolicyConfig) {
  return config.pathStyle === "win32" ? win32 : posix;
}

/** 统一路径比较：大小写敏感文件系统按字节比较，不敏感系统折叠大小写（防大小写绕过）。 */
function pathEquals(config: ContinuousExecutionPolicyConfig, left: string, right: string): boolean {
  const normalizedLeft = left.replace(/[\\/]+$/, "");
  const normalizedRight = right.replace(/[\\/]+$/, "");
  return config.caseInsensitiveFs
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/** 前缀包含（段边界）：child === ancestor 或 child 以 ancestor + 分隔符 开头。 */
function pathContains(
  config: ContinuousExecutionPolicyConfig,
  ancestor: string,
  child: string,
): boolean {
  const separator = styleOf(config).sep;
  const childSegments = child.split(separator).filter((segment) => segment.length > 0);
  const ancestorSegments = ancestor.split(separator).filter((segment) => segment.length > 0);
  if (childSegments.length < ancestorSegments.length) {
    return false;
  }
  for (let index = 0; index < ancestorSegments.length; index += 1) {
    if (!pathEquals(config, ancestorSegments[index]!, childSegments[index]!)) {
      return false;
    }
  }
  return true;
}

function isInsideDirectory(
  config: ContinuousExecutionPolicyConfig,
  directory: string,
  candidate: string,
): boolean {
  if (pathEquals(config, directory, candidate)) {
    return false; // 目录本身不是其内部文件
  }
  return pathContains(config, directory, candidate);
}

function segmentPrefixMatch(
  config: ContinuousExecutionPolicyConfig,
  prefix: string,
  repoRelative: string,
): boolean {
  const normalizedPrefix = prefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const segments = repoRelative.split("/");
  const prefixSegments = normalizedPrefix.split("/").filter((segment) => segment.length > 0);
  if (prefixSegments.length === 0 || segments.length < prefixSegments.length) {
    return false;
  }
  for (let index = 0; index < prefixSegments.length; index += 1) {
    if (!pathEquals(config, prefixSegments[index]!, segments[index]!)) {
      return false;
    }
  }
  return true;
}

export type ContinuousFileOperation = "read" | "write" | "delete";

export interface ContinuousFilePathCheckInput {
  role: ContinuousActorRole;
  operation: ContinuousFileOperation;
  /** executionPath 内的相对路径，或 executionPath 绝对前缀路径。 */
  path: string;
  /** 调用方对已存在条目解析的 realpath（符号链接逃逸检查）；不存在时传父目录解析结果。 */
  resolvedRealPath?: string;
}

/** 文件操作前检查（读也在内：观察对象是 worktree，不是原始仓库）。 */
export function checkContinuousFilePath(
  config: ContinuousExecutionPolicyConfig,
  input: ContinuousFilePathCheckInput,
): ContinuousPolicyDecision {
  const style = styleOf(config);
  const rawPath = input.path;

  if (rawPath.includes("\0") || rawPath.length === 0) {
    return denied("invalid_path");
  }
  // posix 上反斜杠是合法文件名字符，但绝不来自本功能生成的路径；按可疑输入拒绝。
  if (config.pathStyle === "posix" && rawPath.includes("\\")) {
    return denied("backslash_path");
  }
  if (config.pathStyle === "win32" && rawPath.startsWith("\\\\")) {
    return denied("invalid_path"); // UNC 路径不在受管 worktree 内
  }
  // 盘符相对路径（C:foo）随进程 CWD 漂移，无法证明落在 worktree 内，直接拒绝。
  if (config.pathStyle === "win32" && /^[A-Za-z]:[^\\/]/.test(rawPath)) {
    return denied("invalid_path");
  }
  const withoutDriveLetter = rawPath.replace(/^[A-Za-z]:/, "");
  if (config.pathStyle === "win32" && withoutDriveLetter.includes(":")) {
    return denied("invalid_path"); // NTFS 数据流等非法冒号形态
  }

  const absolutePath = style.isAbsolute(rawPath)
    ? style.normalize(rawPath)
    : style.normalize(style.join(config.executionPath, rawPath));

  // traversal（../、..\\）经 normalize+join 抵消后由包含检查统一拒绝。
  if (!pathContains(config, config.executionPath, absolutePath)) {
    // 命中原始仓库时给出更明确的原因（E-02：原工作区只读）。
    if (isInsideDirectory(config, config.workspacePath, absolutePath)) {
      return denied("original_workspace_out_of_scope");
    }
    return denied("outside_execution_path");
  }

  if (input.resolvedRealPath !== undefined) {
    const resolved = style.normalize(input.resolvedRealPath);
    if (!pathContains(config, config.executionPath, resolved)) {
      return denied("symlink_escape");
    }
  }

  const relativeOf = style.relative(config.executionPath, absolutePath);
  const repoRelative = relativeOf.split(style.sep).join("/");
  if (repoRelative.length === 0) {
    return denied("invalid_path");
  }

  if (input.operation !== "read" && input.role !== "builder") {
    return denied("role_read_only");
  }

  // 平台能力（CT-10，规格 §13）：observe_only 平台连 builder 也只有读——观察对象是
  // worktree 的当前状态，不开放任何自动实施写入。放在角色检查之后：先给出更具体的
  // 角色拒绝，再给平台拒绝；两者都不泄漏路径内容之外的任何信息。
  if (input.operation !== "read" && config.platformExecutionMode === "observe_only") {
    return denied("platform_read_only");
  }

  const inAllowed = config.scope.allowedPaths.some((prefix) =>
    segmentPrefixMatch(config, prefix, repoRelative),
  );
  if (!inAllowed) {
    return denied("not_in_allowed_paths");
  }

  if (
    config.scope.forbiddenPaths.some((prefix) => segmentPrefixMatch(config, prefix, repoRelative))
  ) {
    return denied("forbidden_path");
  }

  if (continuousProtectedPathReason(repoRelative) !== null) {
    return denied("protected_path");
  }

  if (input.operation === "write" || input.operation === "delete") {
    const candidate = config.activeCandidate;
    if (!candidate) {
      return denied("candidate_inactive");
    }
    const inCandidate = candidate.targetPaths.some((prefix) =>
      segmentPrefixMatch(config, prefix, repoRelative),
    );
    if (!inCandidate) {
      return denied("not_in_candidate_paths");
    }
  }

  return ALLOWED;
}

/** 只读角色能力表：observer/reviewer 无写入、无命令、无 Git 变更（U-03/E-13）。 */
export function continuousActorCapabilities(role: ContinuousActorRole): {
  canReadFiles: boolean;
  canWriteFiles: boolean;
  canRunDeclaredTests: boolean;
  canCommit: boolean;
} {
  if (role === "builder") {
    return { canReadFiles: true, canWriteFiles: true, canRunDeclaredTests: true, canCommit: true };
  }
  return { canReadFiles: true, canWriteFiles: false, canRunDeclaredTests: false, canCommit: false };
}

/** 声明式测试命令配置校验：声明阶段就拒绝 mutating git / push / 部署类 argv。
 * CT-11 起 "add" 一并列入：actor 无任意 Git 写能力（含 staging），暂存属于提交端口职责。 */
const MUTATING_GIT_SUBCOMMANDS = new Set([
  "add",
  "push",
  "pull",
  "merge",
  "rebase",
  "reset",
  "clean",
  "checkout",
  "switch",
  "restore",
  "rm",
  "mv",
  "commit",
  "tag",
  "branch",
]);

/** 可执行名末段（兼容 win32 反斜杠与大小写）：git / git.exe / Git.EXE 都识别为 git。 */
function executableBasename(executable: string): string {
  const normalized = executable.replace(/\\/g, "/");
  const lastSegment =
    normalized
      .split("/")
      .filter((part) => part.length > 0)
      .pop() ?? "";
  return lastSegment.toLowerCase();
}

export function validateContinuousDeclaredTestCommands(
  commands: readonly ContinuousDeclaredTestCommand[],
): { ok: true } | { ok: false; reason: string } {
  for (const command of commands) {
    if (
      command.argv.length === 0 ||
      command.argv.some((part) => part.length === 0 || part.includes("\0"))
    ) {
      return { ok: false, reason: "test command argv 不能为空串" };
    }
    const [executable, firstArgument] = command.argv;
    if (
      firstArgument !== undefined &&
      executableBasename(executable!).startsWith("git") &&
      MUTATING_GIT_SUBCOMMANDS.has(firstArgument)
    ) {
      return { ok: false, reason: `git ${firstArgument} 不能声明为测试命令` };
    }
  }
  return { ok: true };
}

export interface ContinuousShellCommandCheckInput {
  role: ContinuousActorRole;
  /** 只接受 argv；任何 shell 字符串形态在类型层面即不可表达。 */
  argv: string[];
}

/** shell/外部工具命令检查：只放行与声明完全一致的 argv（逐项相等，非前缀匹配）。 */
export function checkContinuousShellCommand(
  config: ContinuousExecutionPolicyConfig,
  input: ContinuousShellCommandCheckInput,
): ContinuousPolicyDecision {
  if (
    input.argv.length === 0 ||
    input.argv.some((part) => part.length === 0 || part.includes("\0"))
  ) {
    return denied("invalid_command");
  }
  if (input.role !== "builder") {
    return denied("role_read_only");
  }
  // 平台能力（CT-10，规格 §13）：observe_only 平台不开放命令执行（含声明的测试命令）。
  if (config.platformExecutionMode === "observe_only") {
    return denied("platform_read_only");
  }
  const declared = config.declaredTestCommands.some(
    (command) =>
      command.argv.length === input.argv.length &&
      command.argv.every((part, index) => part === input.argv[index]),
  );
  // 纵深防御：即使被错误声明，mutating git 也在操作前被拒绝（E-13）。
  const [executable, firstArgument] = input.argv;
  if (
    firstArgument !== undefined &&
    executableBasename(executable!).startsWith("git") &&
    MUTATING_GIT_SUBCOMMANDS.has(firstArgument)
  ) {
    return denied("forbidden_capability");
  }
  return declared ? ALLOWED : denied("undeclared_command");
}

export type ContinuousGitOperation =
  | "commit"
  | "push"
  | "merge"
  | "rebase"
  | "deploy"
  | "db_migration";

export interface ContinuousGitOperationCheckInput {
  role: ContinuousActorRole;
  operation: ContinuousGitOperation;
  /** 提交前置验证事实（规格 §7：测试、浏览器验证、独立 Review 全部通过才允许提交）。 */
  verification?: { testsPassed: boolean; browserVerified: boolean; reviewPassed: boolean };
}

/** Git 操作检查：本地 commit 是唯一允许的变更操作；push/merge/deploy/migration 全禁。 */
export function checkContinuousGitOperation(
  config: ContinuousExecutionPolicyConfig,
  input: ContinuousGitOperationCheckInput,
): ContinuousPolicyDecision {
  if (input.operation !== "commit") {
    return denied("forbidden_capability");
  }
  if (input.role !== "builder") {
    return denied("role_read_only");
  }
  // 平台能力（CT-10，规格 §13）：observe_only 平台连验证通过的本地提交也不做——
  // 不开放自动实施意味着不产生本功能管理的交付物（分支上没有新提交）。
  if (config.platformExecutionMode === "observe_only") {
    return denied("platform_read_only");
  }
  const verification = input.verification;
  if (
    !verification ||
    !verification.testsPassed ||
    !verification.browserVerified ||
    !verification.reviewPassed
  ) {
    return denied("validation_required");
  }
  return ALLOWED;
}

export type ContinuousCapability =
  | "mcp_write"
  | "sandbox_disable"
  | "backend_rewrite"
  | "db_migration"
  | "billing_auth"
  | "deploy"
  | "push"
  | "merge";

/** 能力面检查：v1 恒禁清单 + Scope forbiddenCapabilities（不能通过“继续”绕过）。 */
export function checkContinuousCapability(
  config: ContinuousExecutionPolicyConfig,
  capability: ContinuousCapability,
): ContinuousPolicyDecision {
  if (capability === "mcp_write" || capability === "sandbox_disable") {
    return denied("forbidden_capability");
  }
  if (config.scope.forbiddenCapabilities.includes(capability)) {
    return denied("forbidden_capability");
  }
  return ALLOWED;
}

/** builder 一次只授权一个候选：同候选重复授权幂等，不同候选在占用期拒绝。 */
export function authorizeContinuousBuilderCandidate(
  activeCandidate: ContinuousCandidateGrant | null,
  requestedCandidateId: string,
): ContinuousPolicyDecision {
  if (activeCandidate && activeCandidate.candidateId !== requestedCandidateId) {
    return denied("candidate_busy");
  }
  return ALLOWED;
}
