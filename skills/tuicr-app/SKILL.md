---
name: tuicr-app
description: Review local git changes with the tuicr MCP Apps interface.
---

# tuicr-app

Launch and use the repo-managed tuicr MCP Apps review interface.

## Usage

Use this when the user invokes `$tuicr-app` or asks to review local changes inside Codex/Claude desktop instead of a tmux TUI.

1. Determine the target git repository.
2. Start the app server if needed:

```bash
cd <tuicr-repo>/plugins/tuicr-app
npm exec -- tuicr-app --repo <target-repo>
```

3. Prefer MCP tools when they are exposed by the host. `open_review` launches the app resource; follow-up tools are plain model-facing tools that return text and structured data without creating another embed:
   - `open_review`
   - `get_review` with exactly one of `sessionId` or `repoPath`
   - `get_file_diff`
   - `add_comment`
   - `set_file_reviewed`
   - `clear_review`
   - `export_review`
4. Use `get_file_diff` for actual line-numbered diff review. Do not scrape the iframe or switch to filesystem reads unless the MCP server is unavailable.
5. If a visual surface is needed, open `http://localhost:8787/preview?repoPath=<encoded absolute repo path>`.
6. When `export_review` returns Markdown, apply or respond to the review comments.

## Install Notes

- Codex plugin manifest: `plugins/tuicr-app/.codex-plugin/plugin.json`
- MCP endpoint for Apps-compatible hosts: `http://localhost:8787/mcp`
- Claude Desktop uses the `tuicr-app --stdio` CLI form.
- Local preview URL: `http://localhost:8787/preview?repoPath=<encoded absolute repo path>`
