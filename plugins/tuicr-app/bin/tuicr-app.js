#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverEntry = resolve(root, "dist", "server.js");

function usage() {
  console.log(`tuicr-app

Start the tuicr MCP Apps server.

Usage:
  tuicr-app [--repo <path>] [--data-dir <path>] [--port <port>] [--host <host>] [--stdio] [--no-build]

Options:
  --repo <path>   Repository to review. Defaults to the current directory.
  --data-dir <path>
                  Directory for persisted review sessions.
  --port <port>   HTTP port. Defaults to 8787.
  --host <host>   Bind host. Defaults to 127.0.0.1.
  --stdio         Start as a stdio MCP server instead of Streamable HTTP.
  --no-build      Do not build missing dist files before starting.
  --help          Show this help.
  --version       Show package version.
`);
}

const args = process.argv.slice(2);
let buildIfMissing = true;
let transport = "http";

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  const next = args[index + 1];
  if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  }
  if (arg === "--version" || arg === "-v") {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    console.log(packageJson.version);
    process.exit(0);
  }
  if (arg === "--no-build") {
    buildIfMissing = false;
    continue;
  }
  if (arg === "--stdio") {
    transport = "stdio";
    continue;
  }
  if (arg === "--repo") {
    if (!next) throw new Error("--repo requires a path");
    process.env.TUICR_REPO = next;
    index += 1;
    continue;
  }
  if (arg === "--data-dir") {
    if (!next) throw new Error("--data-dir requires a path");
    process.env.TUICR_APP_DATA_DIR = next;
    index += 1;
    continue;
  }
  if (arg === "--port") {
    if (!next) throw new Error("--port requires a port");
    process.env.PORT = next;
    index += 1;
    continue;
  }
  if (arg === "--host") {
    if (!next) throw new Error("--host requires a host");
    process.env.HOST = next;
    index += 1;
    continue;
  }
  throw new Error(`Unknown argument: ${arg}`);
}

if (!existsSync(serverEntry)) {
  if (!buildIfMissing) {
    throw new Error("dist/server.js is missing. Run `npm run build` first.");
  }
  const result = spawnSync("npm", ["run", "build"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const { startHttpServer, startStdioServer } = await import(serverEntry);
if (transport === "stdio") {
  await startStdioServer();
} else {
  startHttpServer();
}
