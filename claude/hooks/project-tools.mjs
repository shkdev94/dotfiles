// Shared helpers for hooks that run project-local tools (linters, tsc) and keep per-agent state.
import { spawn } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Extensions of the files the hooks lint, format, typecheck and test. Only ESLint and the formatters
// handle the framework files.
export const SCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
export const FRAMEWORK_EXTENSIONS = new Set([".vue", ".svelte"]);

export function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// package.json content, or null when it is missing or unparsable.
export function readPackageJson(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

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

// Names of `packageNames` in dependencies/devDependencies of the nearest package.json (from `startDir` up)
// that declares at least one of them; an empty Set when none does.
export function nearestDeclared(startDir, packageNames) {
  for (const dir of searchDirs(startDir)) {
    const pkg = readPackageJson(dir);
    if (pkg === null) {
      continue;
    }
    const declared = new Set();
    for (const field of ["dependencies", "devDependencies"]) {
      const deps = pkg[field];
      if (typeof deps !== "object" || deps === null || Array.isArray(deps)) {
        continue;
      }
      for (const name of packageNames) {
        if (Object.hasOwn(deps, name)) {
          declared.add(name);
        }
      }
    }
    if (declared.size > 0) {
      return declared;
    }
  }
  return new Set();
}

// True when the nearest declaring package.json (see nearestDeclared) lists `packageName`.
export function declaresPackage(startDir, packageName) {
  return nearestDeclared(startDir, [packageName]).has(packageName);
}

// Output of one stream, kept up to `limit` bytes; the rest is dropped.
function collector(limit) {
  const chunks = [];
  let size = 0;
  return {
    push(chunk) {
      if (size >= limit) {
        return;
      }
      const kept = chunk.length > limit - size ? chunk.subarray(0, limit - size) : chunk;
      chunks.push(kept);
      size += kept.length;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

// How long to wait for the pipes to drain after the process exits. A grandchild that outlives its
// parent (for example a worker the tool did not clean up) keeps the pipes open forever otherwise.
const PIPE_GRACE_MS = 300;

// How long a process that ignores SIGTERM gets before SIGKILL after a timeout.
const KILL_GRACE_MS = 1000;

// Async counterpart of spawnSync with `timeout`. Never rejects: spawn failures resolve with `error`.
// Output beyond `maxBuffer` bytes per stream is cut instead of killing the process.
// `timedOut` is true when the timeout fired: the process gets SIGTERM, SIGKILL after KILL_GRACE_MS, and
// the promise resolves shortly after even if the process never reports its exit. The timers are our own
// because the `timeout` option of spawn is not cleared when spawning fails and would keep the event loop alive.
export function spawnAsync(bin, args, { cwd, env, timeout, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolvePromise) => {
    const out = collector(maxBuffer);
    const err = collector(maxBuffer);
    let child;
    const timers = [];
    let timedOut = false;
    let settled = false;
    let spawnError;
    let exit = null;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      timers.forEach(clearTimeout);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolvePromise({
        status: exit?.code ?? null,
        signal: exit?.signal ?? null,
        stdout: out.text(),
        stderr: err.text(),
        timedOut,
        error: spawnError,
      });
    };

    try {
      child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      spawnError = error;
      finish();
      return;
    }

    if (timeout !== undefined) {
      timers.push(
        setTimeout(() => {
          if (exit !== null) {
            return;
          }
          timedOut = true;
          child.kill("SIGTERM");
          timers.push(
            setTimeout(() => {
              if (exit !== null) {
                return;
              }
              child.kill("SIGKILL");
              timers.push(setTimeout(finish, PIPE_GRACE_MS));
            }, KILL_GRACE_MS),
          );
        }, timeout),
      );
    }
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      spawnError = error;
      finish();
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      timers.push(setTimeout(finish, PIPE_GRACE_MS));
    });
    child.on("close", (code, signal) => {
      exit ??= { code, signal };
      finish();
    });
  });
}

// Removes comments and trailing commas (outside strings) so tsconfig's JSONC parses as JSON.
// Returns null when the result still is not valid JSON.
export function parseJsonc(text) {
  const source = text.replace(/^\uFEFF/, "");

  const stripComments = () => {
    let out = "";
    for (let i = 0; i < source.length; ) {
      const char = source[i];
      if (char === '"') {
        const end = stringEnd(source, i);
        out += source.slice(i, end);
        i = end;
      } else if (char === "/" && source[i + 1] === "/") {
        while (i < source.length && source[i] !== "\n") {
          i += 1;
        }
      } else if (char === "/" && source[i + 1] === "*") {
        const end = source.indexOf("*/", i + 2);
        i = end === -1 ? source.length : end + 2;
      } else {
        out += char;
        i += 1;
      }
    }
    return out;
  };

  const stripTrailingCommas = (input) => {
    let out = "";
    for (let i = 0; i < input.length; ) {
      const char = input[i];
      if (char === '"') {
        const end = stringEnd(input, i);
        out += input.slice(i, end);
        i = end;
      } else if (char === ",") {
        let next = i + 1;
        while (next < input.length && /\s/.test(input[next])) {
          next += 1;
        }
        if (input[next] !== "}" && input[next] !== "]") {
          out += char;
        }
        i += 1;
      } else {
        out += char;
        i += 1;
      }
    }
    return out;
  };

  try {
    return JSON.parse(stripTrailingCommas(stripComments()));
  } catch {
    return null;
  }
}

// Index just past the string literal that starts at `start`.
function stringEnd(text, start) {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') {
    i += text[i] === "\\" ? 2 : 1;
  }
  return Math.min(i + 1, text.length);
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

// State lives at <stateDir>/<session_id>/<agentKey>.{files,lint.blocks,typecheck.blocks,test.blocks,notified}.
// legacyBlocksPath and legacyLastPath belong to an earlier format and are only deleted.
export function statePaths(input, stateDir = defaultStateDir()) {
  const dir = join(stateDir, sanitize(input.session_id ?? "unknown") || "unknown");
  const key = agentKeyOf(input);
  return {
    dir,
    filesPath: join(dir, `${key}.files`),
    lintBlocksPath: join(dir, `${key}.lint.blocks`),
    typecheckBlocksPath: join(dir, `${key}.typecheck.blocks`),
    testBlocksPath: join(dir, `${key}.test.blocks`),
    notifiedPath: join(dir, `${key}.notified`),
    legacyBlocksPath: join(dir, `${key}.blocks`),
    legacyLastPath: join(dir, `${key}.last`),
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

// Number of blocks recorded in `path` (one of the *BlocksPath entries); 0 when missing or unreadable.
export function readBlockCount(path) {
  try {
    const count = Number.parseInt(readFileSync(path, "utf8"), 10);
    return Number.isNaN(count) ? 0 : count;
  } catch {
    return 0;
  }
}

export function writeBlockCount(paths, path, count) {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(path, String(count));
}

// Keys of the notices already sent, one per line.
export function readNotified(paths) {
  try {
    return new Set(readFileSync(paths.notifiedPath, "utf8").split("\n").filter((line) => line !== ""));
  } catch {
    return new Set();
  }
}

export function writeNotified(paths, keys) {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.notifiedPath, [...keys].map((key) => `${key}\n`).join(""));
}

export function clearState(paths) {
  for (const path of [
    paths.filesPath,
    paths.lintBlocksPath,
    paths.typecheckBlocksPath,
    paths.testBlocksPath,
    paths.notifiedPath,
    paths.legacyBlocksPath,
    paths.legacyLastPath,
  ]) {
    rmSync(path, { force: true });
  }
}

// State shared by every agent of a session (main conversation and subagents carry the same session_id):
// <stateDir>/<session_id>/<name>.
export function sessionStatePath(input, name, stateDir = defaultStateDir()) {
  return join(stateDir, sanitize(input.session_id ?? "unknown") || "unknown", name);
}

// One JSON object per line. Appending a single short line is atomic enough for parallel hooks,
// so callers never read-modify-write the file.
export function appendJsonl(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

// Records in append order; a missing file or a malformed line yields nothing for that part.
export function readJsonl(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const records = [];
  for (const line of text.split("\n")) {
    if (line === "") {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      // Skip a partially written or corrupted line.
    }
  }
  return records;
}

// Repository root for normalizing relative paths: the nearest directory from `cwd` upward that
// contains `.git`, or `cwd` itself when there is none. Unlike searchDirs it may pass $HOME.
export function findRepoRoot(cwd) {
  const start = resolve(cwd);
  let current = start;
  for (;;) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
}
