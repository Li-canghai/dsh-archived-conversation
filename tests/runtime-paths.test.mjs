import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  migrateLegacyRuntimeFile,
  runtimeFile,
} from "../lib/runtime-paths.mjs";

test("runtimeFile stores plugin-owned state below .dsh/runtime/dsh-archived-conversation", () => {
  const home = join("C:", "Users", "tester");
  assert.equal(
    runtimeFile("queue.json", home),
    join(home, ".dsh", "runtime", "dsh-archived-conversation", "queue.json"),
  );
});

test("migrateLegacyRuntimeFile moves an existing root-level state file once", async () => {
  const home = await mkdtemp(join(tmpdir(), "archived-conversation-runtime-"));
  try {
    const legacy = join(home, ".dsh", "queue.json");
    const target = runtimeFile("queue.json", home);
    mkdirSync(join(home, ".dsh"), { recursive: true });
    writeFileSync(legacy, "legacy", "utf8");

    migrateLegacyRuntimeFile("queue.json", home);

    assert.equal(readFileSync(target, "utf8"), "legacy");
    assert.equal(existsSync(legacy), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("migrateLegacyRuntimeFile preserves both files when the runtime target already exists", async () => {
  const home = await mkdtemp(join(tmpdir(), "archived-conversation-runtime-"));
  try {
    const legacy = join(home, ".dsh", "queue.json");
    const target = runtimeFile("queue.json", home);
    mkdirSync(join(home, ".dsh"), { recursive: true });
    mkdirSync(join(home, ".dsh", "runtime", "dsh-archived-conversation"), { recursive: true });
    writeFileSync(legacy, "legacy", "utf8");
    writeFileSync(target, "current", "utf8");

    migrateLegacyRuntimeFile("queue.json", home);

    assert.equal(readFileSync(target, "utf8"), "current");
    assert.equal(readFileSync(legacy, "utf8"), "legacy");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
