import {
  ArrowPathIcon,
  ArrowsPointingOutIcon,
  ChatBubbleLeftRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardDocumentCheckIcon,
  CodeBracketIcon,
  DocumentTextIcon,
  MagnifyingGlassIcon,
  PaperAirplaneIcon,
  PlusIcon,
  XMarkIcon,
} from "@heroicons/react/16/solid";
import { useEffect, useMemo, useRef, useState } from "react";

import { callTool, isLocalPreview, observeEmbedSize, onToolResult, requestDisplayMode, sendReviewToAgent } from "./api.js";
import type {
  CommentScope,
  CommentType,
  DiffSource,
  LineSide,
  ReviewComment,
  ReviewFile,
  ReviewLine,
  ReviewSession,
  SelectedLine,
} from "./types.js";

const COMMENT_TYPES: Array<{ id: CommentType; label: string }> = [
  { id: "note", label: "NOTE" },
  { id: "suggestion", label: "SUGGESTION" },
  { id: "issue", label: "ISSUE" },
  { id: "praise", label: "PRAISE" },
];

const DIFF_SOURCES: Array<{ id: DiffSource; label: string }> = [
  { id: "working_tree", label: "Working tree" },
  { id: "staged", label: "Staged" },
  { id: "unstaged", label: "Unstaged" },
];

type FileFilter = "all" | "open" | "reviewed" | "commented";

interface CommentEntry extends ReviewComment {
  label: string;
}

export function App() {
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedLine, setSelectedLine] = useState<SelectedLine | null>(null);
  const [commentScope, setCommentScope] = useState<CommentScope>("review");
  const [commentType, setCommentType] = useState<CommentType>("note");
  const [commentBody, setCommentBody] = useState("");
  const [diffSource, setDiffSource] = useState<DiffSource>("working_tree");
  const [fileFilter, setFileFilter] = useState<FileFilter>("all");
  const [query, setQuery] = useState("");
  const [exported, setExported] = useState("");
  const [copied, setCopied] = useState(false);
  const [sentToChat, setSentToChat] = useState(false);
  const [busy, setBusy] = useState<null | "open" | "comment" | "reviewed" | "export" | "clear" | "send">(null);
  const [error, setError] = useState<string | null>(null);
  const exportTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedFile = useMemo(() => {
    if (!session) return null;
    return session.files.find((file) => file.path === selectedPath) ?? session.files[0] ?? null;
  }, [selectedPath, session]);

  const stats = useMemo(() => summarizeSession(session), [session]);
  const comments = useMemo(() => flattenComments(session), [session]);

  const visibleFiles = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (session?.files ?? []).filter((file) => {
      if (normalizedQuery && !file.path.toLowerCase().includes(normalizedQuery)) return false;
      if (fileFilter === "open" && file.reviewed) return false;
      if (fileFilter === "reviewed" && !file.reviewed) return false;
      if (fileFilter === "commented" && commentCount(file) === 0) return false;
      return true;
    });
  }, [fileFilter, query, session]);

  useEffect(() => {
    const unsubscribe = onToolResult((result) => {
      const nextSession = result.structuredContent?.session ?? null;
      if (!nextSession) return;
      setDiffSource(nextSession.diffSource);
      applySessionResult(nextSession);
    });
    if (isLocalPreview) void openReview(diffSource);
    return unsubscribe;
  }, []);

  useEffect(() => observeEmbedSize(), []);

  useEffect(() => {
    if (isLocalPreview || !session?.id) return;
    const sessionId = session.id;
    const refreshSession = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const result = await callTool("get_review", { sessionId });
        applySessionResult(result.structuredContent?.session);
      } catch {
        // Background refresh should not interrupt the review UI.
      }
    };
    const interval = window.setInterval(refreshSession, 5000);
    return () => window.clearInterval(interval);
  }, [session?.id]);

  function applyOpenedSession(nextSession: ReviewSession | null, source?: DiffSource) {
    setSession(nextSession);
    setDiffSource(source ?? nextSession?.diffSource ?? "working_tree");
    setSelectedPath((path) => {
      if (path && nextSession?.files.some((file) => file.path === path)) return path;
      return nextSession?.files[0]?.path ?? null;
    });
    setSelectedLine(null);
    setExported("");
  }

  async function openReview(source = diffSource) {
    setBusy("open");
    setError(null);
    try {
      const args: Record<string, unknown> = { diffSource: source };
      if (session?.repoPath) args.repoPath = session.repoPath;
      const result = await callTool("open_review", args);
      const nextSession = result.structuredContent?.session ?? null;
      applyOpenedSession(nextSession, source);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function addComment() {
    if (!session) return;
    const body = commentBody.trim();
    if (!body) return;
    if ((commentScope === "file" || commentScope === "line") && !selectedFile) {
      setError("Pick a file before adding this comment.");
      return;
    }
    if (commentScope === "line" && !selectedLine) {
      setError("Pick a diff line before adding a line comment.");
      return;
    }

    setBusy("comment");
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        sessionId: session.id,
        scope: commentScope,
        type: commentType,
        body,
      };
      if (commentScope === "file" || commentScope === "line") payload.path = selectedFile?.path;
      if (commentScope === "line") {
        payload.line = selectedLine?.line;
        payload.side = selectedLine?.side ?? "new";
      }
      const result = await callTool("add_comment", payload);
      applySessionResult(result.structuredContent?.session);
      setCommentBody("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function setReviewed(reviewed: boolean) {
    if (!session || !selectedFile) return;
    setBusy("reviewed");
    setError(null);
    try {
      const result = await callTool("set_file_reviewed", {
        sessionId: session.id,
        path: selectedFile.path,
        reviewed,
      });
      applySessionResult(result.structuredContent?.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function exportReview() {
    if (!session) return;
    setBusy("export");
    setError(null);
    try {
      await refreshExportedReview();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function clearReview() {
    if (!session) return;
    setBusy("clear");
    setError(null);
    try {
      const result = await callTool("clear_review", { sessionId: session.id });
      applySessionResult(result.structuredContent?.session);
      setSelectedLine(null);
      setExported("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function refreshExportedReview(): Promise<string> {
    if (!session) return "";
    const result = await callTool("export_review", { sessionId: session.id });
    const markdown = result.structuredContent?.markdown ?? result.content?.[0]?.text ?? "";
    setExported(markdown);
    return markdown;
  }

  async function copyExport() {
    if (!exported) return;
    setError(null);
    let copySucceeded = false;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(exported);
        copySucceeded = true;
      }
    } catch {
      copySucceeded = false;
    }

    if (!copySucceeded && exportTextareaRef.current) {
      exportTextareaRef.current.focus();
      exportTextareaRef.current.select();
      exportTextareaRef.current.setSelectionRange(0, exported.length);

      try {
        copySucceeded = document.execCommand("copy");
      } catch {
        copySucceeded = false;
      }
    }

    if (!copySucceeded) {
      setError("Copy was blocked by the host. Press Command-C while the exported review text is selected.");
      return;
    }

    exportTextareaRef.current?.blur();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  async function sendExportToAgent() {
    if (!session) return;
    setBusy("send");
    setError(null);
    setSentToChat(false);
    try {
      const markdown = exported || await refreshExportedReview();
      if (!markdown) throw new Error("Nothing to send. Add a comment or export the review first.");
      await sendReviewToAgent(markdown);
      setSentToChat(true);
      window.setTimeout(() => setSentToChat(false), 1800);
    } catch (err) {
      exportTextareaRef.current?.focus();
      exportTextareaRef.current?.select();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function applySessionResult(nextSession?: ReviewSession) {
    if (!nextSession) return;
    setSession(nextSession);
    setSelectedPath((path) => {
      if (path && nextSession.files.some((file) => file.path === path)) return path;
      return nextSession.files[0]?.path ?? null;
    });
  }

  function selectLine(file: ReviewFile, line: ReviewLine) {
    const displayLine = line.kind === "removed" ? line.oldLine : line.newLine;
    if (!displayLine) return;
    setSelectedPath(file.path);
    setSelectedLine({ path: file.path, line: displayLine, side: line.kind === "removed" ? "old" : "new" });
    setCommentScope("line");
    setError(null);
  }

  return (
    <main className={`app-shell ${isLocalPreview ? "local-preview" : "embedded"}`}>
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">
            <CodeBracketIcon aria-hidden="true" />
          </div>
          <div>
            <h1>tuicr review</h1>
            <p>{session ? formatRepo(session.repoPath, session.branchName) : "Opening review session..."}</p>
          </div>
        </div>
        <div className="toolbar">
          <label className="select-wrap">
            <span>Diff scope</span>
            <select
              name="diffSource"
              value={diffSource}
              onChange={(event) => void openReview(event.target.value as DiffSource)}
              disabled={busy === "open"}
            >
              {DIFF_SOURCES.map((source) => (
                <option key={source.id} value={source.id}>{source.label}</option>
              ))}
            </select>
            <ChevronDownIcon aria-hidden="true" />
          </label>
          <button className="button secondary" type="button" onClick={() => void openReview()} disabled={busy === "open"}>
            <ArrowPathIcon aria-hidden="true" />
            Refresh
          </button>
          {!isLocalPreview ? (
            <button
              className="button secondary"
              type="button"
              onClick={() => void requestDisplayMode("fullscreen")}
            >
              <ArrowsPointingOutIcon aria-hidden="true" />
              Expand
            </button>
          ) : null}
          <button className="button primary" type="button" onClick={() => void exportReview()} disabled={!session || busy === "export"}>
            <ClipboardDocumentCheckIcon aria-hidden="true" />
            Export
          </button>
        </div>
      </header>

      {error ? (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
            <XMarkIcon aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <section className="stats-strip" aria-label="Review summary">
        <Stat label="Files" value={stats.files} />
        <Stat label="Reviewed" value={stats.reviewed} tone="done" />
        <Stat label="Comments" value={stats.comments} tone="comment" />
        <Stat label="Added" value={stats.added} tone="added" />
        <Stat label="Removed" value={stats.removed} tone="removed" />
      </section>

      <section className="workspace">
        <aside className="file-panel" aria-label="Files">
          <div className="panel-header">
            <div>
              <h2>Files</h2>
              <p>{visibleFiles.length} visible</p>
            </div>
          </div>
          <label className="search-box">
            <MagnifyingGlassIcon aria-hidden="true" />
            <input
              aria-label="Filter files"
              name="fileQuery"
              placeholder="Filter files"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="segmented" role="group" aria-label="File filter">
            {(["all", "open", "reviewed", "commented"] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                className={fileFilter === filter ? "active" : ""}
                onClick={() => setFileFilter(filter)}
              >
                {filter}
              </button>
            ))}
          </div>
          <div className="file-list" role="list">
            {visibleFiles.map((file) => {
              const metrics = fileMetrics(file);
              return (
                <button
                  key={file.path}
                  type="button"
                  role="listitem"
                  className={`file-row ${selectedFile?.path === file.path ? "active" : ""}`}
                  onClick={() => {
                    setSelectedPath(file.path);
                    setSelectedLine(null);
                    setCommentScope("file");
                  }}
                >
                  <span className="file-main">
                    <DocumentTextIcon aria-hidden="true" />
                    <span>
                      <strong title={file.path}>{file.path}</strong>
                      <small>{metrics.added} added, {metrics.removed} removed</small>
                    </span>
                  </span>
                  <span className={`status-pill ${file.reviewed ? "reviewed" : file.status}`}>
                    {file.reviewed ? "done" : file.status}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="diff-panel" aria-label="Diff">
          <div className="diff-header">
            <div>
              <h2>{selectedFile?.path ?? "No file selected"}</h2>
              <p>{selectedFile ? fileSubtitle(selectedFile) : "Open or refresh a review to load files."}</p>
            </div>
            <div className="diff-actions">
              {selectedFile ? (
                <button
                  className={`button ${selectedFile.reviewed ? "secondary" : "ghost"}`}
                  type="button"
                  onClick={() => void setReviewed(!selectedFile.reviewed)}
                  disabled={busy === "reviewed"}
                >
                  <CheckIcon aria-hidden="true" />
                  {selectedFile.reviewed ? "Reviewed" : "Mark reviewed"}
                </button>
              ) : null}
            </div>
          </div>
          <div className="diff-body">
            {selectedFile ? (
              selectedFile.hunks.length > 0 ? (
                selectedFile.hunks.map((hunk, hunkIndex) => (
                  <div className="hunk-block" key={`${selectedFile.path}-${hunk.header}-${hunkIndex}`}>
                    <div className="hunk-header">{hunk.header}</div>
                    {hunk.lines.map((line, lineIndex) => (
                      <DiffLineRow
                        key={`${hunkIndex}-${lineIndex}-${line.oldLine ?? ""}-${line.newLine ?? ""}`}
                        line={line}
                        selected={isSelectedLine(selectedLine, selectedFile, line)}
                        onSelect={() => selectLine(selectedFile, line)}
                      />
                    ))}
                  </div>
                ))
              ) : (
                <EmptyState title="Binary or metadata-only change" body="This file has no text hunk to display, but you can still leave a file-level comment." />
              )
            ) : (
              <EmptyState title="No diff loaded" body="Refresh the review to load local changes." />
            )}
          </div>
        </section>

        <aside className="review-panel" aria-label="Comments and export">
          <section className="panel-card composer">
            <div className="panel-header compact">
              <div>
                <h2>Add comment</h2>
                <p>{commentScope === "line" && selectedLine ? `${selectedLine.path}:${selectedLine.line}` : "Review, file, or line scoped"}</p>
              </div>
            </div>
            <div className="form-grid">
              <label>
                <span>Scope</span>
                <select name="commentScope" value={commentScope} onChange={(event) => setCommentScope(event.target.value as CommentScope)}>
                  <option value="review">Review</option>
                  <option value="file">File</option>
                  <option value="line">Line</option>
                </select>
              </label>
              <label>
                <span>Type</span>
                <select name="commentType" value={commentType} onChange={(event) => setCommentType(event.target.value)}>
                  {COMMENT_TYPES.map((type) => (
                    <option key={type.id} value={type.id}>{type.label}</option>
                  ))}
                </select>
              </label>
            </div>
            {selectedLine ? (
              <button className="line-chip" type="button" onClick={() => setSelectedLine(null)}>
                Line {selectedLine.side === "old" ? "~" : ""}{selectedLine.line}
                <XMarkIcon aria-hidden="true" />
              </button>
            ) : null}
            <textarea
              aria-label="Review comment"
              name="commentBody"
              placeholder="Leave a precise review comment..."
              value={commentBody}
              onChange={(event) => setCommentBody(event.target.value)}
            />
            <button className="button primary full" type="button" onClick={() => void addComment()} disabled={!commentBody.trim() || busy === "comment"}>
              <PlusIcon aria-hidden="true" />
              Add comment
            </button>
          </section>

          <section className="panel-card">
            <div className="panel-header compact">
              <div>
                <h2>Comments</h2>
                <p>{comments.length} captured</p>
              </div>
              <button className="button ghost compact-button" type="button" onClick={() => void clearReview()} disabled={!comments.length || busy === "clear"}>
                Clear
              </button>
            </div>
            <div className="comment-list">
              {comments.length ? comments.map((comment) => (
                <article className={`comment-card ${comment.type}`} key={comment.id}>
                  <header>
                    <strong>{typeLabel(comment.type)}</strong>
                    <span>{comment.label}</span>
                  </header>
                  <p>{comment.body}</p>
                </article>
              )) : (
                <EmptyState title="No comments yet" body="Select a file or line, write the note, then export the review for the agent." compact />
              )}
            </div>
          </section>

          <section className="panel-card export-card">
            <div className="panel-header compact">
              <div>
                <h2>Export</h2>
                <p>Agent-ready Markdown</p>
              </div>
              <div className="export-actions">
                {!isLocalPreview ? (
                  <button className="button primary compact-button" type="button" onClick={() => void sendExportToAgent()} disabled={!session || busy === "send"}>
                    <PaperAirplaneIcon aria-hidden="true" />
                    {sentToChat ? "Drafted" : "Draft in chat"}
                  </button>
                ) : null}
                <button className="button ghost compact-button" type="button" onClick={() => void copyExport()} disabled={!exported}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
            <textarea
              ref={exportTextareaRef}
              aria-label="Exported review markdown"
              name="exportedReview"
              readOnly
              value={exported}
              placeholder="Exported review markdown appears here."
            />
          </section>
        </aside>
      </section>
    </main>
  );
}

function DiffLineRow({
  line,
  selected,
  onSelect,
}: {
  line: ReviewLine;
  selected: boolean;
  onSelect: () => void;
}) {
  const displayLine = line.kind === "removed" ? line.oldLine : line.newLine;
  return (
    <div
      className={`diff-line ${line.kind} ${selected ? "selected" : ""} ${displayLine ? "selectable" : ""}`}
      onClick={displayLine ? onSelect : undefined}
    >
      <span className="line-num">{line.oldLine ?? ""}</span>
      <span className="line-num">{line.newLine ?? ""}</span>
      <span className="line-mark">{line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}</span>
      <code>{line.content || " "}</code>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        disabled={!displayLine}
        aria-label={displayLine ? `Comment on line ${displayLine}` : "Line cannot be commented"}
      >
        <ChatBubbleLeftRightIcon aria-hidden="true" />
      </button>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EmptyState({ title, body, compact = false }: { title: string; body: string; compact?: boolean }) {
  return (
    <div className={`empty-state ${compact ? "compact" : ""}`}>
      <p>{title}</p>
      <span>{body}</span>
    </div>
  );
}

function summarizeSession(session: ReviewSession | null) {
  const files = session?.files ?? [];
  return files.reduce((summary, file) => {
    const metrics = fileMetrics(file);
    summary.added += metrics.added;
    summary.removed += metrics.removed;
    summary.comments += commentCount(file);
    if (file.reviewed) summary.reviewed += 1;
    return summary;
  }, {
    files: files.length,
    reviewed: 0,
    comments: session?.reviewComments.length ?? 0,
    added: 0,
    removed: 0,
  });
}

function fileMetrics(file: ReviewFile): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "added") added += 1;
      if (line.kind === "removed") removed += 1;
    }
  }
  return { added, removed };
}

function commentCount(file: ReviewFile): number {
  return (file.fileComments?.length ?? 0) + (file.lineComments?.length ?? 0);
}

function flattenComments(session: ReviewSession | null): CommentEntry[] {
  if (!session) return [];
  const entries: CommentEntry[] = session.reviewComments.map((comment) => ({
    ...comment,
    label: "Review",
  }));
  for (const file of session.files) {
    for (const comment of file.fileComments ?? []) {
      entries.push({ ...comment, label: file.path });
    }
    for (const comment of file.lineComments ?? []) {
      const side = comment.side === "old" ? "~" : "";
      entries.push({ ...comment, label: `${file.path}:${side}${comment.line}` });
    }
  }
  return entries;
}

function fileSubtitle(file: ReviewFile): string {
  const metrics = fileMetrics(file);
  const comments = commentCount(file);
  return `${file.status} change, ${metrics.added} added, ${metrics.removed} removed, ${comments} comments`;
}

function typeLabel(type: string): string {
  return COMMENT_TYPES.find((item) => item.id === type)?.label ?? type.toUpperCase();
}

function formatRepo(path: string, branch: string | null): string {
  const repo = path.split("/").filter(Boolean).at(-1) ?? path;
  return branch ? `${repo} / ${branch}` : repo;
}

function isSelectedLine(selectedLine: SelectedLine | null, file: ReviewFile, line: ReviewLine): boolean {
  if (!selectedLine || selectedLine.path !== file.path) return false;
  const displayLine = line.kind === "removed" ? line.oldLine : line.newLine;
  const side: LineSide = line.kind === "removed" ? "old" : "new";
  return selectedLine.line === displayLine && selectedLine.side === side;
}
