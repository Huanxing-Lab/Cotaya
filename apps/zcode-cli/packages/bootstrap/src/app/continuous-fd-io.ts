// ============================================================
// Continuous 受检文件 IO（CT-11）：fd 绑定的检查-执行（TOCTOU 收敛）
// ============================================================
// 修复依据：docs/tickets/continuous-release-gaps.md CT-11 第 2 条——「文件检查后替换
// symlink 的竞态补充实际隔离证明与回归。静态 realpath 检查不能被描述成完整沙箱」。
// 旧实现（a0b128c 的 continuous-io-guards）是「检查 realpath → 等待准入 → 按路径委托
// 底层端口」，第二次准入等待是真实竞态窗口：期间把已检查文件替换为指向受保护文件的
// 符号链接，底层端口按路径读写会跟随链接（ct11-security.test.ts 的先失败用例实测泄露）。
//
// 本模块的收敛手段（如实声明边界，不宣称完整 OS 沙箱）：
//   1. 检查后以 O_NOFOLLOW 打开目标取得 fd——末段被换成符号链接时 open 直接 ELOOP；
//   2. inode 身份绑定：fstat(fd) 与当前 lstat(路径) 的 (dev,ino) 必须一致，且与检查期
//      捕获的身份一致——检查后到 open 前的任何替换（末段或中间目录换链）都会让 open
//      落到不同 inode，比较即失败；
//   3. 读写都发生在 fd 上：open 之后的替换不影响已握住的 inode；
//   4. 新建文件用 O_CREAT|O_EXCL 原子创建，创建后复核 realpath 落点仍在允许目录。
// 残余边界：动态文件系统（/proc 类）与「换走再换回同一 inode」的原子攻击不在证明范围，
// 需要操作系统级沙箱（CT-11 第 3 条隔离提供方）承担，本模块不冒充。
//
// 路径策略判定（Scope/forbidden/protected/角色/候选）仍在 continuous-execution-policy.ts
// 的纯函数里；本模块只保证「检查后的执行不脱离检查结论」。

import { lstat, open, realpath, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { FileSystemLineEndings, FileSystemTextEncoding } from "@zcode/contracts";
import { FileSystemPortError } from "@zcode/contracts";

import { constants } from "node:fs";

const FS = {
  O_RDONLY: constants.O_RDONLY ?? 0,
  O_RDWR: constants.O_RDWR ?? 2,
  O_WRONLY: constants.O_WRONLY ?? 1,
  O_CREAT: constants.O_CREAT ?? 512,
  O_EXCL: constants.O_EXCL ?? 2048,
  // win32 无 O_NOFOLLOW：常量缺席时置 0；该平台为 observe_only（不开放自主写入），
  // 读路径的身份绑定检查仍然有效（fstat/lstat 比较），不冒充 O_NOFOLLOW 已生效。
  O_NOFOLLOW: constants.O_NOFOLLOW ?? 0,
} as const;

export interface CheckedTargetIdentity {
  dev: number;
  ino: number;
}

/** 统一拒绝：路径操作沿用 FileSystemPortError + scope_denied 语义（与 io-guards 一致）。 */
export function denyFile(reason: string): never {
  throw new FileSystemPortError({
    code: "permission_denied",
    message: `continuous scope_denied: ${reason}`,
  });
}

function errnoOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? (error as { code?: string }).code : undefined;
}

/** 把底层 IO 错误折算成端口错误形态（与 node fs 适配器的语义对齐，ENOENT → not_found）。 */
export function toPortError(error: unknown, path: string): FileSystemPortError {
  if (error instanceof FileSystemPortError) return error;
  const code = errnoOf(error);
  if (code === "ENOENT") {
    return new FileSystemPortError({ code: "not_found", path, message: `No such file: ${path}` });
  }
  if (code === "ELOOP") {
    return new FileSystemPortError({
      code: "permission_denied",
      path,
      message: "continuous scope_denied: symlink_escape (O_NOFOLLOW)",
    });
  }
  const mapped =
    code === "EISDIR"
      ? "is_directory"
      : code === "ENOTDIR"
        ? "not_file"
        : code === "EACCES" || code === "EPERM"
          ? "permission_denied"
          : "io_error";
  return new FileSystemPortError({
    code: mapped,
    path,
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

/** 检查期捕获的目标身份（lstat）；open 后必须仍然指向同一 inode 才允许 IO。 */
export async function lstatIdentity(
  absolutePath: string,
): Promise<CheckedTargetIdentity | undefined> {
  const info = await lstat(absolutePath).catch(() => undefined);
  return info === undefined ? undefined : { dev: info.dev, ino: info.ino };
}

function sameInode(left: CheckedTargetIdentity, right: CheckedTargetIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * 以 O_NOFOLLOW 打开已检查的既有文件并验证 inode 绑定。
 * 拒绝条件（任一即 symlink_escape）：
 *   - open ELOOP（末段在检查后成为符号链接）；
 *   - fstat(fd) 与当前 lstat(路径) 不一致（open 拿到的不是路径现在指向的 inode——
 *     中间目录被换链或末段被替换后又被删除等）；
 *   - 与检查期身份 checkedIdentity 不一致（检查后到 open 前被替换）。
 * 调用方在返回的 handle 上完成全部读写；不再按路径二次打开。
 */
export async function openCheckedExisting(
  absolutePath: string,
  checkedIdentity: CheckedTargetIdentity | undefined,
  mode: "read" | "overwrite",
): Promise<{ handle: FileHandle; sizeBytes: number; mtimeMs: number }> {
  const flags = (mode === "read" ? FS.O_RDONLY : FS.O_RDWR) | FS.O_NOFOLLOW;
  const handle = await open(absolutePath, flags).catch((error: unknown) => {
    if (errnoOf(error) === "ELOOP") denyFile("symlink_escape (O_NOFOLLOW)");
    throw toPortError(error, absolutePath);
  });
  try {
    const [fdStat, pathStat] = await Promise.all([handle.stat(), lstat(absolutePath)]);
    if (pathStat.isSymbolicLink()) denyFile("symlink_escape (path is now a symlink)");
    const currentIdentity = { dev: pathStat.dev, ino: pathStat.ino };
    if (!sameInode({ dev: fdStat.dev, ino: fdStat.ino }, currentIdentity)) {
      denyFile("symlink_escape (opened inode differs from path)");
    }
    if (checkedIdentity !== undefined && !sameInode(checkedIdentity, currentIdentity)) {
      denyFile("symlink_escape (identity changed after check)");
    }
    if (pathStat.isDirectory()) {
      throw new FileSystemPortError({
        code: "is_directory",
        path: absolutePath,
        message: `Cannot read directory as file: ${absolutePath}`,
      });
    }
    return { handle, sizeBytes: pathStat.size, mtimeMs: pathStat.mtimeMs };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * O_EXCL 原子新建：路径在检查后出现（含被换成符号链接，O_NOFOLLOW+ELOOP 兜底）时拒绝；
 * 创建成功后复核 realpath 落点在期望目录内（防中间目录被换链把文件建到界外，越界即回滚）。
 */
export async function createCheckedExclusive(
  absolutePath: string,
  expectedDirectoryRealPath: string,
): Promise<FileHandle> {
  const flags = FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW;
  const handle = await open(absolutePath, flags).catch((error: unknown) => {
    if (errnoOf(error) === "ELOOP") denyFile("symlink_escape (O_NOFOLLOW)");
    throw toPortError(error, absolutePath);
  });
  const landed = dirnameOf(await realpath(absolutePath).catch(() => absolutePath));
  if (landed !== expectedDirectoryRealPath) {
    await handle.close().catch(() => undefined);
    await unlink(absolutePath).catch(() => undefined);
    denyFile("symlink_escape (created outside allowed directory)");
  }
  return handle;
}

function dirnameOf(path: string): string {
  const index = path.lastIndexOf("/");
  if (index <= 0) return index === 0 ? "/" : path;
  return path.slice(0, index);
}

// ── 文本编解码（与 adapters/fs 私有实现同语义；公开入口未导出这些助手，故本地实现）──

function shouldNormalize(encoding: FileSystemTextEncoding): boolean {
  return (
    encoding === "utf8" || encoding === "utf-8" || encoding === "ascii" || encoding === "latin1"
  );
}

function detectLineEndings(content: string): FileSystemLineEndings {
  return content.includes("\r\n") ? "CRLF" : "LF";
}

/**
 * 文本解码：BufferEncoding 直接走 Buffer；gb* 系（contracts 词表含、Buffer 不支持）
 * 经 TextDecoder（Node 自带 full ICU）；TextDecoder 也不认得时如实拒绝（v1 边界，
 * 不静默按 utf8 误解码）。
 */
function decodeBytes(buffer: Buffer, encoding: FileSystemTextEncoding): string {
  const isBufferEncoding =
    /^utf8$|utf-8|ascii|latin1|hex|base64|base64url|binary|utf16le|utf-16le|ucs2|ucs-2/.test(
      encoding,
    );
  if (isBufferEncoding)
    return buffer.toString(encoding === "utf-8" ? "utf8" : (encoding as BufferEncoding));
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    denyFile(`unsupported_encoding ${encoding}`);
  }
}

/** 写侧编码只接受 BufferEncoding（gb* 写入是 v1 边界，如实拒绝）。 */
function encodeBytes(content: string, encoding: FileSystemTextEncoding | undefined): Buffer {
  const resolved = encoding ?? "utf8";
  if (
    resolved === "utf8" ||
    resolved === "utf-8" ||
    resolved === "ascii" ||
    resolved === "latin1"
  ) {
    return Buffer.from(content, resolved === "utf-8" ? "utf8" : (resolved as BufferEncoding));
  }
  try {
    return Buffer.from(content, resolved as BufferEncoding);
  } catch {
    denyFile(`unsupported_encoding_write ${resolved}`);
  }
}

export interface CheckedReadTextResult {
  content: string;
  encoding: FileSystemTextEncoding;
  lineEndings?: FileSystemLineEndings;
  bytesRead: number;
}

/**
 * 文本读取（端口语义与 node fs 适配器对齐）：maxBytes 超限时**截断**（truncated 由调用方
 * 标记），不像 binary 读取那样抛 too_large。
 */
export async function readTextViaHandle(
  handle: FileHandle,
  sizeBytes: number,
  encoding: FileSystemTextEncoding | undefined,
  maxBytes?: number,
): Promise<CheckedReadTextResult> {
  try {
    let buffer: Buffer;
    if (maxBytes !== undefined && sizeBytes > maxBytes) {
      const bounded = Buffer.alloc(maxBytes);
      const result = await handle.read(bounded, 0, maxBytes, 0);
      buffer = bounded.subarray(0, result.bytesRead);
    } else {
      buffer = await handle.readFile();
    }
    const resolved: FileSystemTextEncoding = encoding ?? "utf8";
    const raw = decodeBytes(buffer, resolved);
    const normalize = shouldNormalize(resolved);
    const lineEndings = normalize ? detectLineEndings(raw) : undefined;
    const content = normalize ? raw.replace(/\r\n/g, "\n") : raw;
    return {
      content,
      encoding: resolved,
      ...(lineEndings === undefined ? {} : { lineEndings }),
      bytesRead: buffer.byteLength,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readBinaryViaHandle(
  handle: FileHandle,
  sizeBytes: number,
  maxBytes?: number,
): Promise<{ content: Uint8Array; bytesRead: number }> {
  try {
    if (maxBytes !== undefined && sizeBytes > maxBytes) {
      throw new FileSystemPortError({
        code: "too_large",
        message: `File content exceeds maximum allowed size (${maxBytes}).`,
      });
    }
    const buffer = await handle.readFile();
    return { content: buffer, bytesRead: buffer.byteLength };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** 覆写已持有 handle 的文件（truncate 后写入；handle 已通过身份绑定）。 */
export async function overwriteViaHandle(
  handle: FileHandle,
  content: string,
  encoding: FileSystemTextEncoding | undefined,
  lineEndings?: FileSystemLineEndings,
): Promise<{ bytesWritten: number }> {
  try {
    await handle.truncate();
    const resolved: FileSystemTextEncoding = encoding ?? "utf8";
    const withEndings = lineEndings === "CRLF" ? content.split("\n").join("\r\n") : content;
    const buffer = encodeBytes(withEndings, resolved);
    await handle.write(buffer, 0, buffer.byteLength, 0);
    return { bytesWritten: buffer.byteLength };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * removeFile 的受检执行：unlink 不跟随符号链接（删除链接本身而非目标），因此只需在
 * 删除前确认当前末段不是符号链接、且 inode 仍是检查时那个——防止删掉「检查后才被
 * 攻击者放上的」条目。
 */
export async function unlinkChecked(
  absolutePath: string,
  checkedIdentity: CheckedTargetIdentity | undefined,
): Promise<{ removed: boolean }> {
  const current = await lstatIdentity(absolutePath);
  if (current === undefined) return { removed: false };
  if (await lstat(absolutePath).then((info) => info.isSymbolicLink())) {
    denyFile("symlink_escape (refusing to delete a symlink)");
  }
  if (checkedIdentity !== undefined && !sameInode(checkedIdentity, current)) {
    denyFile("symlink_escape (identity changed after check)");
  }
  await unlink(absolutePath);
  return { removed: true };
}
