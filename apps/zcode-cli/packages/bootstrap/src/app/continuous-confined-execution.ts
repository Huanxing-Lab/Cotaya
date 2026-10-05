// ============================================================
// Continuous 受控 argv 测试执行（CT-11 第 3 条）
// ============================================================
// 修复依据：docs/tickets/continuous-release-gaps.md CT-11 第 3 条——「声明测试由受控
// argv 端口执行，固定 worktree cwd、环境、超时、输出目录和取消过程；实际限制文件/
// 网络副作用」。此前 io-guards 对一切进程执行恒拒（confined_execution_not_supported），
// 三阶段验证里的「可执行测试」无法真实发生。
//
// 本 runner 的固定面（每一项都是规格要求，不是实现偏好）：
//   - cwd：恒为注册的 executionPath（Program worktree），请求侧不能改；
//   - 环境：白名单最小集（PATH/TMPDIR/HOME/LANG），HOME/TMPDIR 重定向进本次输出目录
//     ——命令的任何落盘都在受控输出区内，宿主凭据/会话环境不进入子进程；
//   - 超时：默认 300s，到点杀整棵进程树（进程组），结果是 timed_out 证据而非静默；
//   - 取消：AbortSignal 触发同样的进程树终止；等待退出后才算完成（停止证明）；
//   - 隔离：经 continuous-isolation 的**已自证**提供方包装 argv（写限于 worktree+
//     输出目录、网络全拒）；提供方缺席/未自证 → runner 不可用（fail closed），调用方
//     返回 confined_execution_not_supported，不得拿请求里的 sandbox 声称当证明。
//
// 杀树实现：spawn detached（自有进程组），SIGTERM 组信号 → 宽限 → SIGKILL 组信号，
// 等待 close。与 services 侧 platform suite 的 kill(-pgid) 证明同一机制（此处为
// bootstrap 侧的独立实现：adapters/exec 未导出该助手，不为本 ticket 扩公共面）。

import { spawn } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContinuousIsolationProvider } from "./continuous-isolation.js";

const SIGTERM_GRACE_MS = 1_500;
const DEFAULT_TIMEOUT_MS = 300_000;
/** stdout/stderr 各自的捕获上限：超限停止捕获并标记 truncated（证据有界，§11）。 */
const STREAM_CAPTURE_BYTES = 256 * 1024;

export interface ContinuousConfinedRunOptions {
  signal?: AbortSignal;
  /** 覆盖默认 300s；必须是正整数。 */
  timeoutMs?: number;
}

export interface ContinuousConfinedRunResult {
  status: "completed" | "failed" | "timed_out" | "cancelled" | "spawn_error";
  exitCode?: number;
  stdoutTail: string;
  stderrTail: string;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  outputDir: string;
  stdoutPath: string;
  stderrPath: string;
  startedAt: number;
  durationMs: number;
  /** 执行本次命令的隔离提供方键（证据关联：test-passthrough 会如实标注无 OS 隔离）。 */
  isolationKey: string;
}

export interface ContinuousConfinedTestRunner {
  /** 提供方未自证时为 false：调用方必须据此返回不可用，而不是降级直跑。 */
  readonly available: boolean;
  readonly isolationKey: string;
  run(
    argv: readonly string[],
    options?: ContinuousConfinedRunOptions,
  ): Promise<ContinuousConfinedRunResult>;
}

export interface CreateConfinedRunnerDeps {
  /** Program worktree（realpath 归一；命令 cwd 与可写目录之一）。 */
  executionPath: string;
  /** 本次 run 的受控输出根（每次执行建独立子目录并整体可写）。 */
  outputRoot: string;
  isolation: ContinuousIsolationProvider;
  /** 环境白名单之外的变量一律不进入子进程；缺省 PATH 取宿主（可注入便于测试）。 */
  hostPath?: string;
  defaultTimeoutMs?: number;
}

interface BoundedCapture {
  text: string;
  bytes: number;
  truncated: boolean;
}

function captureFrom(chunks: Buffer[], totalBytes: number, truncated: boolean): BoundedCapture {
  const buffer = Buffer.concat(chunks);
  return {
    text: buffer.subarray(0, 8192).toString("utf8"),
    bytes: totalBytes,
    truncated,
  };
}

/** 固定环境：白名单 + HOME/TMPDIR 重定向进输出目录（命令的隐式落盘都留在受控区）。 */
function confinedEnv(outputDir: string, hostPath: string): Record<string, string> {
  return {
    PATH: hostPath,
    HOME: join(outputDir, "home"),
    TMPDIR: join(outputDir, "tmp"),
    LANG: "C.UTF-8",
  };
}

export function createContinuousConfinedTestRunner(
  deps: CreateConfinedRunnerDeps,
): ContinuousConfinedTestRunner {
  const available = deps.isolation.verified;
  return {
    available,
    isolationKey: deps.isolation.key,
    async run(argv, options): Promise<ContinuousConfinedRunResult> {
      if (argv.length === 0 || argv.some((part) => part.length === 0)) {
        throw new Error("continuous confined run: empty argv part");
      }
      if (!available) {
        throw new Error("continuous confined run: isolation provider is not verified");
      }
      const startedAt = Date.now();
      const outputDir = join(deps.outputRoot, `t-${startedAt}-${Math.floor(Math.random() * 1e6)}`);
      await mkdir(join(outputDir, "home"), { recursive: true });
      await mkdir(join(outputDir, "tmp"), { recursive: true });
      const stdoutPath = join(outputDir, "stdout.txt");
      const stderrPath = join(outputDir, "stderr.txt");
      const executionReal = await realpath(deps.executionPath);
      const timeoutMs = options?.timeoutMs ?? deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error("continuous confined run: timeoutMs must be a positive integer");
      }
      // argv[0] 可能是命令名（PATH 解析）或绝对路径；spawn 直接交给 Node 解析，不经 shell。
      const wrapped = deps.isolation.wrap(argv, [executionReal, await realpath(outputDir)]);
      const env = confinedEnv(outputDir, deps.hostPath ?? process.env.PATH ?? "/usr/bin:/bin");
      const child = spawn(wrapped[0]!, wrapped.slice(1), {
        cwd: executionReal,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let streamTruncated = false;
      let settle!: (value: void) => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes <= STREAM_CAPTURE_BYTES) stdoutChunks.push(chunk);
        else streamTruncated = true;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes <= STREAM_CAPTURE_BYTES) stderrChunks.push(chunk);
        else streamTruncated = true;
      });
      let closeCode: number | null = null;
      let closed = false;
      let spawnError = false;
      child.once("close", (code) => {
        closeCode = code;
        closed = true;
        settle();
      });
      child.once("error", () => {
        spawnError = true;
        closed = true;
        settle();
      });
      /** 组信号杀树：SIGTERM → 宽限 → SIGKILL，然后等 close（停止证明：等整树退出）。 */
      const killTree = async (): Promise<void> => {
        const groupId = child.pid;
        if (groupId === undefined) return;
        const signalGroup = (signal: NodeJS.Signals) => {
          try {
            process.kill(-groupId, signal);
          } catch {
            try {
              child.kill(signal);
            } catch {
              /* 进程可能已退出。 */
            }
          }
        };
        signalGroup("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, SIGTERM_GRACE_MS));
        if (!closed) signalGroup("SIGKILL");
      };
      let timer: NodeJS.Timeout | undefined;
      let cancelReason: "timed_out" | "cancelled" | undefined;
      const onAbort = () => {
        if (closed || cancelReason !== undefined) return;
        cancelReason = "cancelled";
        void killTree();
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        if (closed || cancelReason !== undefined) return;
        cancelReason = "timed_out";
        void killTree();
      }, timeoutMs);
      timer.unref?.();
      try {
        await settled;
      } finally {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
      }
      const durationMs = Date.now() - startedAt;
      // 输出全量落盘（证据面），inline 只回传 8KB 尾部（报告有界）。
      const stdoutCapture = captureFrom(stdoutChunks, stdoutBytes, streamTruncated);
      const stderrCapture = captureFrom(stderrChunks, stderrBytes, streamTruncated);
      await writeFile(stdoutPath, Buffer.concat(stdoutChunks)).catch(() => undefined);
      await writeFile(stderrPath, Buffer.concat(stderrChunks)).catch(() => undefined);
      const exitCode = closeCode === null ? child.exitCode : closeCode;
      const status: ContinuousConfinedRunResult["status"] =
        cancelReason === "cancelled"
          ? "cancelled"
          : cancelReason === "timed_out"
            ? "timed_out"
            : spawnError
              ? "spawn_error"
              : exitCode === 0
                ? "completed"
                : "failed";
      return {
        status,
        ...(exitCode === null ? {} : { exitCode }),
        stdoutTail: stdoutCapture.text,
        stderrTail: stderrCapture.text,
        stdoutBytes: stdoutCapture.bytes,
        stderrBytes: stderrCapture.bytes,
        truncated: stdoutCapture.truncated || stderrCapture.truncated,
        outputDir,
        stdoutPath,
        stderrPath,
        startedAt,
        durationMs,
        isolationKey: deps.isolation.key,
      };
    },
  };
}
