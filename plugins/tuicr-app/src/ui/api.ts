import {
  App as McpApp,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

import type { ToolResult } from "./types.js";

const local = window.parent === window;
const previewRepoPath = new URLSearchParams(window.location.search).get("repoPath")
  ?? new URLSearchParams(window.location.search).get("repo");
export const isLocalPreview = local;
export type DisplayMode = "inline" | "fullscreen" | "pip";
const MIN_EMBED_HEIGHT = 560;
const MAX_EMBED_HEIGHT = 1400;

let app: McpApp | null = null;
let latestToolResult: ToolResult | null = null;
const toolResultListeners = new Set<(result: ToolResult) => void>();

let bridgeReady: Promise<void> | null = null;

function applyHostContext(context: ReturnType<McpApp["getHostContext"]>): void {
  if (!context) return;
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}

async function initBridge(): Promise<void> {
  if (local) return;
  if (!bridgeReady) {
    bridgeReady = (async () => {
      app = new McpApp(
        { name: "tuicr-app", version: "0.1.0" },
        { availableDisplayModes: ["inline", "fullscreen"] },
        { strict: true },
      );
      app.ontoolresult = (result) => {
        latestToolResult = result as ToolResult;
        for (const listener of toolResultListeners) listener(latestToolResult);
        void notifyEmbedSize();
      };
      app.onhostcontextchanged = (context) => {
        applyHostContext(context);
        void notifyEmbedSize();
      };
      await app.connect();
      applyHostContext(app.getHostContext());
      await notifyEmbedSize();
    })();
  }
  await bridgeReady;
}

export async function notifyEmbedSize(height = measureEmbedHeight()): Promise<void> {
  if (local || !app) return;
  try {
    await app.sendSizeChanged({ height });
  } catch {
    // Older or partial MCP Apps hosts may ignore explicit resize events.
  }
}

export function observeEmbedSize(): () => void {
  if (local || typeof ResizeObserver === "undefined") return () => {};

  let frame: number | null = null;
  const notify = () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      frame = null;
      void notifyEmbedSize();
    });
  };

  const observer = new ResizeObserver(notify);
  observer.observe(document.documentElement);
  if (document.body) observer.observe(document.body);
  const shell = document.querySelector(".app-shell");
  if (shell) observer.observe(shell);
  window.addEventListener("resize", notify);
  notify();

  return () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    window.removeEventListener("resize", notify);
    observer.disconnect();
  };
}

function measureEmbedHeight(): number {
  const shell = document.querySelector(".app-shell");
  const rawHeight = Math.max(
    shell?.scrollHeight ?? 0,
    document.body?.scrollHeight ?? 0,
    document.documentElement.scrollHeight,
  );
  return Math.min(MAX_EMBED_HEIGHT, Math.max(MIN_EMBED_HEIGHT, Math.ceil(rawHeight)));
}

export function onToolResult(listener: (result: ToolResult) => void): () => void {
  toolResultListeners.add(listener);
  if (latestToolResult) queueMicrotask(() => listener(latestToolResult as ToolResult));
  if (!local) void initBridge();
  return () => {
    toolResultListeners.delete(listener);
  };
}

async function fetchJson(url: string, body?: unknown, method = "POST"): Promise<ToolResult> {
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return { structuredContent: data, content: [] };
}

async function callLocal(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (name === "open_review") {
    const openArgs = previewRepoPath && !args.repoPath ? { ...args, repoPath: previewRepoPath } : args;
    return fetchJson("/api/open", openArgs);
  }
  if (name === "get_review") return fetchJson(`/api/session/${args.sessionId}`, undefined, "GET");
  if (name === "add_comment") return fetchJson("/api/comment", args);
  if (name === "set_file_reviewed") return fetchJson("/api/reviewed", args);
  if (name === "clear_review") return fetchJson("/api/clear", args);
  if (name === "export_review") return fetchJson(`/api/export/${args.sessionId}`, undefined, "GET");
  throw new Error(`Unknown local tool ${name}`);
}

export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  if (local) return callLocal(name, args);
  await initBridge();
  if (!app) throw new Error("MCP App bridge did not initialize.");
  return app.callServerTool({ name, arguments: args }) as Promise<ToolResult>;
}

export async function sendReviewToAgent(markdown: string): Promise<void> {
  if (local) throw new Error("Send to chat is only available inside an MCP Apps host.");
  await initBridge();
  if (!app) throw new Error("MCP App bridge did not initialize.");

  const prompt = "Use the exported tuicr review markdown now in context. Address or apply the review comments in this chat.";
  const content = `${prompt}\n\nExported tuicr review markdown:\n\n${markdown}`;

  try {
    await app.updateModelContext({
      content: [{ type: "text", text: markdown }],
      structuredContent: {
        source: "tuicr-app",
        kind: "exported-review",
      },
    });
  } catch {
    // The chat draft still includes the markdown below, so this is only a best-effort context hint.
  }

  const result = await app.sendMessage({
    role: "user",
    content: [{ type: "text", text: content }],
  });
  if (result.isError) throw new Error("The host rejected the review handoff message.");
}

export async function requestDisplayMode(mode: DisplayMode): Promise<void> {
  if (local) return;
  await initBridge();
  await notifyEmbedSize();
  await app?.requestDisplayMode({ mode });
}
