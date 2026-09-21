#!/usr/bin/env node
// 標準入力の unified diff を、ファイルごとに折りたたんだ HTML（<details>）に変換する。
//
//   git diff <base>...HEAD -- <paths> | node diff-html.mjs --into report.html --slot changes-1 \
//     --note 'src/a.ts:24:F1:期間を渡さずに全期間を数えていた'
//
//   --into <file> --slot <name>  <file> の <!-- DIFF:<name> --> を変換結果で置き換える。省くと標準出力に出す
//   --note <path>:<行>:<Fn>:<要約>  その行の下に指摘への注記を挿す。行は変更後の行番号。削除行は -<変更前の行番号>
//   --max-lines <n>              1 ファイルあたりの表示行数の上限（既定 400）。超えた分は件数だけ示す。--note のあるファイルは省略しない
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const notes = [];
let into, slot, maxLines = 400;
for (let i = 0; i < args.length; i++) {
  const value = args[i + 1];
  if (args[i] === "--into") into = value;
  else if (args[i] === "--slot") slot = value;
  else if (args[i] === "--max-lines") maxLines = Number(value);
  else if (args[i] === "--note") {
    const m = /^(.+?):(-?\d+):(F\d+):(.+)$/.exec(value ?? "");
    if (!m) fail(`--note の形式が違います: ${value}`);
    notes.push({ path: m[1], line: m[2], id: m[3], text: m[4], used: false });
  } else fail(`不明な引数: ${args[i]}`);
  i++;
}
if (Boolean(into) !== Boolean(slot)) fail("--into と --slot は一緒に指定します");
if (!Number.isInteger(maxLines) || maxLines < 1) fail("--max-lines は 1 以上の整数で指定します");
if (into && !existsSync(into)) fail(`${into} がありません`);

function fail(message) {
  console.error(`diff-html: ${message}`);
  process.exit(1);
}
// 表示は変えずに、差分の中のコードがレポートの機械検査（`@import`・`prefers-color-scheme`・
// 外部 URL の `href="https://…"`）に一致しないよう、@ と " と検査語のハイフンを文字参照にする。
// ハイフンは検査語だけを崩す。すべて崩すと、生の HTML でパスを読めず grep もできなくなるため
const esc = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/@/g, "&#64;")
    .replace(/prefers-color-scheme/g, "prefers&#45;color-scheme");
const row = (cls, no, code) =>
  `<div class="ln${cls ? ` ${cls}` : ""}"><span class="no">${no}</span><span class="code">${code}</span></div>`;

// ファイルごとに分ける
const files = [];
let file;
for (const line of readFileSync(0, "utf8").split("\n")) {
  // ハンクの中の行は必ず空白・+・-・\ で始まるので、この行は常に新しいファイルの始まり
  if (line.startsWith("diff --git ")) {
    const head = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    file = { path: head ? head[2] : line.slice(11), tag: "変更", rows: [], add: 0, del: 0, inHunk: false };
    files.push(file);
    continue;
  }
  if (!file) continue;
  if (!file.inHunk) {
    if (line.startsWith("new file mode")) file.tag = "新規";
    else if (line.startsWith("deleted file mode")) file.tag = "削除";
    else if (line.startsWith("rename from")) file.tag = "名前変更";
    // 引用符付きや a/ b/ 以外の接頭辞のパスは、ヘッダの +++ 行（削除なら --- 行）から取り直す
    // 末尾の TAB は、パスに空白があるときに git が付ける区切りなので落とす
    const named = /^(?:\+\+\+|---) "?[^/"]+\/(.*?)"?\t?$/.exec(line);
    if (named && (line.startsWith("+++") || file.tag === "削除")) file.path = named[1];
    else if (line.startsWith("Binary files")) file.rows.push(row("hunk", "", "バイナリファイル（差分は表示しない）"));
  }
  const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (hunk) {
    file.inHunk = true;
    file.oldNo = Number(hunk[1]);
    file.newNo = Number(hunk[2]);
    file.rows.push(row("hunk", "", esc(line)));
    continue;
  }
  if (!file.inHunk || line === "" || line.startsWith("\\")) continue;
  let key;
  if (line[0] === "+") {
    key = String(file.newNo);
    file.rows.push(row("add", file.newNo++, esc(line)));
    file.add++;
  } else if (line[0] === "-") {
    key = `-${file.oldNo}`;
    file.rows.push(row("del", file.oldNo++, esc(line)));
    file.del++;
  } else {
    key = String(file.newNo);
    file.rows.push(row("", file.newNo++, esc(line)));
    file.oldNo++;
  }
  for (const note of notes) {
    if (note.path !== file.path || note.line !== key) continue;
    note.used = true;
    file.rows.push(
      `<a class="ln note" href="#${note.id.toLowerCase()}"><span class="no">▲</span><span class="code"><b>${note.id}</b> ${esc(note.text)}</span></a>`,
    );
  }
}

const unused = notes.filter((note) => !note.used);
if (unused.length) fail(`差分に無い行への --note: ${unused.map((n) => `${n.path}:${n.line}`).join(", ")}`);
if (!files.length) fail("標準入力に差分がありません");

const html = files
  .map((f) => {
    const count = notes.filter((n) => n.path === f.path).length;
    // 名前や権限の変更だけのファイルにはハンクもバイナリの行も無いので、折りたたみが空にならないようにする
    const rows = f.rows.length ? f.rows : [row("hunk", "", "内容の変更なし（名前や権限の変更のみ）")];
    const limit = count ? rows.length : maxLines;
    const shown = rows.slice(0, limit);
    if (rows.length > limit) shown.push(row("hunk", "", `… 残り ${rows.length - limit} 行は省略（git diff で確認）`));
    return [
      `<details class="fold diff-file">`,
      `<summary><span class="path">${esc(f.path)}</span><span class="tag">${f.tag}</span>${count ? `<span class="tag tag-note">指摘 ${count}</span>` : ""}<span class="diffstat">+${f.add} −${f.del}</span></summary>`,
      `<div class="diff-lines">`,
      ...shown,
      `</div>`,
      `</details>`,
    ].join("\n");
  })
  .join("\n");

if (!into) {
  console.log(html);
} else {
  const marker = `<!-- DIFF:${slot} -->`;
  const source = readFileSync(into, "utf8");
  if (!source.includes(marker)) fail(`${into} に ${marker} がありません`);
  writeFileSync(into, source.replace(marker, () => html));
  console.error(`diff-html: ${marker} を ${files.length} ファイル分の差分で置き換えました`);
}
