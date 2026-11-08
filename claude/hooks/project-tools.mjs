// Shared helpers for hooks that run project-local tools (linters, tsc) and keep per-agent state.
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Directories from `startDir` upward. The walk includes the first directory that
// contains `.git` and never reaches $HOME itself or anything above it.
export function searchDirs(startDir, home = homedir()) {
  const homeDir = resolve(home);
  const dirs = [];
  let current = resolve(startDir);

  while (current !== homeDir) {
    dirs.push(current);
    const parent = dirname(current);
    if (existsSync(join(current, ".git")) || parent === current) {
      break;
    }
    current = parent;
  }

  return dirs;
}

// Nearest directory that contains any of `names`, or null.
export function findConfigDir(startDir, names) {
  return searchDirs(startDir).find((dir) => names.some((name) => existsSync(join(dir, name)))) ?? null;
}

// Nearest executable `node_modules/.bin/<tool>`. `root` is the directory that owns node_modules.
export function findBin(startDir, tool) {
  for (const root of searchDirs(startDir)) {
    const bin = join(root, "node_modules", ".bin", tool);
    try {
      accessSync(bin, constants.X_OK);
      return { bin, root };
    } catch {
      // Not in this directory; keep walking up.
    }
  }
  return null;
}

export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n... (${text.length - limit}자 생략)`;
}

function sanitize(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "_");
}

// Subagent hooks carry agent_id; ids may or may not have an `agent-` prefix.
export function agentKeyOf(input) {
  if (typeof input.agent_id !== "string") {
    return "main";
  }
  const key = sanitize(input.agent_id.replace(/^agent-/, ""));
  return key === "" ? "main" : key;
}

export function defaultStateDir() {
  return process.env.CLAUDE_HOOKS_STATE_DIR ?? join(tmpdir(), "claude-hooks");
}

// State lives at <stateDir>/<session_id>/<agentKey>.{files,blocks,last}.
export function statePaths(input, stateDir = defaultStateDir()) {
  const dir = join(stateDir, sanitize(input.session_id ?? "unknown") || "unknown");
  const key = agentKeyOf(input);
  return {
    dir,
    filesPath: join(dir, `${key}.files`),
    blocksPath: join(dir, `${key}.blocks`),
    lastPath: join(dir, `${key}.last`),
  };
}

// Append-only so parallel tool calls cannot overwrite each other.
export function recordEditedFile(paths, file) {
  mkdirSync(paths.dir, { recursive: true });
  appendFileSync(paths.filesPath, `${file}\n`);
}

export function readEditedFiles(paths) {
  try {
    const lines = readFileSync(paths.filesPath, "utf8").split("\n").filter((line) => line !== "");
    return [...new Set(lines)];
  } catch {
    return [];
  }
}

export function readBlockCount(paths) {
  try {
    const count = Number.parseInt(readFileSync(paths.blocksPath, "utf8"), 10);
    return Number.isNaN(count) ? 0 : count;
  } catch {
    return 0;
  }
}

export function writeBlockCount(paths, count) {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.blocksPath, String(count));
}

// Signature of the diagnostics the last block reported.
export function readLastSignature(paths) {
  try {
    return readFileSync(paths.lastPath, "utf8");
  } catch {
    return null;
  }
}

export function writeLastSignature(paths, signature) {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.lastPath, signature);
}

export function clearState(paths) {
  rmSync(paths.filesPath, { force: true });
  rmSync(paths.blocksPath, { force: true });
  rmSync(paths.lastPath, { force: true });
}
