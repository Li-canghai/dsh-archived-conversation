import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const RUNTIME_DIRECTORY_NAME = "dsh-archived-conversation";

export function atomicWriteFileSync(target, data, options) {
  const tmp = `${target}.tmp`;
  try {
    writeFileSync(tmp, data, options);
    renameSync(tmp, target);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw error;
  }
}

export function runtimeFile(fileName, home = homedir()) {
  return join(home, ".dsh", "runtime", RUNTIME_DIRECTORY_NAME, fileName);
}

export function migrateLegacyRuntimeFile(fileName, home = homedir()) {
  const legacy = join(home, ".dsh", fileName);
  const target = runtimeFile(fileName, home);
  if (!existsSync(legacy) || existsSync(target)) return target;
  mkdirSync(dirname(target), { recursive: true });
  renameSync(legacy, target);
  return target;
}

export function prepareRuntimeFile(fileName, home = homedir()) {
  const target = migrateLegacyRuntimeFile(fileName, home);
  mkdirSync(dirname(target), { recursive: true });
  return target;
}