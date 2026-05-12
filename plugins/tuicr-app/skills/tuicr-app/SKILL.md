---
name: tuicr-app
description: Review local git changes with the tuicr MCP Apps interface.
---

# tuicr-app

Use this skill when the user asks for `$tuicr-app`, wants to review local changes in a desktop app surface, or wants an MCP Apps alternative to the tmux-based `$tuicr` skill.

## Preferred Flow

1. Determine the target git repository from the current working directory or the user's explicit path.
2. Use the `tuicr-app` MCP server tools when available:
   - `open_review` with `{ "repoPath": "<absolute repo path>", "diffSource": "working_tree" }`
   - `get_review` with exactly one of `sessionId` or `repoPath` to refresh state and list files without creating another app embed
   - `get_file_diff` to inspect line-numbered diff content for specific files
   - `add_comment` to capture actionable review comments
   - `export_review` when the user is done reviewing
3. Use `get_file_diff` for actual code review. Do not scrape the iframe or switch to filesystem reads unless the MCP server is unavailable.
4. If Browser is available, open `http://localhost:8787/preview?repoPath=<encoded absolute repo path>` for local visual testing or direct user interaction.
5. When `export_review` returns Markdown, execute the review instructions or ask the user whether to apply them.

## Tool Notes

- `open_review` returns a review session containing files, hunks, comments, reviewed state, and the MCP Apps resource link.
- Follow-up session tools return model-readable text and structured content and have no app UI metadata, so hosts avoid duplicate embedded widgets.
- `get_file_diff` returns line-numbered diff text for a single file.
- `add_comment` supports review-level, file-level, and line-level comments.
- `set_file_reviewed` marks files reviewed/unreviewed.
- `clear_review` clears comments and reviewed marks.
- `export_review` returns agent-consumable Markdown compatible with tuicr's review format.

## Fallback

If the MCP server is not installed or running:

```bash
cd <repo-root>/plugins/tuicr-app
npm install
npm exec -- tuicr-app --repo <target-repo>
```

Then open `http://localhost:8787/preview?repoPath=<encoded absolute repo path>` or connect an MCP Apps-compatible host to `http://localhost:8787/mcp`.
