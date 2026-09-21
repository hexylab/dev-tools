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
(cd "$src" && find . -type f | sed 's|^\./||') | while read -r f; do
  if [ -e "$dest/$f" ] || [ -L "$dest/$f" ]; then
    echo "スキップ（既存）: $f"
  fi
done

# シンボリックリンクは rsync に渡さず、自分で張る。
# 対象に同名の実ディレクトリがあると、rsync は置き換えに失敗して途中で止まるため。
links="$(cd "$src" && find . -type l | sed 's|^\./||')"
set --
for l in $links; do
  set -- "$@" --exclude="/$l"
done
rsync -a --ignore-existing "$@" "$src/" "$dest/"

for l in $links; do
  target="$(readlink "$src/$l")"
  if [ -L "$dest/$l" ]; then
    echo "スキップ（既存）: $l"
  elif [ -e "$dest/$l" ]; then
    echo "要対応: $l がリンクではありません。中身を ${target#../} へ移して削除し、ln -s $target $l を実行してください。" >&2
  else
    mkdir -p "$(dirname "$dest/$l")"
    ln -s "$target" "$dest/$l"
  fi
done

git -C "$dest" config core.hooksPath .githooks

cat <<MSG

コピーしました: $dest
次にすること:
  1. AGENTS.md と docs/operations/onboarding.md の TODO を埋める
  2. brew install gitleaks gh（未導入の場合）
  3. GitHub のリポジトリ設定で squash マージを有効にする
MSG
