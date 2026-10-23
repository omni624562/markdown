import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "./desktop.ts";
import { matchesProject, projectGroups, projectSections, samePath } from "./projects.ts";

const p = (label: string, extra: Partial<Project> = {}): Project => ({
  path: `C:\\專案\\${label}`,
  label,
  name: null,
  color: null,
  group: null,
  pinned: false,
  lastOpened: 0,
  ...extra,
});

test("依釘選、群組（排序）、最近開啟分區，區內維持原本順序", () => {
  const list = [
    p("最新"),
    p("報告", { group: "公司" }),
    p("部落格", { group: "個人" }),
    p("規格", { pinned: true, group: "公司" }),
    p("舊的"),
    p("手冊", { group: "公司" }),
  ];
  const sections = projectSections(list);
  assert.deepEqual(
    sections.map((s) => [s.title, s.items.map((x) => x.label)]),
    [
      ["釘選", ["規格"]],
      ["公司", ["報告", "手冊"]],
      ["個人", ["部落格"]],
      ["最近開啟", ["最新", "舊的"]],
    ],
  );
});

test("搜尋名稱、群組與路徑，每個詞都要符合", () => {
  const x = p("週報", { group: "公司", path: "D:\\work\\weekly" });
  assert.ok(matchesProject(x, "週報"));
  assert.ok(matchesProject(x, "公司 WEEKLY"));
  assert.ok(!matchesProject(x, "公司 月報"));
  assert.deepEqual(projectSections([x, p("其他")], "weekly").map((s) => s.title), ["公司"]);
});

test("群組名稱不重複，依筆畫排序", () => {
  assert.deepEqual(projectGroups([p("a", { group: "公司" }), p("b", { group: "個人" }), p("c", { group: "公司" }), p("d")]), ["公司", "個人"]);
});

test("Windows 路徑不分大小寫", () => {
  assert.ok(samePath("C:\\Notes", "c:\\notes"));
  assert.ok(samePath("\\\\server\\share\\A", "\\\\SERVER\\share\\a"));
  assert.ok(!samePath("/home/a", "/home/A"));
});
