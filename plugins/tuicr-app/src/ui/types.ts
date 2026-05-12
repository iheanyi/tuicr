export type LineKind = "context" | "added" | "removed";
export type LineSide = "new" | "old";
export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";
export type DiffSource = "working_tree" | "staged" | "unstaged";
export type CommentScope = "review" | "file" | "line";
export type CommentType = "note" | "suggestion" | "issue" | "praise" | string;

export interface ReviewLine {
  kind: LineKind;
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
  type: CommentType;
  body: string;
  createdAt: string;
  scope: CommentScope;
  path: string | null;
  line: number | null;
  endLine: number | null;
  side: LineSide;
}

export interface ReviewFile {
  path: string;
  oldPath?: string | null;
  newPath?: string | null;
  status: FileStatus;
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
  diffSource: DiffSource;
  createdAt: string;
  updatedAt: string;
  reviewComments: ReviewComment[];
  files: ReviewFile[];
}

export interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: {
    session?: ReviewSession;
    markdown?: string;
  };
}

export interface SelectedLine {
  path: string;
  line: number;
  side: LineSide;
}
