// 范围限制落在实际 IO 端口，不能只写在 actor 提示词里。未实现的递归/后台能力拒绝调用。
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { FileSystemPortError, type ExecutionPort, type FileSystemPort } from "@zcode/contracts";
import {
  checkContinuousFilePath,
  checkContinuousShellCommand,
  type ContinuousActorRole,
  type ContinuousExecutionPolicyConfig,
} from "./continuous-execution-policy.js";

export interface ContinuousActorIoPolicy {
  role: ContinuousActorRole;
  /** 每次操作重新读取当前候选授权，决策 defer 撤权立即生效。 */
  config(): ContinuousExecutionPolicyConfig;
  /** 与模型闸门共享准入；暂停等待、撤销取消，不能用 yolo 绕过。 */
  waitForAdmission(signal?: AbortSignal): Promise<void>;
}

async function existingRealPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await existingRealPath(parent), basename(path));
  }
}

export function guardContinuousActorIo(
  policy: ContinuousActorIoPolicy,
  ports: { fileSystemPort: FileSystemPort; executionPort: ExecutionPort },
): typeof ports {
  const deny = (reason: string): never => {
    throw new FileSystemPortError({
      code: "permission_denied",
      message: `continuous scope_denied: ${reason}`,
    });
  };
  const checked = async (
    path: string,
    operation: "read" | "write" | "delete",
    signal?: AbortSignal,
  ) => {
    await policy.waitForAdmission(signal);
    signal?.throwIfAborted();
    const config = policy.config();
    const lexical = checkContinuousFilePath(config, { role: policy.role, operation, path });
    if (!lexical.allowed) deny(lexical.reason ?? "invalid_path");
    const absolute = isAbsolute(path) ? path : resolve(config.executionPath, path);
    const resolvedRealPath = await existingRealPath(absolute);
    const canonicalConfig = { ...config, executionPath: await realpath(config.executionPath) };
    const canonicalPath = resolve(
      canonicalConfig.executionPath,
      relative(config.executionPath, absolute),
    );
    const physical = checkContinuousFilePath(canonicalConfig, {
      role: policy.role,
      operation,
      path: canonicalPath,
      resolvedRealPath,
    });
    if (!physical.allowed) deny(physical.reason ?? "symlink_escape");
    // 已存在文件的链接目标也必须在允许路径内，不能从允许目录链接到受保护文件。
    if (resolvedRealPath !== canonicalPath) {
      const target = checkContinuousFilePath(canonicalConfig, {
        role: policy.role,
        operation,
        path: resolvedRealPath,
      });
      if (!target.allowed) deny(target.reason ?? "symlink_escape");
    }
    // 检查期间候选可能被撤权；回到最新授权再次检查，才转交真正 IO。
    await policy.waitForAdmission(signal);
    const latest = checkContinuousFilePath(policy.config(), { role: policy.role, operation, path });
    if (!latest.allowed) deny(latest.reason ?? "candidate_inactive");
    return absolute;
  };
  const fs = ports.fileSystemPort;
  return {
    fileSystemPort: {
      createDirectory: async (r, o) =>
        fs.createDirectory({ ...r, path: await checked(r.path, "write", o?.signal) }, o),
      stat: async (r, o) => fs.stat({ ...r, path: await checked(r.path, "read", o?.signal) }, o),
      readTextFile: async (r, o) =>
        fs.readTextFile({ ...r, path: await checked(r.path, "read", o?.signal) }, o),
      readBinaryFile: async (r, o) =>
        fs.readBinaryFile({ ...r, path: await checked(r.path, "read", o?.signal) }, o),
      readTextFileRange: async (r, o) =>
        fs.readTextFileRange({ ...r, path: await checked(r.path, "read", o?.signal) }, o),
      writeTextFile: async (r, o) =>
        fs.writeTextFile({ ...r, path: await checked(r.path, "write", o?.signal) }, o),
      removeFile: async (r, o) =>
        fs.removeFile({ ...r, path: await checked(r.path, "delete", o?.signal) }, o),
      listDirectory: async () => deny("recursive_read_not_supported"),
      searchFiles: async () => deny("recursive_read_not_supported"),
      searchText: async () => deny("recursive_read_not_supported"),
    },
    executionPort: {
      run: async (request, options) => {
        await policy.waitForAdmission(options?.signal);
        const config = policy.config();
        if (request.command.mode !== "argv") deny("shell_not_supported");
        const command = request.command;
        if (command.mode !== "argv") throw new Error("unreachable");
        const decision = checkContinuousShellCommand(config, {
          role: policy.role,
          argv: [command.file, ...(command.args ?? [])],
        });
        if (!decision.allowed) deny(decision.reason ?? "undeclared_command");
        if (resolve(request.cwd ?? config.executionPath) !== resolve(config.executionPath))
          deny("outside_execution_path");
        // 声明 argv 不能限制命令内部副作用；没有真实沙箱证明时不能启动进程。
        return deny("confined_execution_not_supported");
      },
    },
  };
}

export function continuousActorToolAllowlist(role: ContinuousActorRole): string[] {
  return role === "builder"
    ? ["Read", "Write", "Edit", "submit_result", "escalate"]
    : ["Read", "submit_result", "escalate"];
}
