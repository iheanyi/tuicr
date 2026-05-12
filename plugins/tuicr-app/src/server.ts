import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REVIEW_RESOURCE = "ui://tuicr-app/review.html";
const MCP_PATH = "/mcp";
const SESSION_ID_PATTERN = /^[a-f0-9]{24}$/;

export type LineKindValue = "context" | "added" | "removed";
export type LineSideValue = "new" | "old";
export type FileStatusValue = "added" | "modified" | "deleted" | "renamed" | "copied";
export type DiffSourceValue = "working_tree" | "staged" | "unstaged";
export type CommentScopeValue = "review" | "file" | "line";

export interface ReviewLine {
  kind: LineKindValue;
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface ReviewHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ReviewLine[];
}

export interface ReviewComment {
  id: string;
  type: string;
  body: string;
  createdAt: string;
  scope: CommentScopeValue;
  path: string | null;
  line: number | null;
  endLine: number | null;
  side: LineSideValue;
}

export interface ReviewFile {
  path: string;
  oldPath?: string | null;
  newPath?: string | null;
  status: FileStatusValue;
  header?: string;
  hunks: ReviewHunk[];
  reviewed?: boolean;
  fileComments?: ReviewComment[];
  lineComments?: ReviewComment[];
}

export interface ReviewSession {
  id: string;
  repoPath: string;
  branchName: string | null;
  baseCommit: string | null;
  diffSource: DiffSourceValue;
  createdAt: string;
  updatedAt: string;
  reviewComments: ReviewComment[];
  files: ReviewFile[];
}

interface GitRange {
  start: number;
  count: number;
}

interface RepoInfo {
  root: string;
  branch: string | null;
  head: string | null;
}

interface OpenSessionArgs {
  repoPath: string;
  diffSource?: DiffSourceValue;
  files?: ReviewFile[];
}

interface AddCommentInput {
  scope: CommentScopeValue;
  path?: string;
  line?: number;
  endLine?: number;
  side?: LineSideValue;
  type?: string;
  body: string;
}

interface ToolRecord {
  name: string;
  title?: string;
  description?: string;
  meta?: { ui: { resourceUri: string } };
}

interface CreateAppServerArgs {
  store: ReviewStore;
  defaultRepoPath?: string;
}

interface CreateHttpServerArgs {
  store?: ReviewStore;
  defaultRepoPath?: string;
}

export const LineKind = Object.freeze({
  Context: "context",
  Added: "added",
  Removed: "removed",
});

export const LineSide = Object.freeze({
  New: "new",
  Old: "old",
});

export const FileStatus = Object.freeze({
  Added: "added",
  Modified: "modified",
  Deleted: "deleted",
  Renamed: "renamed",
  Copied: "copied",
});

export const DiffSource = Object.freeze({
  WorkingTree: "working_tree",
  Staged: "staged",
  Unstaged: "unstaged",
});

export const CommentScope = Object.freeze({
  Review: "review",
  File: "file",
  Line: "line",
});

export const COMMENT_TYPES = Object.freeze({
  note: { label: "NOTE", definition: "observations" },
  suggestion: { label: "SUGGESTION", definition: "improvements" },
  issue: { label: "ISSUE", definition: "problems to fix" },
  praise: { label: "PRAISE", definition: "positive feedback" },
});

function nowIso(): string {
  return new Date().toISOString();
}

function normalizePathForDiff(path?: string): string | null {
  if (!path || path === "/dev/null") return null;
  return path.replace(/^[ab]\//, "");
}

function parseRange(raw: string): GitRange {
  const [start, count = "1"] = raw.split(",");
  return { start: Number(start), count: Number(count) };
}

function parseHunkHeader(header: string): { old: GitRange; new: GitRange } | null {
  const match = header.match(/^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?)/);
  if (!match) return null;
  return { old: parseRange(match[1]), new: parseRange(match[2]) };
}

function statusFromHeader(header: string, oldPath?: string | null, newPath?: string | null): FileStatusValue {
  if (header.includes("new file mode")) return FileStatus.Added;
  if (header.includes("deleted file mode")) return FileStatus.Deleted;
  if (header.includes("rename from ")) return FileStatus.Renamed;
  if (header.includes("copy from ")) return FileStatus.Copied;
  if (!oldPath) return FileStatus.Added;
  if (!newPath) return FileStatus.Deleted;
  return FileStatus.Modified;
}

export function parseUnifiedDiff(diffText: string): ReviewFile[] {
  const files: ReviewFile[] = [];
  let current: ReviewFile | null = null;
  let currentHunk: ReviewHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const finishFile = () => {
    if (!current) return;
    current.status = statusFromHeader(current.header ?? "", current.oldPath, current.newPath);
    current.path = current.newPath ?? current.oldPath ?? current.path;
    files.push(current);
  };

  const diffLines = diffText.split(/\r?\n/);
  if (diffLines.at(-1) === "") diffLines.pop();
  for (const rawLine of diffLines) {
    if (rawLine.startsWith("diff --git ")) {
      finishFile();
      const parts = rawLine.split(" ");
      current = {
        path: normalizePathForDiff(parts[3]) ?? normalizePathForDiff(parts[2]) ?? "",
        oldPath: normalizePathForDiff(parts[2]),
        newPath: normalizePathForDiff(parts[3]),
        status: FileStatus.Modified,
        header: `${rawLine}\n`,
        hunks: [],
      };
      currentHunk = null;
      continue;
    }
    if (!current) continue;
    if (rawLine.startsWith("--- ")) {
      current.oldPath = normalizePathForDiff(rawLine.slice(4).trim());
      current.header += `${rawLine}\n`;
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      current.newPath = normalizePathForDiff(rawLine.slice(4).trim());
      current.header += `${rawLine}\n`;
      continue;
    }
    if (rawLine.startsWith("@@ ")) {
      const parsed = parseHunkHeader(rawLine);
      if (!parsed) continue;
      oldLine = parsed.old.start;
      newLine = parsed.new.start;
      currentHunk = {
        header: rawLine,
        oldStart: parsed.old.start,
        oldCount: parsed.old.count,
        newStart: parsed.new.start,
        newCount: parsed.new.count,
        lines: [],
      };
      current.hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk) {
      current.header += `${rawLine}\n`;
      continue;
    }
    if (rawLine.startsWith("\\ No newline")) continue;

    const marker = rawLine[0] ?? " ";
    const content = rawLine.slice(1);
    if (marker === "+") {
      currentHunk.lines.push({
        kind: LineKind.Added,
        content,
        oldLine: null,
        newLine,
      });
      newLine += 1;
    } else if (marker === "-") {
      currentHunk.lines.push({
        kind: LineKind.Removed,
        content,
        oldLine,
        newLine: null,
      });
      oldLine += 1;
    } else {
      currentHunk.lines.push({
        kind: LineKind.Context,
        content: marker === " " ? content : rawLine,
        oldLine,
        newLine,
      });
      oldLine += 1;
      newLine += 1;
    }
  }
  finishFile();
  return files.filter((file) => file.path);
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
    maxBuffer: 25 * 1024 * 1024,
  });
  return stdout;
}

function addedFileDiff(path: string, content: string): ReviewFile {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return {
    path,
    oldPath: null,
    newPath: path,
    status: FileStatus.Added,
    header: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`,
    hunks: [{
      header: `@@ -0,0 +1,${lines.length} @@`,
      oldStart: 0,
      oldCount: 0,
      newStart: 1,
      newCount: lines.length,
      lines: lines.map((line, index) => ({
        kind: LineKind.Added,
        content: line,
        oldLine: null,
        newLine: index + 1,
      })),
    }],
    reviewed: false,
    fileComments: [],
    lineComments: [],
  };
}

async function loadUntrackedFiles(repoPath: string): Promise<ReviewFile[]> {
  const output = await git(repoPath, ["ls-files", "--others", "--exclude-standard"]);
  const paths = output.split(/\r?\n/).filter(Boolean);
  const files: ReviewFile[] = [];
  for (const path of paths) {
    try {
      const content = await readFile(resolve(repoPath, path), "utf8");
      files.push(addedFileDiff(path, content));
    } catch {
      files.push({
        path,
        oldPath: null,
        newPath: path,
        status: FileStatus.Added,
        header: `diff --git a/${path} b/${path}\nnew file mode 100644\nBinary files /dev/null and b/${path} differ\n`,
        hunks: [],
        reviewed: false,
        fileComments: [],
        lineComments: [],
      });
    }
  }
  return files;
}

export async function loadRepositoryDiff(
  repoPath: string,
  diffSource: DiffSourceValue = DiffSource.WorkingTree,
): Promise<ReviewFile[]> {
  const baseArgs = ["diff", "--no-ext-diff", "--find-renames"];
  let args = [...baseArgs, "HEAD"];
  if (diffSource === DiffSource.Staged) args = [...baseArgs, "--cached"];
  if (diffSource === DiffSource.Unstaged) args = [...baseArgs];
  let diff: string;
  try {
    diff = await git(repoPath, args);
  } catch (error) {
    if (diffSource !== DiffSource.WorkingTree) throw error;
    diff = await git(repoPath, baseArgs);
  }
  const files = parseUnifiedDiff(diff);
  if (diffSource === DiffSource.WorkingTree || diffSource === DiffSource.Unstaged) {
    files.push(...await loadUntrackedFiles(repoPath));
  }
  return files;
}

async function repoInfo(repoPath: string): Promise<RepoInfo> {
  const [root, branch, head] = await Promise.all([
    git(repoPath, ["rev-parse", "--show-toplevel"]).then((value) => value.trim()),
    git(repoPath, ["branch", "--show-current"]).then((value) => value.trim()).catch(() => ""),
    git(repoPath, ["rev-parse", "HEAD"]).then((value) => value.trim()).catch(() => ""),
  ]);
  return { root, branch: branch || null, head: head || null };
}

function sessionKey(repoPath: string, diffSource: DiffSourceValue): string {
  return createHash("sha256").update(`${resolve(repoPath)}:${diffSource}`).digest("hex").slice(0, 24);
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("Invalid session id. Expected a 24-character lowercase hex id.");
  }
}

export class ReviewStore {
  dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  sessionPath(sessionId: string): string {
    assertSessionId(sessionId);
    return resolve(this.dataDir, `${sessionId}.json`);
  }

  async readSession(sessionId: string): Promise<ReviewSession> {
    return JSON.parse(await readFile(this.sessionPath(sessionId), "utf8"));
  }

  async writeSession(session: ReviewSession): Promise<ReviewSession> {
    session.updatedAt = nowIso();
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.sessionPath(session.id), `${JSON.stringify(session, null, 2)}\n`);
    return session;
  }

  async openSession({ repoPath, diffSource = DiffSource.WorkingTree, files }: OpenSessionArgs): Promise<ReviewSession> {
    const repo = await repoInfo(repoPath).catch(() => ({
      root: resolve(repoPath),
      branch: null,
      head: null,
    }));
    const id = sessionKey(repo.root, diffSource);
    let existing: ReviewSession | null = null;
    try {
      existing = await this.readSession(id);
    } catch {
      existing = null;
    }
    const nextFiles = files ?? (await loadRepositoryDiff(repo.root, diffSource));
    const byPath = new Map<string, ReviewFile>((existing?.files ?? []).map((file) => [file.path, file]));
    const mergedFiles = nextFiles.map((file) => ({
      ...file,
      reviewed: byPath.get(file.path)?.reviewed ?? false,
      fileComments: byPath.get(file.path)?.fileComments ?? [],
      lineComments: byPath.get(file.path)?.lineComments ?? [],
    }));
    const session: ReviewSession = {
      id,
      repoPath: repo.root,
      branchName: repo.branch,
      baseCommit: repo.head,
      diffSource,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      reviewComments: existing?.reviewComments ?? [],
      files: mergedFiles,
    };
    return this.writeSession(session);
  }

  async getSession(sessionId: string): Promise<ReviewSession> {
    return this.readSession(sessionId);
  }

  async addComment(sessionId: string, input: AddCommentInput): Promise<ReviewSession> {
    const session = await this.readSession(sessionId);
    const comment = {
      id: randomUUID(),
      type: input.type ?? "note",
      body: input.body ?? "",
      createdAt: nowIso(),
      scope: input.scope,
      path: input.path ?? null,
      line: input.line ?? null,
      endLine: input.endLine ?? null,
      side: input.side ?? LineSide.New,
    };
    if (comment.scope === CommentScope.Review) {
      session.reviewComments.push(comment);
    } else {
      const file = session.files.find((candidate) => candidate.path === comment.path);
      if (!file) throw new Error(`Unknown review file: ${comment.path}`);
      file.fileComments ??= [];
      file.lineComments ??= [];
      if (comment.scope === CommentScope.File) file.fileComments.push(comment);
      else file.lineComments.push(comment);
    }
    return this.writeSession(session);
  }

  async setFileReviewed(sessionId: string, filePath: string, reviewed: boolean): Promise<ReviewSession> {
    const session = await this.readSession(sessionId);
    const file = session.files.find((candidate) => candidate.path === filePath);
    if (!file) throw new Error(`Unknown review file: ${filePath}`);
    file.reviewed = Boolean(reviewed);
    return this.writeSession(session);
  }

  async clear(sessionId: string): Promise<ReviewSession> {
    const session = await this.readSession(sessionId);
    session.reviewComments = [];
    for (const file of session.files) {
      file.reviewed = false;
      file.fileComments = [];
      file.lineComments = [];
    }
    return this.writeSession(session);
  }

  async exportMarkdown(sessionId: string): Promise<string> {
    const session = await this.readSession(sessionId);
    const entries: Array<{ location: string; type: string; body: string }> = [];
    for (const comment of session.reviewComments) {
      entries.push({
        location: `Review Comment (scope: ${scopeLabel(session.diffSource)})`,
        type: comment.type,
        body: comment.body,
      });
    }
    for (const file of [...session.files].sort((a, b) => a.path.localeCompare(b.path))) {
      for (const comment of file.fileComments ?? []) {
        entries.push({ location: file.path, type: comment.type, body: comment.body });
      }
      for (const comment of file.lineComments ?? []) {
        const sidePrefix = comment.side === LineSide.Old ? "~" : "";
        const range = comment.endLine && comment.endLine !== comment.line
          ? `${sidePrefix}${comment.line}-${sidePrefix}${comment.endLine}`
          : `${sidePrefix}${comment.line}`;
        entries.push({
          location: `${file.path}:${range}`,
          type: comment.type,
          body: comment.body,
        });
      }
    }
    if (entries.length === 0) throw new Error("No comments to export");

    const usedTypes = [...new Set(entries.map((entry) => entry.type))];
    const legend = usedTypes
      .map((type) => `${typeLabel(type)} (${COMMENT_TYPES[type as keyof typeof COMMENT_TYPES]?.definition ?? type})`)
      .join(", ");
    const lines = [
      "I reviewed your code and have the following comments. Please address them.",
      "",
      `Comment types: ${legend}`,
      "",
    ];
    entries.forEach((entry, index) => {
      lines.push(`${index + 1}. **[${typeLabel(entry.type)}]** \`${entry.location}\` - ${entry.body}`);
    });
    return `${lines.join("\n")}\n`;
  }
}

export function typeLabel(type: string): string {
  return COMMENT_TYPES[type as keyof typeof COMMENT_TYPES]?.label ?? String(type).toUpperCase();
}

export function scopeLabel(diffSource: DiffSourceValue): string {
  if (diffSource === DiffSource.Staged) return "staged changes";
  if (diffSource === DiffSource.Unstaged) return "unstaged changes";
  return "working tree changes";
}

function appResourceLink() {
  return {
    type: "resource_link",
    uri: REVIEW_RESOURCE,
    name: "tuicr-review-widget",
    title: "tuicr Review",
    description: "Interactive tuicr code review app",
    mimeType: RESOURCE_MIME_TYPE,
    _meta: {
      ui: { resourceUri: REVIEW_RESOURCE },
    },
  };
}

function countChangedLines(file: ReviewFile): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === LineKind.Added) added += 1;
      if (line.kind === LineKind.Removed) removed += 1;
    }
  }
  return { added, removed };
}

function sessionSummary(session: ReviewSession): string {
  const fileList = session.files
    .slice(0, 20)
    .map((file) => {
      const stats = countChangedLines(file);
      return `- ${file.path} (${file.status}, +${stats.added}/-${stats.removed})`;
    })
    .join("\n");
  const remaining = Math.max(session.files.length - 20, 0);
  const suffix = remaining > 0 ? `\n- ...and ${remaining} more` : "";
  return [
    `Review session ${session.id} for ${session.repoPath}`,
    `Branch: ${session.branchName ?? "(detached or unknown)"}`,
    `Diff source: ${session.diffSource}`,
    `Files: ${session.files.length}`,
    fileList ? `\nLoaded files:\n${fileList}${suffix}` : "\nLoaded files: none",
    "\nFor agent review, call get_file_diff with this sessionId and a file path to inspect line-numbered diff content. Follow-up tools intentionally do not render another app embed.",
  ].join("\n");
}

export function createSessionToolResult(session: ReviewSession, message = "", includeAppResource = false) {
  return {
    content: [
      ...(message ? [{ type: "text", text: message }] : []),
      { type: "text", text: sessionSummary(session) },
      ...(includeAppResource ? [appResourceLink()] : []),
    ],
    structuredContent: { session },
  };
}

function renderDiffLine(line: ReviewLine): string {
  const marker = line.kind === LineKind.Added ? "+" : line.kind === LineKind.Removed ? "-" : " ";
  const oldLine = line.oldLine === null ? "-" : String(line.oldLine);
  const newLine = line.newLine === null ? "-" : String(line.newLine);
  return `${marker} old:${oldLine} new:${newLine} ${line.content}`;
}

function renderFileDiff(file: ReviewFile, maxLines = 500): { diff: string; truncated: boolean } {
  const lines: string[] = [
    `File: ${file.path}`,
    `Status: ${file.status}`,
  ];
  const stats = countChangedLines(file);
  lines.push(`Changed lines: +${stats.added}/-${stats.removed}`);
  if (file.oldPath && file.oldPath !== file.path) lines.push(`Old path: ${file.oldPath}`);
  lines.push("");

  if (file.hunks.length === 0) {
    lines.push(file.header?.trim() || "No text hunks available, likely a binary or metadata-only change.");
    return { diff: lines.join("\n"), truncated: false };
  }

  let truncated = false;
  for (const hunk of file.hunks) {
    if (lines.length >= maxLines) {
      truncated = true;
      break;
    }
    lines.push(hunk.header);
    for (const line of hunk.lines) {
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
      lines.push(renderDiffLine(line));
    }
  }
  if (truncated) lines.push(`...truncated after ${maxLines} lines. Call get_file_diff again with a higher maxLines value if needed.`);
  return { diff: lines.join("\n"), truncated };
}

export function createFileDiffToolResult(session: ReviewSession, path: string, maxLines?: number) {
  const file = session.files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`Unknown review file: ${path}`);
  const rendered = renderFileDiff(file, maxLines);
  return {
    content: [{ type: "text", text: rendered.diff }],
    structuredContent: {
      session,
      path: file.path,
      diff: rendered.diff,
      truncated: rendered.truncated,
    },
  };
}

function reply(session: ReviewSession, message = "", includeAppResource = false) {
  return createSessionToolResult(session, message, includeAppResource);
}

function readWidgetHtml(): string {
  try {
    return readFileSync(resolve(ROOT, "dist", "review-widget.html"), "utf8");
  } catch {
    return readFileSync(resolve(ROOT, "public", "review-widget.html"), "utf8");
  }
}

const sessionIdField = z.string()
  .regex(SESSION_ID_PATTERN, "Session id must be a 24-character lowercase hex id.");
const sessionIdSchema = z.object({ sessionId: sessionIdField });
const fileDiffSchema = z.object({
  sessionId: sessionIdField,
  path: z.string().min(1),
  maxLines: z.number().int().positive().max(2000).optional(),
});
const getReviewSchema = z.object({
  sessionId: sessionIdField.optional().describe("Existing review session id. Mutually exclusive with repoPath."),
  repoPath: z.string().min(1).optional().describe("Repository path to open or refresh. Mutually exclusive with sessionId."),
  diffSource: z.enum([DiffSource.WorkingTree, DiffSource.Staged, DiffSource.Unstaged]).optional(),
});
const openReviewSchema = z.object({
  repoPath: z.string().optional(),
  diffSource: z.enum([DiffSource.WorkingTree, DiffSource.Staged, DiffSource.Unstaged]).optional(),
});
const addCommentSchema = z.object({
  sessionId: sessionIdField,
  scope: z.enum([CommentScope.Review, CommentScope.File, CommentScope.Line]),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  side: z.enum([LineSide.New, LineSide.Old]).optional(),
  type: z.string().default("note"),
  body: z.string().min(1),
});
const reviewedSchema = z.object({
  sessionId: sessionIdField,
  path: z.string().min(1),
  reviewed: z.boolean(),
});

const sessionOutputSchema = z.object({ session: z.any() });
const fileDiffOutputSchema = z.object({
  session: z.any(),
  path: z.string(),
  diff: z.string(),
  truncated: z.boolean(),
});
const exportOutputSchema = z.object({ markdown: z.string() });

export function resolveGetReviewRequest(args: z.infer<typeof getReviewSchema>): { sessionId: string } | { repoPath: string; diffSource: DiffSourceValue } {
  if (args.sessionId && args.repoPath) throw new Error("get_review expects either sessionId or repoPath, not both.");
  if (!args.sessionId && !args.repoPath) throw new Error("get_review expects either sessionId or repoPath.");
  if (args.sessionId) {
    assertSessionId(args.sessionId);
    if (args.diffSource) throw new Error("get_review diffSource is only valid when opening by repoPath.");
    return { sessionId: args.sessionId };
  }
  return { repoPath: args.repoPath as string, diffSource: args.diffSource ?? DiffSource.WorkingTree };
}

function createToolList(tools: ToolRecord[]) {
  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: {},
      ...(tool.meta ? { _meta: tool.meta } : {}),
    })),
  };
}

export function createReviewResourceContents(html: string) {
  return {
    contents: [{
      uri: REVIEW_RESOURCE,
      mimeType: RESOURCE_MIME_TYPE,
      text: html,
      _meta: {
        ui: {
          csp: {
            connectDomains: [],
            resourceDomains: [],
          },
          permissions: {
            clipboardWrite: {},
          },
        },
      },
    }],
  };
}

export function createTuicrAppServer({ store, defaultRepoPath = process.cwd() }: CreateAppServerArgs) {
  const mcp = new McpServer({ name: "tuicr-app", version: "0.1.0" });
  const html = readWidgetHtml();
  const tools: ToolRecord[] = [];

  registerAppResource(mcp, "tuicr Review", REVIEW_RESOURCE, {
    description: "Interactive tuicr code review app",
    mimeType: RESOURCE_MIME_TYPE,
  }, async () => createReviewResourceContents(html));

  const addTool = (
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: z.ZodTypeAny;
      outputSchema: z.ZodTypeAny;
      app?: boolean;
    },
    handler: (args: any) => Promise<any>,
  ) => {
    const { app, ...toolConfig } = config;
    const meta = app ? { ui: { resourceUri: REVIEW_RESOURCE } } : undefined;
    tools.push({ name, title: config.title, description: config.description, meta });
    if (meta) {
      registerAppTool(mcp, name, { ...toolConfig, _meta: meta }, handler);
    } else {
      mcp.registerTool(name, toolConfig, handler);
    }
  };

  addTool("open_review", {
    title: "Open tuicr review",
    description: "Open or refresh a code review session for a local repository diff.",
    inputSchema: openReviewSchema,
    outputSchema: sessionOutputSchema,
    app: true,
  }, async (args) => {
    const session = await store.openSession({
      repoPath: args.repoPath ?? defaultRepoPath,
      diffSource: args.diffSource ?? DiffSource.WorkingTree,
    });
    return reply(session, `Opened review for ${session.repoPath}.`, true);
  });

  addTool("get_review", {
    title: "Get tuicr review",
    description: "Return a review session by sessionId, or open/refresh a repoPath. Provide exactly one of sessionId or repoPath.",
    inputSchema: getReviewSchema,
    outputSchema: sessionOutputSchema,
  }, async (args) => {
    const request = resolveGetReviewRequest(args);
    if ("repoPath" in request) {
      const session = await store.openSession({
        repoPath: request.repoPath ?? defaultRepoPath,
        diffSource: request.diffSource,
      });
      return reply(session);
    }
    return reply(await store.getSession(request.sessionId));
  });

  addTool("get_file_diff", {
    title: "Get file diff",
    description: "Return line-numbered diff content for one file in a review session. Use this after get_review to inspect changes without rendering another app embed.",
    inputSchema: fileDiffSchema,
    outputSchema: fileDiffOutputSchema,
  }, async (args) => createFileDiffToolResult(await store.getSession(args.sessionId), args.path, args.maxLines));

  addTool("add_comment", {
    title: "Add review comment",
    description: "Add a review-level, file-level, or line-level comment.",
    inputSchema: addCommentSchema,
    outputSchema: sessionOutputSchema,
  }, async (args) => reply(await store.addComment(args.sessionId, args), "Comment added."));

  addTool("set_file_reviewed", {
    title: "Set file reviewed",
    description: "Mark a file as reviewed or unreviewed.",
    inputSchema: reviewedSchema,
    outputSchema: sessionOutputSchema,
  }, async (args) => reply(await store.setFileReviewed(args.sessionId, args.path, args.reviewed)));

  addTool("clear_review", {
    title: "Clear review",
    description: "Clear all comments and reviewed marks in a session.",
    inputSchema: sessionIdSchema,
    outputSchema: sessionOutputSchema,
  }, async (args) => reply(await store.clear(args.sessionId), "Review cleared."));

  addTool("export_review", {
    title: "Export review",
    description: "Export the review as agent-consumable Markdown.",
    inputSchema: sessionIdSchema,
    outputSchema: exportOutputSchema,
  }, async (args) => {
    const markdown = await store.exportMarkdown(args.sessionId);
    return {
      content: [{ type: "text", text: markdown }],
      structuredContent: { markdown },
    };
  });

  return {
    mcp,
    listTools: async () => createToolList(tools),
  };
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function writeJson(res: ServerResponse, status: number, body: unknown): Promise<void> {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

function defaultStore(): ReviewStore {
  const base = process.env.TUICR_APP_DATA_DIR
    ?? resolve(process.env.HOME ?? process.cwd(), ".local", "share", "tuicr-app", "reviews");
  return new ReviewStore(base);
}

export function createHttpServer({
  store = defaultStore(),
  defaultRepoPath = process.cwd(),
}: CreateHttpServerArgs = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type, mcp-session-id",
        "access-control-expose-headers": "Mcp-Session-Id",
      }).end();
      return;
    }
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/plain" }).end("tuicr MCP app server");
        return;
      }
      if (req.method === "GET" && url.pathname === "/preview") {
        res.writeHead(200, { "content-type": "text/html" }).end(readWidgetHtml());
        return;
      }
      if (url.pathname === MCP_PATH && ["POST", "GET", "DELETE"].includes(req.method ?? "")) {
        res.setHeader("access-control-allow-origin", "*");
        res.setHeader("access-control-expose-headers", "Mcp-Session-Id");
        const app = createTuicrAppServer({ store, defaultRepoPath });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          transport.close();
          app.mcp.close();
        });
        await app.mcp.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/open") {
        const body = await readJson(req);
        const session = await store.openSession({
          repoPath: body.repoPath ?? defaultRepoPath,
          diffSource: body.diffSource ?? DiffSource.WorkingTree,
        });
        await writeJson(res, 200, { session });
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/session/")) {
        const sessionId = url.pathname.split("/").pop();
        if (!sessionId) throw new Error("Missing session id");
        await writeJson(res, 200, { session: await store.getSession(sessionId) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/comment") {
        const body = await readJson(req);
        await writeJson(res, 200, { session: await store.addComment(body.sessionId, body) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/reviewed") {
        const body = await readJson(req);
        await writeJson(res, 200, {
          session: await store.setFileReviewed(body.sessionId, body.path, body.reviewed),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/clear") {
        const body = await readJson(req);
        await writeJson(res, 200, { session: await store.clear(body.sessionId) });
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/export/")) {
        const sessionId = url.pathname.split("/").pop();
        if (!sessionId) throw new Error("Missing session id");
        await writeJson(res, 200, { markdown: await store.exportMarkdown(sessionId) });
        return;
      }
      res.writeHead(404).end("Not Found");
    } catch (error) {
      await writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export function startHttpServer() {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  const defaultRepoPath = process.env.TUICR_REPO ?? process.cwd();
  const server = createHttpServer({ defaultRepoPath });
  server.listen(port, host, () => {
    const displayHost = host === "0.0.0.0" ? "localhost" : host;
    console.log(`tuicr MCP app listening on http://${displayHost}:${port}${MCP_PATH}`);
    console.log(`Preview UI: http://${displayHost}:${port}/preview`);
  });
  return server;
}

export async function startStdioServer() {
  const defaultRepoPath = process.env.TUICR_REPO ?? process.cwd();
  const store = defaultStore();
  const app = createTuicrAppServer({ store, defaultRepoPath });
  const transport = new StdioServerTransport();
  await app.mcp.connect(transport);
  return app.mcp;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startHttpServer();
}
