#!/bin/sh
# template/ の内容を対象リポジトリへコピーする。既存のファイルは上書きしない。
set -eu

if [ $# -ne 1 ] || [ ! -d "$1/.git" ]; then
  echo "使い方: $0 <対象の git リポジトリのパス>" >&2
  exit 1
fi

src="$(cd "$(dirname "$0")" && pwd)/template"
dest="$(cd "$1" && pwd)"

# 上書きされずに残った既存ファイルを知らせる
(cd "$src" && find . \( -type f -o -type l \) | sed 's|^\./||') | while read -r f; do
  if [ -e "$dest/$f" ] || [ -L "$dest/$f" ]; then
    echo "スキップ（既存）: $f"
  fi
done

rsync -a --ignore-existing "$src/" "$dest/"
git -C "$dest" config core.hooksPath .githooks

cat <<MSG

コピーしました: $dest
次にすること:
  1. AGENTS.md と docs/operations/onboarding.md の TODO を埋める
  2. brew install gitleaks gh（未導入の場合）
  3. GitHub のリポジトリ設定で squash マージを有効にする
MSG
