// ============================================================
// Continuous 受管 actor IO 端口（CT-02 执行点；CT-11 重写）
// ============================================================
// 范围限制落在实际 IO 端口，不能只写在 actor 提示词里。CT-11 的三处升级：
//   1. 文件读写改为 fd 绑定执行（continuous-fd-io）：检查 realpath → 准入 → O_NOFOLLOW
//      打开 + inode 绑定 → 在 fd 上读写。检查后替换 symlink 的竞态被实际拒绝
//      （ct11-security.test.ts 回归），不再是「静态 realpath 检查」；
//   2. listDirectory/searchFiles/searchText 由 continuous-search 提供受限递归实现：
//      逐个实际目标检查 Scope/forbidden/protected/链接目标，不能先读全目录再过滤文件名；
//      上级目录只用于导航；
//   3. executionPort：受管 world 端口分派可信工具命令（continuous-test/-diff/-browser/
//      -commit，见 continuous-trusted-ports）；声明测试命令经 continuous-confined-execution
//      受控执行（固定 cwd/环境/超时/输出/取消 + 已自证的隔离提供方）；其余（shell 形态、
//      未声明 argv、任意 git、缺隔离实现的任何命令）一律拒绝——request.sandbox.enabled
//      之类的请求侧声称不构成证明。
//
// 文件端口不再委托底层适配器：受检执行全部由本守卫自己完成（这就是竞态收敛点）。
// 底层 fileSystemPort/executionPort 参数因此从本函数移除（a0b128c 时代的委托面）。

import { realpath as fsRealpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExecutionPort, ExecutionResult, FileSystemPort } from "@zcode/contracts";
import { FileSystemPortError } from "@zcode/contracts";
import {
  checkContinuousFilePath,
  checkContinuousShellCommand,
  type ContinuousActorRole,
  type ContinuousExecutionPolicyConfig,
} from "./continuous-execution-policy.js";
import {
  createCheckedExclusive,
  denyFile,
  lstatIdentity,
  openCheckedExisting,
  overwriteViaHandle,
  readBinaryViaHandle,
  readTextViaHandle,
  toPortError,
  unlinkChecked,
} from "./continuous-fd-io.js";
import {
  listDirectoryRestricted,
  searchTextRestricted,
  walkRestricted,
} from "./continuous-search.js";
import type { ContinuousTrustedDispatch } from "./continuous-trusted-ports.js";
import type { ContinuousConfinedTestRunner } from "./continuous-confined-execution.js";

export interface ContinuousActorIoPolicy {
  role: ContinuousActorRole;
  /** 每次操作重新读取当前候选授权，决策 defer 撤权立即生效。 */
  config(): ContinuousExecutionPolicyConfig;
  /** 与模型闸门共享准入；暂停等待、撤销取消，不能用 yolo 绕过。 */
  waitForAdmission(signal?: AbortSignal): Promise<void>;
}

export interface ContinuousIoGuardExtras {
  /**
   * 受管 world 端口的可信工具命令分派（continuous-test/-diff/-browser/-commit）。
   * 只应注入 world 端口（模板骨架面）；actor 端口不注入——actor 无 Git 写能力。
   */
  trusted?: ContinuousTrustedDispatch;
  /**
   * 声明测试命令的受控执行 runner。缺席/隔离未自证时对一切进程执行返回
   * confined_execution_not_supported（CT-11 第 3 条的缺省面）。
   */
  testRunner?: ContinuousConfinedTestRunner;
}

async function existingRealPath(path: string): Promise<string> {
  try {
    return await fsRealpath(path);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT")
    )
      throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await existingRealPath(parent), basename(path));
  }
}

export function guardContinuousActorIo(
  policy: ContinuousActorIoPolicy,
  extras: ContinuousIoGuardExtras = {},
): { fileSystemPort: FileSystemPort; executionPort: ExecutionPort } {
  const deny = (reason: string): never => {
    throw new FileSystemPortError({
      code: "permission_denied",
      message: `continuous scope_denied: ${reason}`,
    });
  };
  const searchDeps = { config: () => policy.config(), role: policy.role };
  /**
   * 单文件操作的完整检查链（词法 → realpath/链接目标 → 准入 → 最新授权复查）。
   * 返回检查结论与检查期 inode 身份；执行侧（fd 打开/写/删）据此绑定身份——
   * 检查与执行之间任何替换都会在执行侧被拒（continuous-fd-io）。
   */
  const checked = async (
    path: string,
    operation: "read" | "write" | "delete",
    signal?: AbortSignal,
  ): Promise<{
    absolute: string;
    identity: { dev: number; ino: number } | undefined;
    canonicalDirectoryReal: string;
  }> => {
    await policy.waitForAdmission(signal);
    signal?.throwIfAborted();
    const config = policy.config();
    const lexical = checkContinuousFilePath(config, { role: policy.role, operation, path });
    if (!lexical.allowed) deny(lexical.reason ?? "invalid_path");
    const absolute = isAbsolute(path) ? path : resolve(config.executionPath, path);
    const resolvedRealPath = await existingRealPath(absolute);
    const canonicalExecutionPath = await fsRealpath(config.executionPath);
    const canonicalPath = resolve(canonicalExecutionPath, relative(config.executionPath, absolute));
    const physical = checkContinuousFilePath(
      { ...config, executionPath: canonicalExecutionPath },
      { role: policy.role, operation, path: canonicalPath, resolvedRealPath },
    );
    if (!physical.allowed) deny(physical.reason ?? "symlink_escape");
    // 已存在文件的链接目标也必须在允许路径内，不能从允许目录链接到受保护文件。
    if (resolvedRealPath !== canonicalPath) {
      const target = checkContinuousFilePath(
        { ...config, executionPath: canonicalExecutionPath },
        { role: policy.role, operation, path: resolvedRealPath },
      );
      if (!target.allowed) deny(target.reason ?? "symlink_escape");
    }
    // 检查期间候选可能被撤权/暂停：回到最新授权再次检查并等待准入——这同时是
    // 竞态窗口的边界，之后的执行全部绑定此刻之后的 inode 身份（fd-io）。
    await policy.waitForAdmission(signal);
    signal?.throwIfAborted();
    const latest = checkContinuousFilePath(policy.config(), { role: policy.role, operation, path });
    if (!latest.allowed) deny(latest.reason ?? "candidate_inactive");
    const identity = await lstatIdentity(canonicalPath).catch(() => undefined);
    return {
      absolute: canonicalPath,
      identity,
      canonicalDirectoryReal: await existingRealPath(dirname(canonicalPath)),
    };
  };

  /** 目标内容读取（受限搜索复用的受检读：完整检查链 + fd 绑定）。 */
  const readTargetContent = async (absolutePath: string): Promise<string | null> => {
    try {
      const target = await checked(absolutePath, "read");
      const opened = await openCheckedExisting(target.absolute, target.identity, "read");
      const text = await readTextViaHandle(opened.handle, opened.sizeBytes, "utf8");
      return text.content;
    } catch {
      return null;
    }
  };

  const fs: FileSystemPort = {
    async createDirectory(request, options) {
      const target = await checked(request.path, "write", options?.signal);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(target.absolute, { recursive: false }).catch(async (error: unknown) => {
        const code =
          error instanceof Error && "code" in error ? (error as { code?: string }).code : undefined;
        if (code === "EEXIST") {
          const { lstat } = await import("node:fs/promises");
          const info = await lstat(target.absolute).catch(() => undefined);
          if (info?.isSymbolicLink())
            denyFile("symlink_escape (directory path replaced by symlink)");
          return;
        }
        throw toPortError(error, target.absolute);
      });
      return { path: target.absolute };
    },
    async stat(request, options) {
      const target = await checked(request.path, "read", options?.signal);
      const { lstat } = await import("node:fs/promises");
      // 符号链接按其目标 stat（与读语义一致：目标已在上面的链接检查里核对）。
      const statPath =
        target.identity === undefined
          ? target.absolute
          : (await lstat(target.absolute).catch(() => undefined))?.isSymbolicLink()
            ? await existingRealPath(target.absolute)
            : target.absolute;
      const info = await lstat(statPath).catch(() => undefined);
      if (info === undefined) {
        throw new FileSystemPortError({
          code: "not_found",
          path: target.absolute,
          message: `No such file: ${target.absolute}`,
        });
      }
      return {
        path: target.absolute,
        kind: info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "file",
        sizeBytes: info.size,
        ...(Number.isFinite(info.mtimeMs) ? { mtimeMs: info.mtimeMs } : {}),
      };
    },
    async readTextFile(request, options) {
      const target = await checked(request.path, "read", options?.signal);
      const opened = await openCheckedExisting(target.absolute, target.identity, "read");
      const text = await readTextViaHandle(
        opened.handle,
        opened.sizeBytes,
        request.encoding,
        request.maxBytes,
      );
      return {
        path: target.absolute,
        content: text.content,
        encoding: text.encoding,
        ...(text.lineEndings === undefined ? {} : { lineEndings: text.lineEndings }),
        bytesRead: text.bytesRead,
        sizeBytes: opened.sizeBytes,
        truncated: request.maxBytes !== undefined && opened.sizeBytes > request.maxBytes,
      };
    },
    async readBinaryFile(request, options) {
      const target = await checked(request.path, "read", options?.signal);
      const opened = await openCheckedExisting(target.absolute, target.identity, "read");
      const binary = await readBinaryViaHandle(opened.handle, opened.sizeBytes, request.maxBytes);
      return {
        path: target.absolute,
        content: binary.content,
        bytesRead: binary.bytesRead,
        sizeBytes: opened.sizeBytes,
      };
    },
    async readTextFileRange(request, options) {
      const target = await checked(request.path, "read", options?.signal);
      const opened = await openCheckedExisting(target.absolute, target.identity, "read");
      const text = await readTextViaHandle(
        opened.handle,
        opened.sizeBytes,
        request.encoding,
        request.maxBytes,
      );
      const lines = text.content.split("\n");
      const offset = request.offsetLine ?? 0;
      const limit = request.limitLines ?? Math.max(0, lines.length - offset);
      const selected = lines.slice(offset, offset + limit);
      return {
        path: target.absolute,
        content: selected.join("\n"),
        encoding: text.encoding,
        ...(text.lineEndings === undefined ? {} : { lineEndings: text.lineEndings }),
        bytesRead: text.bytesRead,
        sizeBytes: opened.sizeBytes,
        truncated: false,
        startLine: offset + 1,
        lineCount: selected.length,
        totalLines: lines.length,
      };
    },
    async writeTextFile(request, options) {
      const target = await checked(request.path, "write", options?.signal);
      if (target.identity === undefined) {
        // 新建：O_EXCL 原子创建 + 落点复核（父目录换链会让创建落到界外，回滚并拒绝）。
        const handle = await createCheckedExclusive(target.absolute, target.canonicalDirectoryReal);
        const result = await overwriteViaHandle(
          handle,
          request.content,
          request.encoding,
          request.lineEndings,
        );
        return { path: target.absolute, bytesWritten: result.bytesWritten };
      }
      const opened = await openCheckedExisting(target.absolute, target.identity, "overwrite");
      const result = await overwriteViaHandle(
        opened.handle,
        request.content,
        request.encoding,
        request.lineEndings,
      );
      return { path: target.absolute, bytesWritten: result.bytesWritten };
    },
    async removeFile(request, options) {
      const target = await checked(request.path, "delete", options?.signal);
      const result = await unlinkChecked(target.absolute, target.identity);
      return { path: target.absolute, removed: result.removed };
    },
    async listDirectory(request, options) {
      options?.signal?.throwIfAborted();
      await policy.waitForAdmission(options?.signal);
      const startedAt = Date.now();
      const entries = await listDirectoryRestricted(
        searchDeps,
        resolve(policy.config().executionPath, request.path),
      );
      return {
        durationMs: Math.max(0, Date.now() - startedAt),
        entries,
        numEntries: entries.length,
        path: request.path,
      };
    },
    async searchFiles(request, options) {
      options?.signal?.throwIfAborted();
      await policy.waitForAdmission(options?.signal);
      const startedAt = Date.now();
      const root = isAbsolute(request.path)
        ? request.path
        : resolve(policy.config().executionPath, request.path);
      const walked = await walkRestricted(searchDeps, root, {
        pattern: request.pattern,
        maxResults: request.maxResults ?? 100,
        signal: options?.signal,
      });
      return {
        path: root,
        pattern: request.pattern,
        durationMs: Math.max(0, Date.now() - startedAt),
        files: walked.entries.map((entry) => entry.absolutePath),
        numFiles: walked.entries.length,
        truncated: walked.truncated,
      };
    },
    async searchText(request, options) {
      options?.signal?.throwIfAborted();
      await policy.waitForAdmission(options?.signal);
      const startedAt = Date.now();
      const root = isAbsolute(request.path)
        ? request.path
        : resolve(policy.config().executionPath, request.path);
      const result = await searchTextRestricted(
        searchDeps,
        {
          path: root,
          pattern: request.pattern,
          ...(request.glob === undefined ? {} : { glob: request.glob }),
          ...(request.ignoreCase === undefined ? {} : { ignoreCase: request.ignoreCase }),
          ...(request.headLimit === undefined ? {} : { headLimit: request.headLimit }),
          outputMode: request.outputMode ?? "content",
        },
        readTargetContent,
      );
      return {
        path: root,
        pattern: request.pattern,
        mode: request.outputMode ?? "content",
        durationMs: Math.max(0, Date.now() - startedAt),
        files: result.files,
        entries: result.entries.map((entry) => ({
          path: entry.path,
          ...(entry.lineNumber === undefined ? {} : { lineNumber: entry.lineNumber }),
          ...(entry.text === undefined ? {} : { text: entry.text }),
          ...(entry.count === undefined ? {} : { count: entry.count }),
        })),
        numMatches: result.numMatches,
        truncated: result.truncated,
      };
    },
  };

  const executionPort: ExecutionPort = {
    run: async (request, options): Promise<ExecutionResult> => {
      await policy.waitForAdmission(options?.signal);
      options?.signal?.throwIfAborted();
      if (request.command.mode !== "argv") deny("shell_not_supported");
      const command = request.command;
      if (command.mode !== "argv") throw new Error("unreachable");
      const argv = [command.file, ...(command.args ?? [])];
      const config = policy.config();
      // 可信工具命令（仅受管 world 端口注入了 trusted 时可达；actor 端口恒缺）。
      if (extras.trusted !== undefined && extras.trusted.isTrustedCommand(command.file)) {
        return await extras.trusted.run(command, options);
      }
      // 声明测试命令：策略判定（角色/平台/mutating git/精确声明匹配）+ 受控执行。
      const decision = checkContinuousShellCommand(config, { role: policy.role, argv });
      if (!decision.allowed) deny(decision.reason ?? "undeclared_command");
      if (request.cwd !== undefined && resolve(request.cwd) !== resolve(config.executionPath)) {
        deny("outside_execution_path");
      }
      const runner = extras.testRunner;
      if (runner === undefined || !runner.available) {
        // 缺少可信隔离实现：继续返回不可用。request.sandbox.enabled 之类的请求侧
        // 声称不构成证明（CT-11 第 3 条）。
        throw new FileSystemPortError({
          code: "permission_denied",
          message: "continuous scope_denied: confined_execution_not_supported",
        });
      }
      const result = await runner.run(argv, {
        signal: options?.signal,
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      });
      // 输出全量文件恒落盘（证据面），artifactPath 指向该文件（与 bytes 无关）。
      const streamOf = (text: string, bytes: number, artifactPath: string) => ({
        text,
        bytes,
        truncated: result.truncated,
        artifactPath,
      });
      return {
        status: result.status,
        ...(result.exitCode === undefined || result.exitCode === null
          ? {}
          : { exitCode: result.exitCode }),
        stdout: streamOf(result.stdoutTail, result.stdoutBytes, result.stdoutPath),
        stderr: streamOf(result.stderrTail, result.stderrBytes, result.stderrPath),
        durationMs: result.durationMs,
        timedOut: result.status === "timed_out",
        cancelled: result.status === "cancelled",
        startedAt: new Date(result.startedAt),
        completedAt: new Date(result.startedAt + result.durationMs),
      };
    },
  };

  return { fileSystemPort: fs, executionPort };
}

export function continuousActorToolAllowlist(role: ContinuousActorRole): string[] {
  return role === "builder"
    ? ["Read", "Write", "Edit", "submit_result", "escalate"]
    : ["Read", "submit_result", "escalate"];
}
