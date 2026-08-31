"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WINDOWS_ALLOWED_WRITERS = new Set([
  "S-1-5-18",
  "S-1-5-32-544",
]);

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function createSecureStateStore({
  platform = process.platform,
  home = os.homedir(),
  currentUid = typeof process.getuid === "function" ? process.getuid() : null,
  currentSid = "",
  pid = process.pid,
  processIdentity = `${process.pid}-${crypto.randomUUID()}`,
  isProcessAlive = defaultProcessAlive,
  inspectWindowsAcl,
  hardenWindowsAcl,
} = {}) {
  const resolvedHome = path.resolve(home);

  function assertInsideHome(targetPath, label = "状态路径") {
    const resolved = path.resolve(targetPath);
    const relative = path.relative(resolvedHome, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`${label}必须位于当前用户目录：${resolved}`);
    }
    return resolved;
  }

  function inspectPosixPath(targetPath, expectedKind) {
    const info = fs.lstatSync(targetPath);
    if (info.isSymbolicLink()) throw new Error(`拒绝使用符号链接状态路径：${targetPath}`);
    if (expectedKind === "file" && !info.isFile()) {
      throw new Error(`状态路径不是普通文件：${targetPath}`);
    }
    if (expectedKind === "directory" && !info.isDirectory()) {
      throw new Error(`状态路径不是目录：${targetPath}`);
    }
    if (currentUid !== null && info.uid !== currentUid) {
      throw new Error(`状态路径不属于当前用户：${targetPath}`);
    }
    const expectedMode = expectedKind === "file" ? 0o600 : 0o700;
    if ((info.mode & 0o777) !== expectedMode) {
      const displayMode = expectedMode.toString(8).padStart(4, "0");
      throw new Error(`状态${expectedKind === "file" ? "文件" : "目录"}权限必须为 ${displayMode}：${targetPath}`);
    }
  }

  function inspectWindowsPath(targetPath, expectedKind, { externalSource = false } = {}) {
    const info = fs.lstatSync(targetPath);
    if (info.isSymbolicLink()) throw new Error(`拒绝使用 Windows reparse point：${targetPath}`);
    if (expectedKind === "file" && !info.isFile()) {
      throw new Error(`状态路径不是普通文件：${targetPath}`);
    }
    if (expectedKind === "directory" && !info.isDirectory()) {
      throw new Error(`状态路径不是目录：${targetPath}`);
    }
    if (typeof inspectWindowsAcl !== "function" || !currentSid) {
      throw new Error("Windows 安全状态需要 ACL inspector 和当前用户 SID");
    }
    const acl = inspectWindowsAcl(targetPath, expectedKind, { externalSource });
    if (!acl || acl.reparsePoint) {
      throw new Error(`拒绝使用 Windows reparse point：${targetPath}`);
    }
    if (String(acl.ownerSid || "").toUpperCase() !== currentSid.toUpperCase()) {
      throw new Error(`Windows 状态路径 owner 不匹配：${targetPath}`);
    }
    const allowedWriters = new Set([...WINDOWS_ALLOWED_WRITERS, currentSid.toUpperCase()]);
    if (!Array.isArray(acl.writableSids) || !Array.isArray(acl.readableSids)) {
      throw new Error(`Windows 状态 ACL inspector 缺少读写主体信息：${targetPath}`);
    }
    const unsafeWriter = acl.writableSids
      .map((sid) => String(sid).toUpperCase())
      .find((sid) => !allowedWriters.has(sid));
    if (unsafeWriter) {
      throw new Error(`Windows 状态 ACL 允许 Everyone/Users 或其他普通用户写入：${targetPath}`);
    }
    const unsafeReader = acl.readableSids
      .map((sid) => String(sid).toUpperCase())
      .find((sid) => !allowedWriters.has(sid));
    if (unsafeReader) {
      throw new Error(`Windows 状态 ACL 允许 Everyone/Users 或其他普通用户读取：${targetPath}`);
    }
    return acl;
  }

  function inspectProtectedPath(targetPath, expectedKind) {
    if (platform === "win32") inspectWindowsPath(targetPath, expectedKind);
    else inspectPosixPath(targetPath, expectedKind);
  }

  function harden(targetPath, expectedKind) {
    if (platform === "win32") {
      if (typeof hardenWindowsAcl !== "function") {
        throw new Error("Windows 安全状态需要 ACL hardener");
      }
      hardenWindowsAcl(targetPath, expectedKind);
    } else {
      fs.chmodSync(targetPath, expectedKind === "file" ? 0o600 : 0o700);
    }
    inspectProtectedPath(targetPath, expectedKind);
  }

  function ensurePrivateDirectory(directory) {
    const target = assertInsideHome(directory, "状态目录");
    const relative = path.relative(resolvedHome, target);
    let current = resolvedHome;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
      harden(current, "directory");
    }
    return target;
  }

  function assertProtectedRegularFile(filePath) {
    const target = assertInsideHome(filePath, "状态文件");
    inspectProtectedPath(target, "file");
    return target;
  }

  function assertSafeExternalRegularFile(filePath) {
    const target = path.resolve(filePath);
    if (platform === "win32") {
      const acl = inspectWindowsPath(target, "file", { externalSource: true });
      return { path: target, ...acl };
    }
    inspectPosixPath(target, "file");
    return { path: target };
  }

  function protectRegularFile(filePath) {
    const target = assertInsideHome(filePath, "状态文件");
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink()) {
      throw new Error(`${platform === "win32" ? "拒绝使用 Windows reparse point" : "拒绝使用符号链接状态路径"}：${target}`);
    }
    if (!info.isFile()) throw new Error(`状态路径不是普通文件：${target}`);
    harden(target, "file");
    return target;
  }

  function atomicWriteJson(filePath, value) {
    const target = assertInsideHome(filePath, "状态文件");
    const directory = ensurePrivateDirectory(path.dirname(target));
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
      throw new Error(`拒绝覆盖符号链接状态文件：${target}`);
    }
    const temporary = path.join(
      directory,
      `.${path.basename(target)}.${pid}.${crypto.randomBytes(6).toString("hex")}`
    );
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      harden(temporary, "file");
      fs.renameSync(temporary, target);
      harden(target, "file");
      if (platform !== "win32") {
        const directoryFd = fs.openSync(directory, "r");
        try {
          fs.fsyncSync(directoryFd);
        } finally {
          fs.closeSync(directoryFd);
        }
      }
    } catch (error) {
      try {
        fs.unlinkSync(temporary);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") throw cleanupError;
      }
      throw error;
    }
  }

  function readProtectedJson(filePath) {
    const target = assertProtectedRegularFile(filePath);
    return JSON.parse(fs.readFileSync(target, "utf8"));
  }

  function acquireOperationLock({ operationId }) {
    if (!UUID_PATTERN.test(operationId || "")) {
      throw new Error("operation id 不是有效的 UUID");
    }
    const lockDirectory = ensurePrivateDirectory(path.join(resolvedHome, ".rainbond", "rainskills-locks"));
    const lockPath = path.join(lockDirectory, `${operationId}.lock`);
    const owner = {
      schema: "rainskills.operation-lock.v1",
      operation_id: operationId,
      pid,
      process_identity: processIdentity,
    };

    for (;;) {
      const candidatePath = path.join(
        lockDirectory,
        `.${operationId}.candidate.${pid}.${crypto.randomBytes(6).toString("hex")}`
      );
      let fd;
      let published = false;
      try {
        fd = fs.openSync(candidatePath, "wx", 0o600);
        fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        harden(candidatePath, "file");
        fs.linkSync(candidatePath, lockPath);
        published = true;
        harden(lockPath, "file");
        try {
          fs.unlinkSync(candidatePath);
        } catch (cleanupError) {
          if (cleanupError.code !== "ENOENT") {
            // The complete final lock is authoritative; an orphaned candidate is harmless.
          }
        }
        break;
      } catch (error) {
        if (fd !== undefined) fs.closeSync(fd);
        try {
          fs.unlinkSync(candidatePath);
        } catch (cleanupError) {
          if (cleanupError.code !== "ENOENT") throw cleanupError;
        }
        if (published) {
          try {
            fs.unlinkSync(lockPath);
          } catch (cleanupError) {
            if (cleanupError.code !== "ENOENT") throw cleanupError;
          }
        }
        if (error.code !== "EEXIST") throw error;
        const existing = readProtectedJson(lockPath);
        if (isProcessAlive(existing.pid, existing.process_identity)) {
          const busy = new Error(`该安装正在运行；请查看现有进度，或稍后执行 resume：${operationId}`);
          busy.code = "RAINSKILLS_OPERATION_LOCK_BUSY";
          throw busy;
        }
        const stalePath = path.join(
          lockDirectory,
          `.${operationId}.stale.${crypto.randomBytes(6).toString("hex")}`
        );
        try {
          fs.renameSync(lockPath, stalePath);
          fs.unlinkSync(stalePath);
        } catch (reclaimError) {
          if (!["ENOENT", "EEXIST"].includes(reclaimError.code)) throw reclaimError;
        }
        continue;
      }
    }

    let released = false;
    return {
      path: lockPath,
      release() {
        if (released) return;
        released = true;
        let current;
        try {
          current = readProtectedJson(lockPath);
        } catch (error) {
          if (error.code === "ENOENT") return;
          throw error;
        }
        if (
          current.pid === owner.pid
          && current.process_identity === owner.process_identity
        ) {
          fs.unlinkSync(lockPath);
        }
      },
    };
  }

  return {
    acquireOperationLock,
    assertInsideHome,
    assertProtectedRegularFile,
    assertSafeExternalRegularFile,
    atomicWriteJson,
    ensurePrivateDirectory,
    protectRegularFile,
    readProtectedJson,
  };
}

module.exports = { createSecureStateStore };
