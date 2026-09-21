#!/usr/bin/env node
// ai/agents/*.md（正本。Claude Code は .claude/agents のリンクで直接読む）から、Codex 用の .codex/agents/*.toml を生成する。
// Codex は名前に英小文字・数字・アンダースコアしか使えないので、エージェント名にハイフンを使わない。
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 正本の model（Claude のクラス）に対応させる Codex のモデル。対応が無ければ model を書かず、親セッションのものを引き継ぐ
const codexModels = { opus: "gpt-6-astra", sonnet: "gpt-5.6-sol" };

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "agents");
const out = join(here, "..", ".codex", "agents");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const file of readdirSync(src).filter((f) => f.endsWith(".md")).sort()) {
  const [, front, ...rest] = readFileSync(join(src, file), "utf8").split("---\n");
  const body = rest.join("---\n").trim();
  const meta = Object.fromEntries(front.trim().split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
  if (!/^[a-z0-9_]+$/.test(meta.name)) throw new Error(`${file}: name は英小文字・数字・アンダースコアだけにする（Codex の制約）`);
  if (body.includes('"""') || body.includes("\\")) throw new Error(`${file}: 本文に """ と \\ は使えない（TOML の文字列に入れるため）`);
  const lines = [
    `# ai/agents/${file} から ai/gen-codex-agents.mjs で生成。直接編集しない。`,
    `name = ${JSON.stringify(meta.name)}`,
    `description = ${JSON.stringify(meta.description)}`,
    ...(codexModels[meta.model] ? [`model = ${JSON.stringify(codexModels[meta.model])}`] : []),
    `model_reasoning_effort = ${JSON.stringify(meta.effort ?? "high")}`,
  ];
  // Edit を禁じているエージェントは読み取り専用
  if ((meta.disallowedTools ?? "").includes("Edit")) lines.push('sandbox_mode = "read-only"');
  lines.push(`developer_instructions = """\n${body}\n"""`);
  writeFileSync(join(out, `${meta.name}.toml`), lines.join("\n") + "\n");
}
