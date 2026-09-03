import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

let clientExports;
const sandbox = {
  window: {
  __ModuleLoader__: {
    load({ factory }) {
      clientExports = factory((id) => {
        if (id === "react") return { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) };
        throw new Error(`unexpected module: ${id}`);
      });
    },
  },
  },
};
const clientPath = new URL("../lib/client.js", import.meta.url);
vm.runInNewContext(readFileSync(clientPath, "utf8"), sandbox, { filename: clientPath.pathname });
const plain = (value) => JSON.parse(JSON.stringify(value));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const groups = [
  {
    project: "DSH 工具",
    sessions: [
      { id: "session-alpha", title: "修复启动器", updatedAt: 3 },
      {
        id: "session-beta",
        title: "Security Review",
        updatedAt: 2,
        children: [{ id: "session-child", parentId: "session-beta", depth: 1, title: "核实审批链路", mode: "continuable" }],
      },
    ],
  },
  {
    project: "个人笔记",
    sessions: [
      { id: "session-gamma", title: "周末计划", updatedAt: 1 },
    ],
  },
];

test("搜索功能保持客户端插件入口兼容", () => {
  assert.equal(typeof clientExports.apply, "function");
  assert.deepEqual(Array.from(clientExports.inject), ["slots"]);
});

test("alpha 客户端清单不再引用已移除的 runtime 包", () => {
  const ordering = packageJson.dsh.client.inject;
  assert.ok(!ordering.includes("@deepseek-ai/dsh-client-runtime"));
  assert.ok(ordering.includes("@deepseek-ai/dsh-client-ui-settings"));
});

test("空查询返回全部归档会话且不复制列表", () => {
  const result = clientExports.filterArchivedGroups(groups, "  ");
  assert.equal(result, groups);
});

test("搜索按标题匹配且忽略拉丁字母大小写", () => {
  const result = clientExports.filterArchivedGroups(groups, " security ");
  assert.deepEqual(plain(result), [
    { project: "DSH 工具", sessions: [groups[0].sessions[1]] },
  ]);
});

test("搜索支持会话 ID", () => {
  const result = clientExports.filterArchivedGroups(groups, "GAMMA");
  assert.deepEqual(plain(result), [
    { project: "个人笔记", sessions: [groups[1].sessions[0]] },
  ]);
});

test("搜索命中子代理标题时保留所属主对话", () => {
  const result = clientExports.filterArchivedGroups(groups, "审批链路");
  assert.deepEqual(plain(result), [
    { project: "DSH 工具", sessions: [groups[0].sessions[1]] },
  ]);
});

test("展开的主对话显示只读子代理标题和向下箭头", () => {
  const tree = clientExports.SessionRow({
    session: groups[0].sessions[1],
    pending: false,
    busy: false,
    expanded: true,
    onToggle: () => {},
    onUnarchive: () => {},
    onDelete: () => {},
    confirming: false,
    setConfirming: () => {},
  });
  const serialized = JSON.stringify(tree);
  assert.match(serialized, /ac_chevron/);
  assert.match(serialized, /核实审批链路/);
  assert.match(serialized, /ac_child/);
  assert.doesNotMatch(serialized, /session-child[^]*取消归档/);
});

test("项目名命中时保留该项目下全部会话", () => {
  const result = clientExports.filterArchivedGroups(groups, "dsh");
  assert.deepEqual(plain(result), [groups[0]]);
});

test("搜索无结果时返回空分组且不修改原数据", () => {
  const before = structuredClone(groups);
  assert.equal(clientExports.filterArchivedGroups(groups, "不存在").length, 0);
  assert.deepEqual(groups, before);
});
