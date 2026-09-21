#!/usr/bin/env node
// 採用した指摘を PR のレビュー（行コメント＋本文の一覧）として投稿し、修正後に返信して resolve する。
//
//   node pr-threads.mjs post --pr 34 --round 1 --report docs/plans/issue34/report.html --findings findings.json
//   node pr-threads.mjs reply --pr 34 --finding F1 --comment-id 9001 --fixed a1b2c3d --summary '回帰テストを足した'
//   node pr-threads.mjs reply --pr 34 --finding F2 --unresolved '判断が必要（文言の選択）'
//
//   post   findings（[{id, severity, title, problem, path?, line?}]）を 1 回のレビューにまとめて投稿する。
//          差分のハンクに出ている変更後の行（RIGHT）を指す指摘だけが行コメントになり、残りは本文の一覧に載る。
//          標準出力に JSON {review_url, threads: [{id, comment_id}], body_only: [id…], errors: […]}
//          body_only は comment_id の無い指摘（行コメントにならなかったか、投稿後に ID を取れなかったもの）
//   reply  --comment-id があればそのスレッドへ返信する（--fixed のときは続けて resolve する）。
//          無ければ同じ文面を PR の通常のコメントで投稿する
//
//   失敗した操作は `pr-threads: 失敗: <操作>: <理由>` を標準エラーに出し、終了コード 1 で終わる。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_VERSION = "X-GitHub-Api-Version: 2026-03-10"; // GraphQL には付けない
const THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{fullDatabaseId}}}}}}}";
const RESOLVE_MUTATION =
  "mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}";

const argv = process.argv.slice(2);
const command = argv.shift();
const opt = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) fail(`不明な引数: ${argv[i]}`);
  opt[argv[i].slice(2)] = argv[i + 1];
  i++;
}

function fail(message) {
  console.error(`pr-threads: ${message}`);
  process.exit(1);
}

// gh は PATH 上のものを呼ぶ（Evals ではスタブ）。失敗の理由は標準エラーの 1 行目にする。
function gh(args, options = {}) {
  const result = spawnSync("gh", args, { encoding: "utf8", ...options });
  const stderr = (result.stderr ?? "").trim() || (result.error ? String(result.error.message) : "");
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: stderr.split("\n")[0] ?? "" };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const tempDir = mkdtempSync(join(tmpdir(), "pr-threads-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

if (command === "post") post();
else if (command === "reply") reply();
else fail(`最初の引数は post か reply です: ${command ?? "(なし)"}`);

// ---------------------------------------------------------------- post

function post() {
  const { pr, round, report } = opt;
  if (!pr || !round || !report || !opt.findings) fail("post には --pr --round --report --findings が必要です");
  const findings = readFindings(opt.findings);
  const errors = [];

  const diff = rightSideLines(pr);
  if (diff.error) errors.push(diff.error);
  for (const finding of findings) {
    finding.onLine = Boolean(finding.path && finding.line) && diff.lines.has(`${finding.path}:${finding.line}`);
  }

  let onLine = findings.filter((finding) => finding.onLine);
  const offLine = diff.error ? "（差分を取得できず、行コメントなし）" : "（差分に無い行）";
  let created = createReview(pr, reviewBody(findings, round, report, false, offLine), lineComments(onLine, report));
  // 差分との照合をすり抜けた行が 1 件でもあるとレビュー全体が 422 で落ちるので、本文だけで入れ直す。
  // それ以外の失敗（通信、権限）は入れ直しても通らないので、繰り返さない。
  if (!created.ok && onLine.length > 0 && created.stderr.includes("422")) {
    errors.push(`行コメント付きの投稿に失敗したため、本文の一覧だけで投稿しました: ${created.stderr}`);
    onLine = [];
    created = createReview(pr, reviewBody(findings, round, report, true, offLine), []);
  }
  if (!created.ok) fail(`失敗: レビューの作成: ${created.stderr}`);

  const review = parseJson(created.stdout) ?? {};
  const threads = [];
  if (review.id === undefined) {
    errors.push("レビューの応答から ID を読めないため、スレッドを対応づけられません");
  } else if (onLine.length > 0) {
    const listed = gh(["api", `repos/{owner}/{repo}/pulls/${pr}/reviews/${review.id}/comments`, "-H", API_VERSION]);
    const posted = listed.ok ? parseJson(listed.stdout) : null;
    if (!Array.isArray(posted)) {
      errors.push(`行コメントの一覧を取得できませんでした: ${listed.ok ? "応答を JSON として読めません" : listed.stderr}`);
    } else {
      for (const finding of onLine) {
        // この一覧は line を null で返すので、本文の先頭の [Fn・ で見分ける。
        const hit = posted.find((row) => row.path === finding.path && String(row.body ?? "").includes(`[${finding.id}・`));
        if (hit) threads.push({ id: finding.id, comment_id: hit.id });
        else errors.push(`${finding.id} の行コメントが応答に見つかりません`);
      }
    }
  }

  console.log(
    JSON.stringify({
      review_url: String(review.html_url ?? ""),
      threads,
      // comment_id を取れなかった指摘もこちらに入れる。返信先が分からないので、reply は通常のコメントになる。
      body_only: findings.filter((finding) => !threads.some((thread) => thread.id === finding.id)).map((finding) => finding.id),
      errors,
    }),
  );
}

function readFindings(path) {
  let source = "";
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    fail(`findings を読めません: ${String(error)}`);
  }
  const findings = parseJson(source);
  if (!Array.isArray(findings)) fail(`findings は指摘の配列です: ${path}`);
  for (const finding of findings) {
    const ok =
      finding !== null &&
      typeof finding === "object" &&
      /^F\d+$/.test(String(finding.id)) &&
      ["severity", "title", "problem"].every((key) => typeof finding[key] === "string" && finding[key].trim()) &&
      (finding.path === undefined || (typeof finding.path === "string" && finding.path.trim())) &&
      (finding.line === undefined || Number.isInteger(finding.line));
    if (!ok) fail(`findings の形式が違います: ${JSON.stringify(finding)}`);
  }
  return findings;
}

// gh pr diff のハンクに出ている変更後の行（追加行と変更のない行 = RIGHT 側）。
function rightSideLines(pr) {
  const result = gh(["pr", "diff", String(pr)]);
  if (!result.ok) {
    return { lines: new Set(), error: `gh pr diff に失敗したため、すべて本文の一覧にしました: ${result.stderr}` };
  }
  const lines = new Set();
  let path = "";
  let no = 0;
  let inHunk = false;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("diff --git ")) {
      path = "";
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      // パスに空白があるときに git が付ける末尾の TAB は落とす
      const named = decodeGitPath(line.slice(4).replace(/\t$/, ""));
      path = named === "/dev/null" ? "" : named.replace(/^b\//, "");
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      no = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !path || line === "" || line.startsWith("\\")) continue;
    if (line[0] === "+" || line[0] === " ") lines.add(`${path}:${no++}`);
    else if (line[0] !== "-") inHunk = false;
  }
  return { lines, error: null };
}

// Git の引用パスでは UTF-8 の各バイトが 3 桁の八進数になる。
// 文字ごとに復元せず、引用符や制御文字のエスケープもバイト列へ戻してから UTF-8 として読む。
function decodeGitPath(path) {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, "\\": 92 };
  const chunks = [];
  for (const match of path.slice(1, -1).matchAll(/\\([0-7]{3}|[abfnrtv"\\])|([^\\]+)/g)) {
    if (match[2]) chunks.push(Buffer.from(match[2], "utf8"));
    else chunks.push(Buffer.from([match[1].length === 3 ? parseInt(match[1], 8) : escapes[match[1]]]));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// 行コメントにならなかった指摘は、ここにしか説明が残らないので problem を添える。
function reviewBody(findings, round, report, allBodyOnly, offLine) {
  if (findings.length === 0) {
    return `review-pr のレビュー（${round} 周目）: 採用した指摘はありません。詳しくはレポート ${report}`;
  }
  const rows = findings.map((finding) => {
    const place = !finding.path || !finding.line
      ? "（行なし）"
      : !finding.onLine
        ? `${finding.path}:${finding.line}${offLine}`
        : allBodyOnly
          ? `${finding.path}:${finding.line}（行コメントの投稿に失敗）`
          : `${finding.path}:${finding.line} `;
    const head = `- ${finding.id} ${finding.severity} ${place}${finding.title}`;
    return allBodyOnly || !finding.onLine ? `${head}\n  ${finding.problem}` : head;
  });
  return `review-pr のレビュー（${round} 周目）: 採用した指摘 ${findings.length} 件。詳しくはレポート ${report}\n\n${rows.join("\n")}`;
}

function lineComments(findings, report) {
  return findings.map((finding) => ({
    path: finding.path,
    line: finding.line,
    side: "RIGHT",
    body: `**[${finding.id}・${finding.severity}] ${finding.title}**\n\n何が問題か: ${finding.problem}\n\nレポート: ${report} の ${finding.id}`,
  }));
}

// commit_id は送らない（省くと PR の最新コミットが対象になり、gh pr diff の行番号と一致する）。
function createReview(pr, body, comments) {
  const path = join(tempDir, "review.json");
  writeFileSync(path, JSON.stringify({ event: "COMMENT", body, comments }));
  return gh(["api", `repos/{owner}/{repo}/pulls/${pr}/reviews`, "-X", "POST", "-H", API_VERSION, "--input", path]);
}

// ---------------------------------------------------------------- reply

function reply() {
  const { pr, finding, fixed, summary, unresolved } = opt;
  const commentId = opt["comment-id"];
  if (!pr || !finding) fail("reply には --pr と --finding が必要です");
  if (fixed && unresolved) fail("--fixed と --unresolved は同時に指定できません");
  let text;
  if (fixed) {
    if (!summary) fail("--fixed には --summary が必要です");
    text = `${fixed} で修正しました。${summary}`;
  } else if (unresolved) {
    text = `未解決のまま残します。理由: ${unresolved.replace(/[。\s]+$/, "")}。選択肢と詳細はレポートの ${finding}。`;
  } else {
    fail("--fixed <SHA> --summary <要旨> か --unresolved <理由> のどちらかが必要です");
  }

  const failures = [];
  if (commentId) {
    const replied = gh([
      "api",
      `repos/{owner}/{repo}/pulls/${pr}/comments/${commentId}/replies`,
      "-X",
      "POST",
      "-H",
      API_VERSION,
      "-f",
      `body=${text}`,
    ]);
    if (replied.ok) console.log("返信しました");
    else failures.push(`返信: ${replied.stderr}`);
    // 修正の SHA と要旨がスレッドに残ってから、解決済みにする。
    if (fixed && replied.ok) {
      const threadId = findThread(pr, commentId, failures);
      if (threadId) {
        const resolved = gh(["api", "graphql", "-f", `query=${RESOLVE_MUTATION}`, "-f", `threadId=${threadId}`]);
        if (resolved.ok) console.log("resolve しました");
        else failures.push(`resolve: ${resolved.stderr}`);
      }
    }
  } else {
    const path = join(tempDir, "comment.md");
    writeFileSync(path, `${finding}: ${text}\n`);
    const commented = gh(["pr", "comment", String(pr), "--body-file", path]);
    if (commented.ok) console.log("コメントを投稿しました");
    else failures.push(`コメントの投稿: ${commented.stderr}`);
  }

  for (const failure of failures) console.error(`pr-threads: 失敗: ${failure}`);
  process.exit(failures.length > 0 ? 1 : 0);
}

// 先頭コメントの fullDatabaseId が comment-id と一致するスレッドを探す（databaseId は非推奨）。
function findThread(pr, commentId, failures) {
  const repo = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  if (!repo.ok) {
    failures.push(`スレッドの取得: リポジトリ名を取れません: ${repo.stderr}`);
    return null;
  }
  const [owner, name] = repo.stdout.trim().split("/");
  const result = gh([
    "api",
    "graphql",
    "-f",
    `query=${THREADS_QUERY}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${pr}`,
  ]);
  if (!result.ok) {
    failures.push(`スレッドの取得: ${result.stderr}`);
    return null;
  }
  const nodes = parseJson(result.stdout)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const hit = nodes.find((node) => String(node?.comments?.nodes?.[0]?.fullDatabaseId) === String(commentId));
  if (!hit) failures.push(`スレッドの取得: コメント ${commentId} のスレッドが見つかりません`);
  return hit?.id ?? null;
}
