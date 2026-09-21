# dev-tools

Claude Code と Codex で開発するための環境一式（カスタムインストラクション、Agent Skills、サブエージェント、推奨ディレクトリ構成）。`template/` を対象リポジトリにコピーして使う。

## 使い方

```sh
./install.sh <対象の git リポジトリのパス>
```

既存のファイルは上書きしない（スキップしたファイルを表示する）。`.claude/skills` などが実ディレクトリとして既にあるときは、リンクに置き換える手順を `要対応:` として表示する。コピー後に `core.hooksPath` を `.githooks` に設定する。続けて、対象リポジトリの `AGENTS.md` と `docs/operations/onboarding.md` の `TODO` を埋める。

必要なもの: `rsync`、[gitleaks](https://github.com/gitleaks/gitleaks)、[GitHub CLI](https://cli.github.com/)、Node.js（`review-pr` のレポート生成）。

## 開発の流れ

Issue・計画・PR を 1 対 1 で対応させる。ユーザが承認するのは Issue と PR の 2 か所だけ。詳細は `template/AGENTS.md`。

1. `/create-issue <やりたいこと>`: 調査、推奨つきの質問、完成イメージの提示、承認後に起票。
2. `/implement-issue <Issue 番号>`: 調査・計画・実装・検証・PR 作成まで止まらずに進める。
3. `/review-pr <PR 番号>`: 別セッションでレビューと修正を行い、HTML レポートを作る。

Codex では `$create-issue` のように `$` で起動する。

## template の中身

| パス | 内容 |
| --- | --- |
| `AGENTS.md` / `CLAUDE.md` | カスタムインストラクションの正本。`CLAUDE.md` は `@AGENTS.md` を読むだけ |
| `ai/skills/` | 3 つのスキルの正本 |
| `.claude/skills` / `.agents/skills` | `ai/skills/` へのシンボリックリンク（Claude Code 用 / Codex 用） |
| `ai/agents/*.md` | サブエージェント `researcher`・`implementer`・`implementer_lite`・`reviewer` の正本。直すのはここだけ |
| `.claude/agents` | `ai/agents/` へのシンボリックリンク（Claude Code 用） |
| `.codex/agents/*.toml` | Codex 用。形式が違うためリンクにできず、`ai/gen-codex-agents.mjs` で `ai/agents/` から生成する |
| `ai/gen-codex-agents.mjs` | 上の生成スクリプト。作り直し忘れは `pre-commit` が止める |
| `docs/architecture/` | 現在の設計の正本 |
| `docs/operations/` | セットアップ・運用の手順（`onboarding.md`） |
| `docs/plans/` | Issue 単位の作業文書と `TEMPLATE.md` |
| `.github/` | Issue / PR テンプレート、gitleaks のワークフロー |
| `.githooks/` | `pre-commit`（gitleaks）、`pre-push`（main への直接 push を拒否） |
| `.gitleaks.toml` | 既定のルールに、メールアドレスと日本の電話番号の検出を追加 |

プロジェクト固有の制約（費用の上限など）はスキルに書かず、対象リポジトリの `AGENTS.md`「制約」に書く。スキルはその節を参照する。

## エージェントを直すとき

対象リポジトリで `ai/agents/*.md` を直し、`node ai/gen-codex-agents.mjs` を実行して `.codex/agents` も一緒にコミットする（忘れると `pre-commit` が作り直して止める）。Codex は名前に英小文字・数字・アンダースコアしか使えないので、エージェント名にハイフンを使わない。Codex 用は model を指定せず親セッションのモデルを引き継ぎ、読み取り専用のエージェントは `sandbox_mode = "read-only"` になる。

## このリポジトリを直すとき

`./test.sh` を通す。空のリポジトリと、`.claude/skills` が既にあるリポジトリへ `install.sh` を実行し、`template/.codex/agents` が正本と一致することを確かめる。GitHub Actions（`.github/workflows/test.yml`）でも Ubuntu と macOS で実行する。
