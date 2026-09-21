# 初回セットアップ

クローン直後に 1 回だけ実行する。[gitleaks](https://github.com/gitleaks/gitleaks) と [GitHub CLI](https://cli.github.com/)（`gh`）、Node.js（`review-pr` のレポート生成に使う）が必要。

```sh
brew install gitleaks gh   # macOS。他の OS は各 README を参照
gh auth login
git config core.hooksPath .githooks
```

<!-- TODO: 依存のインストールと、リポジトリ全体の確認コマンド（型検査・テスト・build）をここに足す -->

`git config` で次のフックが有効になる。

- `pre-commit`: ステージ済みの変更にシークレット・個人情報がないか検査する。
- `pre-push`: main への直接 push を拒否する。
