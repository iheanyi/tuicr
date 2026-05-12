# tuicr App MCP Integration

`tuicr-app` is a local MCP Apps integration for reviewing git diffs in Codex, Claude Desktop, or any MCP Apps-compatible host.

It complements the terminal TUI:

- `$tuicr` opens the existing ratatui app in tmux.
- `$tuicr-app` opens an MCP Apps web component backed by a local MCP server.

## What It Provides

- Streamable HTTP MCP endpoint at `http://localhost:8787/mcp`
- Apps SDK web component resource at `ui://tuicr-app/review.html`
- Local browser preview at `http://localhost:8787/preview`
- Review-level, file-level, and line-level comments
- File reviewed/unreviewed state
- Agent-ready Markdown export matching the existing tuicr review format

## Local Development

```bash
cd plugins/tuicr-app
npm install
npm run build
tuicr-app --repo /path/to/repo
```

Then open:

```text
http://localhost:8787/preview
```

The MCP endpoint is:

```text
http://localhost:8787/mcp
```

## Codex

The Codex plugin manifest lives at:

```text
plugins/tuicr-app/.codex-plugin/plugin.json
```

The plugin declares:

```text
plugins/tuicr-app/.mcp.json
plugins/tuicr-app/skills/tuicr-app/SKILL.md
```

## Claude Desktop

Claude Desktop launches local MCP servers over stdio. Add an MCP server entry that runs the built CLI with `--stdio`:

```json
{
  "mcpServers": {
    "tuicr-app": {
      "command": "node",
      "args": [
        "/absolute/path/to/tuicr/plugins/tuicr-app/bin/tuicr-app.js",
        "--stdio",
        "--repo",
        "/absolute/path/to/repo-to-review",
        "--data-dir",
        "/absolute/path/to/review-data"
      ]
    }
  }
}
```

Use the Streamable HTTP mode only when a host explicitly connects to `http://localhost:8787/mcp`, or for the local browser preview at `http://localhost:8787/preview?repoPath=<encoded repo path>`.

The app resource is attached only to `open_review`. Follow-up tools are plain model-facing tools with no app UI metadata and no `resource_link`, so hosts do not create duplicate embedded widgets after `get_review`, `get_file_diff`, `add_comment`, or `set_file_reviewed`.

## Tools

- `open_review`: load or refresh a review session for a local git repo.
- `get_review`: return session state and a concise file index. Pass exactly one of `sessionId` or `repoPath`; invalid session ids should fail instead of being treated as paths.
- `get_file_diff`: return line-numbered diff content for one file. Agents should use this for actual code review instead of scraping the iframe or falling back to filesystem reads.
- `add_comment`: create review, file, or line comments.
- `set_file_reviewed`: toggle reviewed state for a file.
- `clear_review`: clear comments and reviewed marks.
- `export_review`: export agent-consumable Markdown.

## Notes

This implementation follows the current Apps SDK shape: a required MCP server, an optional iframe web component, `registerAppResource`, `registerAppTool`, and Streamable HTTP transport.

The package exposes a Node CLI executable named `tuicr-app`. From this package, `npm exec -- tuicr-app --repo /path/to/repo` starts the same server; after a global install or link, `tuicr-app --repo /path/to/repo` works directly.
