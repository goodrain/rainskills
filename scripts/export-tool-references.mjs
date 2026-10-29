#!/usr/bin/env node
/**
 * 导出 embedded skills 引用的 rainbond_* 工具清单，供跨仓契约测试对账。
 *
 * 背景：2026-10-27 的事故暴露「Skill 写了工具、平台没实现」无人发现
 * （rainbond_probe_delivery_url 长期缺失）。生成物由
 * tests/tool-references-contract.test.js 校验是否最新。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EMBEDDED_SKILLS = [
  "rainbond-ai-assistant",
  "rainbond-app-assistant",
  "rainbond-app-version-assistant",
  "rainbond-delivery-verifier",
  "rainbond-fullstack-bootstrap",
  "rainbond-fullstack-troubleshooter",
  "rainbond-platform-plugin-manager",
  "rainbond-platform-query",
  "rainbond-scheduled-task",
  "rainbond-template-installer",
];

/** 正则提取产生的伪工具名 / 文档动词与枚举（rainbond_* 与 schedule_* 两种工具命名空间） */
const NON_TOOL_REFERENCES = new Set([
  "rainbond_create_component_",
  "rainbond_manage_component_",
  "rainbond_template",
  "rainbond_exec",
]);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

export function collectToolReferences(root = repoRoot) {
  const refs = new Map();
  for (const skill of EMBEDDED_SKILLS) {
    const skillDir = path.join(root, skill);
    if (!fs.existsSync(skillDir)) continue;
    for (const file of walk(skillDir)) {
      const content = fs.readFileSync(file, "utf8");
      for (const line of content.split(/\r?\n/)) {
        // 「不得调用不存在的 rainbond_xxx」属于反向引用，不算能力缺口
        if (line.includes("不存在") || /not\s+exist/i.test(line)) continue;
        for (const match of line.matchAll(/\b(?:rainbond|schedule)_[a-z0-9_]+\b/g)) {
          const name = match[0];
          if (NON_TOOL_REFERENCES.has(name)) continue;
          if (!refs.has(name)) refs.set(name, new Set());
          refs.get(name).add(skill);
        }
      }
    }
  }
  return new Map(
    [...refs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, skills]) => [name, [...skills].sort()])
  );
}

export function renderToolReferences(root = repoRoot) {
  const refs = collectToolReferences(root);
  return (
    JSON.stringify(
      {
        version: 1,
        note: "embedded skills 引用的 rainbond_*/schedule_* 工具清单。由 scripts/export-tool-references.mjs 生成，请勿手工编辑。",
        skills: EMBEDDED_SKILLS,
        tools: [...refs.entries()].map(([name, skills]) => ({ name, skills })),
      },
      null,
      2
    ) + "\n"
  );
}

if (process.argv[1] && process.argv[1].endsWith("export-tool-references.mjs")) {
  const out = path.join(repoRoot, "contracts", "tool-references.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderToolReferences(repoRoot), "utf8");
  process.stdout.write(`wrote ${path.relative(repoRoot, out)}\n`);
}
