#!/bin/sh
# install.sh と template のスモークテスト。失敗した時点で止まる。
set -eu

root="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "NG: $1" >&2
  exit 1
}

check_installed() {
  [ "$(git -C "$1" config core.hooksPath)" = ".githooks" ] || fail "$2: core.hooksPath が設定されていない"
  [ -f "$1/AGENTS.md" ] || fail "$2: AGENTS.md が無い"
  [ -x "$1/.githooks/pre-commit" ] || fail "$2: pre-commit が実行可能でない"
}

# 1. 空のリポジトリ: リンクが張られ、リンク越しにスキルを読める
git init -q "$tmp/empty"
"$root/install.sh" "$tmp/empty" >/dev/null
check_installed "$tmp/empty" "空のリポジトリ"
for l in .claude/skills .claude/agents .agents/skills; do
  [ -L "$tmp/empty/$l" ] || fail "空のリポジトリ: $l がリンクでない"
done
[ -f "$tmp/empty/.claude/skills/create-issue/SKILL.md" ] || fail "空のリポジトリ: リンク越しにスキルを読めない"

# 2. もう一度実行しても成功する
"$root/install.sh" "$tmp/empty" >/dev/null || fail "再実行: 失敗した"

# 3. .claude/skills が実ディレクトリで既にある: 止まらず、既存を残し、対応を知らせる
git init -q "$tmp/existing"
mkdir -p "$tmp/existing/.claude/skills/mine"
echo keep >"$tmp/existing/.claude/skills/mine/SKILL.md"
"$root/install.sh" "$tmp/existing" >/dev/null 2>"$tmp/err" || fail "既存の .claude/skills: 失敗した"
check_installed "$tmp/existing" "既存の .claude/skills"
[ "$(cat "$tmp/existing/.claude/skills/mine/SKILL.md")" = "keep" ] || fail "既存の .claude/skills: 既存のスキルが消えた"
grep -q "要対応: .claude/skills" "$tmp/err" || fail "既存の .claude/skills: 対応が案内されない"
[ -L "$tmp/existing/.claude/agents" ] || fail "既存の .claude/skills: 他のリンクが張られていない"

# 4. git worktree（.git がファイル）にも導入できる
git -C "$tmp/empty" -c user.name=test -c user.email=test@example.com commit -q --no-verify --allow-empty -m init
git -C "$tmp/empty" worktree add -q "$tmp/wt" -b wt
[ -f "$tmp/wt/.git" ] || fail "worktree: .git がファイルになっていない（テストの前提が崩れている）"
"$root/install.sh" "$tmp/wt" >/dev/null || fail "worktree: 失敗した"
check_installed "$tmp/wt" "worktree"
[ -L "$tmp/wt/.claude/skills" ] || fail "worktree: リンクが張られていない"

# 5. template の .codex/agents が ai/agents/ から生成したものと一致する
node "$root/template/ai/gen-codex-agents.mjs"
if ! git -C "$root" diff --quiet -- template/.codex/agents || [ -n "$(git -C "$root" ls-files --others --exclude-standard template/.codex/agents)" ]; then
  fail "template/.codex/agents が古い。生成し直した内容をコミットする"
fi

echo "OK"
