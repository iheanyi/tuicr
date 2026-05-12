import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  COMMENT_TYPES,
  CommentScope,
  DiffSource,
  FileStatus,
  LineKind,
  LineSide,
  ReviewStore,
  createFileDiffToolResult,
  createReviewResourceContents,
  createSessionToolResult,
  createTuicrAppServer,
  loadRepositoryDiff,
  parseUnifiedDiff,
  resolveGetReviewRequest,
} from "../src/server.ts";

const execFileAsync = promisify(execFile);

test("parseUnifiedDiff keeps file hunks and line sides", () => {
  const diff = `diff --git a/src/main.rs b/src/main.rs
index 1111111..2222222 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,4 @@
 fn main() {
-    println!("old");
+    println!("new");
+    println!("extra");
 }
`;

  const files = parseUnifiedDiff(diff);

  assert.equal(files.length, 1);
  assert.equal(files[0].path, "src/main.rs");
  assert.equal(files[0].status, FileStatus.Modified);
  assert.deepEqual(
    files[0].hunks[0].lines.map((line) => line.kind),
    [LineKind.Context, LineKind.Removed, LineKind.Added, LineKind.Added, LineKind.Context],
  );
  assert.equal(files[0].hunks[0].lines[1].oldLine, 2);
  assert.equal(files[0].hunks[0].lines[1].newLine, null);
  assert.equal(files[0].hunks[0].lines[2].oldLine, null);
  assert.equal(files[0].hunks[0].lines[2].newLine, 2);
});

test("ReviewStore exports agent markdown with review, file, and line comments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tuicr-app-"));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  const store = new ReviewStore(path.join(root, "data"));
  const session = await store.openSession({
    repoPath: repo,
    diffSource: DiffSource.WorkingTree,
    files: [{ path: "src/main.rs", status: FileStatus.Modified, hunks: [] }],
  });

  await store.addComment(session.id, {
    scope: CommentScope.Review,
    type: "note",
    body: "Overall note",
  });
  await store.addComment(session.id, {
    scope: CommentScope.File,
    path: "src/main.rs",
    type: "suggestion",
    body: "File note",
  });
  await store.addComment(session.id, {
    scope: CommentScope.Line,
    path: "src/main.rs",
    line: 42,
    side: LineSide.New,
    type: "issue",
    body: "Line note",
  });

  const markdown = await store.exportMarkdown(session.id);

  assert.match(markdown, /I reviewed your code and have the following comments\./);
  assert.match(
    markdown,
    /Comment types: NOTE \(observations\), SUGGESTION \(improvements\), ISSUE \(problems to fix\)/,
  );
  assert.match(
    markdown,
    /1\. \*\*\[NOTE\]\*\* `Review Comment \(scope: working tree changes\)` - Overall note/,
  );
  assert.match(markdown, /2\. \*\*\[SUGGESTION\]\*\* `src\/main\.rs` - File note/);
  assert.match(markdown, /3\. \*\*\[ISSUE\]\*\* `src\/main\.rs:42` - Line note/);
});

test("createTuicrAppServer registers only open_review with app UI metadata", async () => {
  const server = createTuicrAppServer({
    store: new ReviewStore(path.join(await mkdtemp(path.join(tmpdir(), "tuicr-app-")), "data")),
    defaultRepoPath: process.cwd(),
  });

  const tools = await server.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();

  assert.deepEqual(names, [
    "add_comment",
    "clear_review",
    "export_review",
    "get_file_diff",
    "get_review",
    "open_review",
    "set_file_reviewed",
  ]);
  assert.equal(tools.tools.find((tool) => tool.name === "open_review")?._meta?.ui?.resourceUri, "ui://tuicr-app/review.html");
  assert.equal(tools.tools.find((tool) => tool.name === "get_review")?._meta, undefined);
  assert.equal(tools.tools.find((tool) => tool.name === "get_file_diff")?._meta, undefined);
  assert.equal(COMMENT_TYPES.issue.label, "ISSUE");
});

test("review app resource requests clipboard write permission", () => {
  const resource = createReviewResourceContents("<html></html>");
  const content = resource.contents[0];

  assert.equal(content.uri, "ui://tuicr-app/review.html");
  assert.equal(content.mimeType, "text/html;profile=mcp-app");
  assert.deepEqual(content._meta.ui.permissions, { clipboardWrite: {} });
});

test("session tool results keep follow-up responses model-readable without duplicate app embeds", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tuicr-app-"));
  const store = new ReviewStore(path.join(root, "data"));
  const session = await store.openSession({
    repoPath: root,
    files: [{ path: "src/main.rs", status: FileStatus.Modified, hunks: [] }],
  });

  const openResult = createSessionToolResult(session, "Opened review.", true);
  const refreshResult = createSessionToolResult(session, "Review refreshed.");

  assert.equal(openResult.content.filter((item) => item.type === "resource_link").length, 1);
  assert.equal(refreshResult.content.filter((item) => item.type === "resource_link").length, 0);
  assert.ok(refreshResult.content.some((item) => item.type === "text" && "text" in item && item.text.includes("src/main.rs")));
  assert.ok(refreshResult.content.some((item) => item.type === "text" && "text" in item && item.text.includes("get_file_diff")));
});

test("resolveGetReviewRequest requires a strict sessionId or repoPath shape", () => {
  assert.deepEqual(resolveGetReviewRequest({ sessionId: "841072e50f2fe378b09ea6b5" }), {
    sessionId: "841072e50f2fe378b09ea6b5",
  });
  assert.deepEqual(resolveGetReviewRequest({ repoPath: "/tmp/repo" }), {
    repoPath: "/tmp/repo",
    diffSource: DiffSource.WorkingTree,
  });
  assert.deepEqual(resolveGetReviewRequest({ repoPath: "/tmp/repo", diffSource: DiffSource.Staged }), {
    repoPath: "/tmp/repo",
    diffSource: DiffSource.Staged,
  });
  assert.throws(
    () => resolveGetReviewRequest({ sessionId: "not/a/session" }),
    /Invalid session id/,
  );
  assert.throws(
    () => resolveGetReviewRequest({ sessionId: "841072e50f2fe378b09ea6b5", repoPath: "/tmp/repo" }),
    /either sessionId or repoPath, not both/,
  );
  assert.throws(
    () => resolveGetReviewRequest({}),
    /either sessionId or repoPath/,
  );
  assert.throws(
    () => resolveGetReviewRequest({ sessionId: "841072e50f2fe378b09ea6b5", diffSource: DiffSource.Staged }),
    /diffSource is only valid/,
  );
});

test("createFileDiffToolResult returns line-numbered diff text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tuicr-app-"));
  const store = new ReviewStore(path.join(root, "data"));
  const session = await store.openSession({
    repoPath: root,
    files: [{
      path: "src/main.rs",
      status: FileStatus.Modified,
      hunks: [{
        header: "@@ -1,1 +1,1 @@",
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 1,
        lines: [
          { kind: LineKind.Removed, content: "old", oldLine: 1, newLine: null },
          { kind: LineKind.Added, content: "new", oldLine: null, newLine: 1 },
        ],
      }],
    }],
  });

  const result = createFileDiffToolResult(session, "src/main.rs");
  const text = result.content[0].text;

  assert.match(text, /File: src\/main\.rs/);
  assert.match(text, /- old:1 new:- old/);
  assert.match(text, /\+ old:- new:1 new/);
});

test("loadRepositoryDiff includes untracked text files as added diffs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tuicr-app-"));
  await exec("git", ["init"], root);
  await exec("git", ["config", "user.email", "test@example.com"], root);
  await exec("git", ["config", "user.name", "Test User"], root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "README.md"), "base\n");
  await exec("git", ["add", "README.md"], root);
  await exec("git", ["commit", "-m", "base"], root);
  await writeFile(path.join(root, "src", "new.js"), "const value = 1;\n");

  const files = await loadRepositoryDiff(root, DiffSource.WorkingTree);
  const added = files.find((file) => file.path === "src/new.js");

  assert.ok(added);
  assert.equal(added.status, FileStatus.Added);
  assert.equal(added.hunks[0].lines[0].kind, LineKind.Added);
  assert.equal(added.hunks[0].lines[0].newLine, 1);
});

test("loadRepositoryDiff working_tree includes staged tracked changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tuicr-app-"));
  await exec("git", ["init"], root);
  await exec("git", ["config", "user.email", "test@example.com"], root);
  await exec("git", ["config", "user.name", "Test User"], root);
  await writeFile(path.join(root, "README.md"), "base\n");
  await exec("git", ["add", "README.md"], root);
  await exec("git", ["commit", "-m", "base"], root);
  await writeFile(path.join(root, "README.md"), "base\nstaged\n");
  await exec("git", ["add", "README.md"], root);

  const workingTreeFiles = await loadRepositoryDiff(root, DiffSource.WorkingTree);
  const unstagedFiles = await loadRepositoryDiff(root, DiffSource.Unstaged);

  assert.ok(workingTreeFiles.some((file) => file.path === "README.md"));
  assert.equal(unstagedFiles.some((file) => file.path === "README.md"), false);
});

async function exec(command: string, args: string[], cwd: string): Promise<void> {
  await execFileAsync(command, args, { cwd });
}
