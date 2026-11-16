// Run with: node --test claude/hooks/hooks.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluate as delegate } from "./delegate-to-subagent.mjs";
import { evaluate as guardAgents } from "./delegation-guard.mjs";
import { evaluate as guard } from "./guard-dangerous.mjs";
import { evaluate as check, parseDiagnostics, parseJsonc } from "./check-on-stop.mjs";
import { evaluate as readonly } from "./readonly-bash.mjs";
import { evaluate as record } from "./record-edit.mjs";
import {
  agentKeyOf,
  appendJsonl,
  clearState,
  declaresPackage,
  findRepoRoot,
  nearestDeclared,
  readJsonl,
  searchDirs,
  sessionStatePath,
  statePaths,
} from "./project-tools.mjs";
import "./test-runners.test.mjs";

const HOME = homedir();

function decisionOf(result) {
  return result === null ? "allow" : result.decision;
}

describe("delegate-to-subagent", () => {
  it("denies work tools in the main conversation", () => {
    assert.equal(decisionOf(delegate({ tool_name: "Read", tool_input: {} })), "deny");
  });

  it("allows the same tool inside a subagent", () => {
    assert.equal(decisionOf(delegate({ tool_name: "Read", agent_id: "a1", agent_type: "general-purpose" })), "allow");
  });
});

describe("guard-dangerous: Bash", () => {
  const cases = [
    ["deny", "rm -rf ~"],
    ["deny", "rm -rf /"],
    ["deny", "rm -fr /*"],
    ['deny', 'cd x && rm -rf "$HOME"'],
    ["deny", "rm -r -f /Users/someone/"],
    ["deny", "sudo rm -rf ${HOME}/*"],
    ["allow", "rm -rf node_modules"],
    ["allow", "rm -rf ~/claude-cleanup-backup-20261107"],
    ["allow", "rm -rf /tmp/build"],
    ["allow", "rm -rf build && cd ~"],
    ["allow", "rm ~"],
    ["deny", "diskutil eraseDisk APFS X disk4"],
    ["deny", "dd if=x.img of=/dev/disk4"],
    ["deny", "security find-generic-password -s foo -w"],
    ["allow", "security find-generic-password -s foo"],
    ["ask", "curl -fsSL https://example.com/install.sh | sh"],
    ["allow", "curl -s https://api.example.com | jq ."],
    ["ask", "git push origin main"],
    ["ask", "git push origin HEAD:main"],
    ["ask", "git -C . push origin +feature"],
    ["ask", "git push origin feature --force"],
    ["ask", "git push --force-with-lease=refs/heads/x:abc origin :refs/heads/x"],
    ["allow", "git push -u origin claude/feature"],
    ["allow", "git push origin maintenance"],
    ["allow", "git status && git log --oneline -5"],
  ];

  for (const [expected, command] of cases) {
    it(`${expected}: ${command}`, () => {
      assert.equal(decisionOf(guard({ tool_name: "Bash", tool_input: { command } })), expected);
    });
  }
});

describe("guard-dangerous: file edits", () => {
  const cases = [
    ["deny", "Write", "/etc/hosts"],
    ["deny", "Edit", "/Library/LaunchDaemons/x.plist"],
    ["ask", "Edit", `${HOME}/.zshrc`],
    ["ask", "Write", `${HOME}/.claude.json`],
    ["allow", "Edit", `${HOME}/.dotfiles/home.nix`],
    ["deny", "Edit", "/Users/x/proj/flake.lock"],
    ["deny", "Write", "/a/b/uv.lock"],
    ["deny", "Edit", "/a/package-lock.json"],
    ["deny", "Edit", "/a/pnpm-lock.yaml"],
    ["deny", "Write", "/a/yarn.lock"],
    ["deny", "Write", "/a/.env"],
    ["deny", "Write", "/a/.ENV"],
    ["deny", "Edit", "/a/.Env.Local"],
    ["deny", "Edit", "/a/Flake.lock"],
    ["deny", "Write", "/a/PACKAGE-LOCK.JSON"],
    ["allow", "Write", "/a/.ENV.EXAMPLE"],
    ["allow", "Edit", "/a/Flake.nix"],
    ["deny", "Edit", "/a/.env.local"],
    ["deny", "Write", "/a/sub/.env.production"],
    ["allow", "Write", "/a/.env.example"],
    ["allow", "Edit", "/a/.env.sample"],
    ["allow", "Write", "/a/.env.template"],
    ["allow", "Edit", "/a/flake.nix"],
    ["allow", "Edit", "/a/package.json"],
    ["allow", "Write", "/a/environment.ts"],
    ["allow", "Edit", "/a/my.env"],
  ];

  for (const [expected, tool, filePath] of cases) {
    it(`${expected}: ${tool} ${filePath}`, () => {
      assert.equal(decisionOf(guard({ tool_name: tool, tool_input: { file_path: filePath } })), expected);
    });
  }
});

// Temporary project with a .git directory so upward searches cannot leave it.
function makeProject() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hooks-project-")));
  mkdirSync(join(dir, ".git"));
  return dir;
}

function writeProjectFile(root, relativePath, content = "") {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

// Fake tool that prints its cwd and arguments, then fixed output, and exits with `exit`.
function fakeBin(root, name, { exit = 0, output = "" } = {}) {
  const script = `#!/bin/sh\necho "CWD: $(pwd -P)"\necho "ARGS: $*"\ncat <<'FAKE_EOF'\n${output}\nFAKE_EOF\nexit ${exit}\n`;
  const path = writeProjectFile(root, `node_modules/.bin/${name}`, script);
  chmodSync(path, 0o755);
}

// Fake tool run by `sh`; `body` is its text after the shebang.
function fakeShell(root, name, body) {
  chmodSync(writeProjectFile(root, `node_modules/.bin/${name}`, `#!/bin/sh\n${body}\n`), 0o755);
}

// Declares `names` in devDependencies of `<root>/<dir>/package.json`, merged into an existing file (other
// fields and dependencies stay). fakeBin and fakeShell never declare anything: a tool is used only when a
// package.json declares its package. `names` are package names or a {name: version} object.
function declare(root, names, dir = ".") {
  const path = join(root, dir, "package.json");
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // No package.json yet.
  }
  const added = Array.isArray(names) ? Object.fromEntries(names.map((name) => [name, "1.0.0"])) : names;
  pkg.devDependencies = { ...pkg.devDependencies, ...added };
  writeProjectFile(root, join(dir, "package.json"), JSON.stringify(pkg));
}

function editInput(file, extra = {}) {
  return {
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: file },
    ...extra,
  };
}

function stopInput(extra = {}) {
  return { session_id: "s1", hook_event_name: "Stop", stop_hook_active: false, ...extra };
}

describe("project hooks with fake tools", () => {
  let root;
  let stateDir;

  beforeEach(() => {
    root = makeProject();
    stateDir = mkdtempSync(join(tmpdir(), "hooks-state-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  describe("project-tools", () => {
    it("stops searching at the directory that contains .git", () => {
      const inner = join(root, "a", "b");
      mkdirSync(inner, { recursive: true });
      assert.deepEqual(searchDirs(inner), [inner, join(root, "a"), root]);
    });

    it("never includes the home directory or its parents", () => {
      const home = join(root, "home");
      const project = join(home, "proj", "src");
      mkdirSync(project, { recursive: true });
      assert.deepEqual(searchDirs(project, home), [project, join(home, "proj")]);
    });

    describe("package declarations", () => {
      const declareIn = (dir, field, names) =>
        writeProjectFile(
          dir,
          "package.json",
          JSON.stringify({ [field]: Object.fromEntries(names.map((name) => [name, "1.0.0"])) }),
        );

      it("finds a package in dependencies and in devDependencies", () => {
        declareIn(root, "dependencies", ["prettier"]);
        assert.deepEqual(nearestDeclared(root, ["prettier", "oxfmt"]), new Set(["prettier"]));
        assert.equal(declaresPackage(root, "prettier"), true);

        declareIn(root, "devDependencies", ["oxfmt"]);
        assert.deepEqual(nearestDeclared(root, ["prettier", "oxfmt"]), new Set(["oxfmt"]));
        assert.equal(declaresPackage(root, "prettier"), false);
      });

      it("returns every requested package that the declaring package.json lists", () => {
        writeProjectFile(
          root,
          "package.json",
          JSON.stringify({ dependencies: { oxfmt: "1.0.0" }, devDependencies: { prettier: "1.0.0", eslint: "1.0.0" } }),
        );
        assert.deepEqual(nearestDeclared(root, ["oxfmt", "prettier", "@biomejs/biome"]), new Set(["oxfmt", "prettier"]));
      });

      it("finds the declaration in an ancestor directory", () => {
        declareIn(root, "devDependencies", ["typescript"]);
        const inner = join(root, "packages", "app", "src");
        mkdirSync(inner, { recursive: true });
        assert.equal(declaresPackage(inner, "typescript"), true);
      });

      it("uses the nearest package.json that declares any of the names, and ignores the ones above it", () => {
        declareIn(root, "devDependencies", ["oxfmt"]);
        declareIn(join(root, "pkg"), "devDependencies", ["prettier"]);
        const inner = join(root, "pkg", "src");
        mkdirSync(inner, { recursive: true });

        assert.deepEqual(nearestDeclared(inner, ["oxfmt", "prettier"]), new Set(["prettier"]));
        assert.deepEqual(nearestDeclared(root, ["oxfmt", "prettier"]), new Set(["oxfmt"]));
        // declaresPackage asks about one name, so the package.json that declares only prettier is skipped.
        assert.equal(declaresPackage(inner, "oxfmt"), true);
        assert.equal(declaresPackage(inner, "prettier"), true);
      });

      it("skips a package.json that declares none of the names", () => {
        declareIn(root, "devDependencies", ["prettier"]);
        declareIn(join(root, "pkg"), "devDependencies", ["left-pad"]);
        const inner = join(root, "pkg", "src");
        mkdirSync(inner, { recursive: true });

        assert.deepEqual(nearestDeclared(inner, ["prettier"]), new Set(["prettier"]));
      });

      it("does not look above the directory that contains .git", async () => {
        const outer = realpathSync(mkdtempSync(join(tmpdir(), "hooks-outer-")));
        try {
          declareIn(outer, "devDependencies", ["prettier"]);
          const inner = join(outer, "project");
          mkdirSync(join(inner, ".git"), { recursive: true });
          assert.deepEqual(nearestDeclared(inner, ["prettier"]), new Set());
          assert.equal(declaresPackage(inner, "prettier"), false);
        } finally {
          rmSync(outer, { recursive: true, force: true });
        }
      });

      it("returns nothing when package.json is missing, unparsable, or not an object", () => {
        assert.deepEqual(nearestDeclared(root, ["prettier"]), new Set());

        writeProjectFile(root, "package.json", "{ not json");
        assert.deepEqual(nearestDeclared(root, ["prettier"]), new Set());

        writeProjectFile(root, "package.json", "[]");
        assert.deepEqual(nearestDeclared(root, ["prettier"]), new Set());

        writeProjectFile(root, "package.json", JSON.stringify({ devDependencies: ["prettier"], dependencies: null }));
        assert.deepEqual(nearestDeclared(root, ["prettier"]), new Set());
      });

      it("continues to an ancestor when the nearest package.json is broken", () => {
        declareIn(root, "devDependencies", ["prettier"]);
        writeProjectFile(root, "pkg/package.json", "{ not json");
        assert.equal(declaresPackage(join(root, "pkg"), "prettier"), true);
      });

      it("does not count a top-level prettier key, or a package only named in scripts or peerDependencies", () => {
        writeProjectFile(
          root,
          "package.json",
          JSON.stringify({
            prettier: { semi: false },
            scripts: { format: "prettier --write ." },
            peerDependencies: { prettier: "3.0.0" },
            optionalDependencies: { prettier: "3.0.0" },
          }),
        );
        assert.equal(declaresPackage(root, "prettier"), false);
      });
    });

    it("normalizes the agent key", () => {
      assert.equal(agentKeyOf({ agent_id: "agent-abc" }), "abc");
      assert.equal(agentKeyOf({ agent_id: "abc" }), "abc");
      assert.equal(agentKeyOf({ agent_id: "../x/y" }), "___x_y");
      assert.equal(agentKeyOf({}), "main");
    });
  });

  describe("record-edit", () => {
    it("passes files with a non-target extension and does not record them", () => {
      writeProjectFile(root, "eslint.config.js");
      fakeBin(root, "eslint", { exit: 1, output: "boom" });
      const file = writeProjectFile(root, "README.md", "x");
      assert.equal(record(editInput(file), { stateDir }), null);
      assert.equal(existsSync(statePaths(editInput(file), stateDir).filesPath), false);
    });

    it("passes when the file does not exist and does not record it", () => {
      writeProjectFile(root, "eslint.config.js");
      fakeBin(root, "eslint", { exit: 1, output: "boom" });
      assert.equal(record(editInput(join(root, "gone.js")), { stateDir }), null);
      assert.equal(existsSync(statePaths(editInput(join(root, "gone.js")), stateDir).filesPath), false);
    });

    it("ignores tools other than Edit, Write and MultiEdit", () => {
      const file = writeProjectFile(root, "src/a.ts", "x");
      assert.equal(record(editInput(file, { tool_name: "Read" }), { stateDir }), null);
      assert.equal(existsSync(statePaths(editInput(file), stateDir).filesPath), false);
    });

    it("never runs a linter or prints anything, even when a linter would fail", () => {
      const log = join(stateDir, "eslint.log");
      writeProjectFile(root, "eslint.config.js");
      fakeShell(root, "eslint", `echo run >> "${log}"\nexit 1`);
      const file = writeProjectFile(root, "a.js", "x");

      assert.equal(record(editInput(file), { stateDir }), null);

      assert.equal(existsSync(log), false);
      assert.equal(readFileSync(statePaths(editInput(file), stateDir).filesPath, "utf8"), `${file}\n`);
    });

    it("records edited TS files under the normalized agent key", () => {
      const file = writeProjectFile(root, "src/a.ts", "x");
      record(editInput(file, { agent_id: "agent-abc", agent_type: "worker" }), { stateDir });
      record(editInput(file), { stateDir });

      const subagent = statePaths({ session_id: "s1", agent_id: "agent-abc" }, stateDir);
      const main = statePaths({ session_id: "s1" }, stateDir);
      assert.equal(subagent.filesPath, join(stateDir, "s1", "abc.files"));
      assert.equal(readFileSync(subagent.filesPath, "utf8"), `${file}\n`);
      assert.equal(readFileSync(main.filesPath, "utf8"), `${file}\n`);
    });

    it("records JS and framework files, not other extensions", () => {
      const names = ["a.js", "b.jsx", "c.mjs", "d.cjs", "e.vue", "f.svelte"];
      const expected = names.map((name) => writeProjectFile(root, `src/${name}`, "x"));
      for (const file of expected) {
        record(editInput(file), { stateDir });
      }
      record(editInput(writeProjectFile(root, "src/README.md", "x")), { stateDir });
      record(editInput(writeProjectFile(root, "src/data.json", "{}")), { stateDir });

      const recorded = readFileSync(statePaths({ session_id: "s1" }, stateDir).filesPath, "utf8");
      assert.equal(recorded, expected.map((file) => `${file}\n`).join(""));
    });
  });

  describe("lint at stop (check-on-stop)", () => {
    // Records `file`, then stops.
    async function stopAfter(file, options = {}, input = {}) {
      record(editInput(file), { stateDir });
      return check(stopInput({ cwd: root, ...input }), { stateDir, ...options });
    }

    it("passes when the project has no linter", async () => {
      const file = writeProjectFile(root, "src/a.ts", "x");
      assert.equal(await stopAfter(file), null);
    });

    it("does not use linters installed above the .git boundary", async () => {
      const outer = realpathSync(mkdtempSync(join(tmpdir(), "hooks-outer-")));
      try {
        writeProjectFile(outer, "eslint.config.js");
        fakeBin(outer, "eslint", { exit: 1, output: "boom" });
        const inner = join(outer, "project");
        mkdirSync(join(inner, ".git"), { recursive: true });
        const file = writeProjectFile(inner, "a.js", "x");
        assert.equal(await stopAfter(file), null);
      } finally {
        rmSync(outer, { recursive: true, force: true });
      }
    });

    it("blocks with the linter output when it exits non-zero", async () => {
      writeProjectFile(root, "eslint.config.js");
      declare(root, ["eslint"]);
      fakeBin(root, "eslint", { exit: 1, output: "\u001b[31m3:1  error  no-undef\u001b[0m" });
      const file = writeProjectFile(root, "src/a.js", "x");

      const result = await stopAfter(file);

      assert.equal(result.decision, "block");
      assert.ok(result.reason.startsWith("[린트]\n"));
      assert.match(result.reason, /\[ESLint\] exit 1/);
      assert.ok(result.reason.includes(file));
      assert.ok(result.reason.includes("3:1  error  no-undef"));
      assert.ok(!result.reason.includes("\u001b"));
      assert.ok(result.reason.includes(`CWD: ${root}`));
    });

    it("passes when the linter exits 0, even with output", async () => {
      writeProjectFile(root, "eslint.config.js");
      declare(root, ["eslint"]);
      fakeBin(root, "eslint", { exit: 0, output: "1:1 warning something" });
      const file = writeProjectFile(root, "a.js", "x");
      assert.equal(await stopAfter(file), null);
    });

    it("skips a declared ESLint when there is a bin but no config", async () => {
      declare(root, ["eslint"]);
      fakeBin(root, "eslint", { exit: 1, output: "boom" });
      const file = writeProjectFile(root, "a.js", "x");
      assert.equal(await stopAfter(file), null);
    });

    describe("a linter that no package.json declares", () => {
      it("is not run for oxlint, ESLint or Biome, even with a config and a bin", async () => {
        writeProjectFile(root, "eslint.config.js");
        writeProjectFile(root, ".oxlintrc.json", "{}");
        writeProjectFile(root, "biome.json", "{}");
        for (const name of ["eslint", "oxlint", "biome"]) {
          fakeBin(root, name, { exit: 1, output: `${name} says no` });
        }
        const file = writeProjectFile(root, "src/a.js", "x");

        assert.equal(await stopAfter(file), null);
      });

      it("is not run when only a bin exists", async () => {
        for (const name of ["eslint", "oxlint", "biome"]) {
          fakeBin(root, name, { exit: 1, output: `${name} says no` });
        }
        assert.equal(await stopAfter(writeProjectFile(root, "a.js", "x")), null);
      });

      it("is not run for ESLint when it is declared and has a bin but no config", async () => {
        declare(root, ["eslint"]);
        fakeBin(root, "eslint", { exit: 1, output: "boom" });
        assert.equal(await stopAfter(writeProjectFile(root, "a.js", "x")), null);
      });

      it("is not run when only scripts or peerDependencies or a top-level key mention it", async () => {
        writeProjectFile(root, "eslint.config.js");
        writeProjectFile(
          root,
          "package.json",
          JSON.stringify({
            scripts: { lint: "eslint ." },
            peerDependencies: { eslint: "9.0.0" },
            optionalDependencies: { eslint: "9.0.0" },
            eslintConfig: {},
          }),
        );
        fakeBin(root, "eslint", { exit: 1, output: "boom" });
        assert.equal(await stopAfter(writeProjectFile(root, "a.js", "x")), null);
      });

      it("is run once a package.json declares it, in dependencies as well as devDependencies", async () => {
        writeProjectFile(root, "eslint.config.js");
        writeProjectFile(root, "package.json", JSON.stringify({ dependencies: { eslint: "9.0.0" } }));
        fakeBin(root, "eslint", { exit: 1, output: "boom" });
        assert.equal((await stopAfter(writeProjectFile(root, "a.js", "x"))).decision, "block");
      });

      it("is not run when the package.json that declares it is above the .git boundary", async () => {
        const outer = realpathSync(mkdtempSync(join(tmpdir(), "hooks-outer-")));
        try {
          declare(outer, ["eslint"]);
          const inner = join(outer, "project");
          mkdirSync(join(inner, ".git"), { recursive: true });
          writeProjectFile(inner, "eslint.config.js");
          fakeBin(inner, "eslint", { exit: 1, output: "boom" });
          assert.equal(await stopAfter(writeProjectFile(inner, "a.js", "x")), null);
        } finally {
          rmSync(outer, { recursive: true, force: true });
        }
      });

      it("is run from a subpackage when only the root package.json declares it", async () => {
        declare(root, ["eslint"]);
        writeProjectFile(root, "eslint.config.js");
        fakeBin(root, "eslint", { exit: 1, output: "boom" });
        const result = await stopAfter(writeProjectFile(root, "packages/app/src/a.js", "x"));
        assert.equal(result.decision, "block");
      });

      it("is chosen by the nearest package.json that declares a linter, not by the root", async () => {
        declare(root, ["oxlint"]);
        declare(root, ["eslint"], "packages/app");
        writeProjectFile(root, "packages/app/eslint.config.js");
        for (const name of ["eslint", "oxlint"]) {
          fakeShell(root, name, `echo "${name} says no"\nexit 1`);
        }
        const result = await stopAfter(writeProjectFile(root, "packages/app/src/a.js", "x"));
        assert.ok(result.reason.includes("eslint says no"));
        assert.ok(!result.reason.includes("oxlint says no"));
      });

      it("is not run for a file whose nearest declaring package.json lists only other linters", async () => {
        declare(root, ["eslint"]);
        declare(root, ["@biomejs/biome"], "packages/app");
        writeProjectFile(root, "eslint.config.js");
        fakeBin(root, "eslint", { exit: 1, output: "eslint says no" });
        // Biome is declared but has no bin, and the root's ESLint is behind the nearer declaration.
        assert.equal(await stopAfter(writeProjectFile(root, "packages/app/a.js", "x")), null);
      });
    });

    it("runs ESLint from the config directory for legacy configs and .vue files", async () => {
      writeProjectFile(root, "pkg/.eslintrc.json", "{}");
      declare(root, ["eslint"]);
      fakeBin(root, "eslint", { exit: 1, output: "vue problem" });
      const file = writeProjectFile(root, "pkg/src/App.vue", "x");

      const result = await stopAfter(file);

      assert.equal(result.decision, "block");
      assert.ok(result.reason.includes(`CWD: ${join(root, "pkg")}`));
    });

    it("runs Biome in lint-only mode from the biome.json directory", async () => {
      writeProjectFile(root, "pkg/biome.json", "{}");
      declare(root, ["@biomejs/biome"]);
      // biome.json also makes Biome a formatter: `format` passes, `lint` fails.
      fakeShell(root, "biome", `case "$1" in format) exit 0;; esac\necho "CWD: $(pwd -P)"\necho "ARGS: $*"\necho "lint/suspicious"\nexit 1`);
      const file = writeProjectFile(root, "pkg/a.ts", "x");

      const result = await stopAfter(file);

      assert.ok(result.reason.includes("[Biome] exit 1"));
      assert.ok(result.reason.includes(`CWD: ${join(root, "pkg")}`));
      assert.ok(
        result.reason.includes(`ARGS: lint --no-errors-on-unmatched --files-ignore-unknown=true ${file}`),
      );
    });

    it("finds Biome configs named .biome.json and .biome.jsonc", async () => {
      declare(root, ["@biomejs/biome"]);
      for (const name of [".biome.json", ".biome.jsonc"]) {
        writeProjectFile(root, `${name}-dir/${name}`, "{}");
        fakeShell(root, "biome", `case "$1" in format) exit 0;; esac\necho "CWD: $(pwd -P)"\nexit 1`);
        const file = writeProjectFile(root, `${name}-dir/a.ts`, "x");

        const result = await stopAfter(file);

        assert.ok(result.reason.includes(`CWD: ${join(root, `${name}-dir`)}`), name);
        clearState(statePaths(stopInput(), stateDir));
      }
    });

    it("tells about ESLint exit 2 (configuration or internal error) without blocking, but still blocks exit 1", async () => {
      writeProjectFile(root, "eslint.config.js");
      declare(root, ["eslint"]);
      fakeBin(root, "eslint", { exit: 2, output: "Oops! Something went wrong!" });
      const file = writeProjectFile(root, "a.js", "x");

      const first = await stopAfter(file);

      assert.equal(first.decision, undefined);
      assert.equal(first.hookSpecificOutput.hookEventName, "Stop");
      assert.match(first.hookSpecificOutput.additionalContext, /eslint/);
      assert.match(first.hookSpecificOutput.additionalContext, /Oops! Something went wrong!/);
      assert.match(first.hookSpecificOutput.additionalContext, /검증하지 못했다/);

      fakeBin(root, "eslint", { exit: 1, output: "1:1 error" });
      assert.equal((await stopAfter(file)).decision, "block");
    });

    it("says an ESLint exit 2 once across blocks", async () => {
      writeProjectFile(root, "eslint.config.js");
      declare(root, ["eslint"]);
      writeProjectFile(root, "tsconfig.json", "{}");
      declare(root, ["typescript"]);
      fakeBin(root, "eslint", { exit: 2, output: "Oops" });
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });
      const file = writeProjectFile(root, "src/a.ts", "x");
      const input = stopInput({ stop_hook_active: true, cwd: root });
      record(editInput(file), { stateDir });

      const first = await check(input, { stateDir });
      const second = await check(input, { stateDir });

      assert.ok(first.reason.includes("[타입 검사]"));
      assert.ok(first.reason.includes("eslint가 결과를 내지 못하고 끝나 검증하지 못했다"));
      assert.ok(!second.reason.includes("eslint가"));
      assert.equal(readFileSync(statePaths(input, stateDir).notifiedPath, "utf8"), "lint:eslint:tool\n");
    });

    for (const [name, label, packageName] of [
      ["biome", "Biome", "@biomejs/biome"],
      ["oxlint", "oxlint", "oxlint"],
    ]) {
      it(`keeps blocking on ${label} exit 2`, async () => {
        declare(root, [packageName]);
        fakeBin(root, name, { exit: 2, output: "x" });
        const file = writeProjectFile(root, "a.js", "x");

        const result = await stopAfter(file);

        assert.ok(result.reason.includes(`[${label}] exit 2`));
      });
    }

    it("runs oxlint with --no-error-on-unmatched-pattern so ignored files pass", async () => {
      declare(root, ["oxlint"]);
      fakeBin(root, "oxlint", { exit: 1, output: "o" });
      const file = writeProjectFile(root, "a.js", "x");

      const result = await stopAfter(file);

      assert.ok(result.reason.includes(`ARGS: --no-error-on-unmatched-pattern ${file}`));
    });

    it("tells Claude to leave pre-existing errors out of scope", async () => {
      writeProjectFile(root, "eslint.config.js");
      declare(root, ["eslint"]);
      fakeBin(root, "eslint", { exit: 1, output: "x" });
      const file = writeProjectFile(root, "a.js", "x");

      const { reason } = await stopAfter(file);

      assert.ok(reason.includes("이번 변경으로 생긴 오류는 고친다."));
      assert.ok(reason.includes("원래 있던 오류는 작업 범위 밖이면 고치지 말고 보고에 남긴다."));
    });

    for (const [name, packageName] of [
      ["biome", "@biomejs/biome"],
      ["oxlint", "oxlint"],
    ]) {
      it(`runs ${name} from the bin project when no config exists`, async () => {
        declare(root, [packageName]);
        // A declared Biome is also a formatter: its `format` run passes, `lint` fails.
        fakeShell(root, name, `case "$1" in format) exit 0;; esac\necho "CWD: $(pwd -P)"\nexit 1`);
        const file = writeProjectFile(root, "src/a.js", "x");

        const result = await stopAfter(file);

        assert.equal(result.reason.split(`CWD: ${root}`).length, 2);
      });
    }

    describe("one linter per file, in the order oxlint, ESLint, Biome", () => {
      // Every linter logs its name and the files it was given, then fails with its own message.
      // A declared Biome is also a formatter; its `format` run is not a lint run, so it passes silently.
      function fakeLinters(names) {
        const log = join(stateDir, "lint.log");
        for (const name of names) {
          const skipFormat = name === "biome" ? 'case "$1" in format) exit 0;; esac\n' : "";
          fakeShell(root, name, `${skipFormat}echo "${name} $*" >> "${log}"\necho "${name} says no"\nexit 1`);
        }
        return () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
      }

      it("runs only oxlint when oxlint, ESLint and Biome are all detected", async () => {
        declare(root, ["oxlint", "eslint", "@biomejs/biome"]);
        writeProjectFile(root, "eslint.config.mjs");
        declare(root, ["eslint"]);
        writeProjectFile(root, ".oxlintrc.json", "{}");
        const runs = fakeLinters(["eslint", "oxlint", "biome"]);
        const file = writeProjectFile(root, "a.mjs", "x");

        const result = await stopAfter(file);

        assert.ok(result.reason.includes("oxlint says no"));
        assert.ok(!result.reason.includes("eslint says no"));
        assert.ok(!result.reason.includes("biome says no"));
        assert.deepEqual(runs(), [`oxlint --no-error-on-unmatched-pattern ${file}`]);
      });

      it("falls back to ESLint when oxlint is not declared, and to Biome when ESLint has no config", async () => {
        declare(root, ["eslint", "@biomejs/biome"]);
        writeProjectFile(root, "eslint.config.mjs");
        declare(root, ["eslint"]);
        const runs = fakeLinters(["eslint", "biome"]);
        const file = writeProjectFile(root, "a.mjs", "x");

        const withEslint = await stopAfter(file);

        assert.ok(withEslint.reason.includes("eslint says no"));
        assert.deepEqual(runs(), [`eslint ${file}`]);

        rmSync(join(root, "eslint.config.mjs"));
        rmSync(join(stateDir, "lint.log"));
        const withBiome = await stopAfter(file);

        assert.ok(withBiome.reason.includes("biome says no"));
        assert.ok(!withBiome.reason.includes("eslint says no"));
        assert.deepEqual(runs(), [`biome lint --no-errors-on-unmatched --files-ignore-unknown=true ${file}`]);
      });

      it("falls back to ESLint when oxlint is declared but not installed", async () => {
        declare(root, ["oxlint", "eslint"]);
        writeProjectFile(root, "eslint.config.mjs");
        const runs = fakeLinters(["eslint"]);
        const file = writeProjectFile(root, "a.mjs", "x");

        const result = await stopAfter(file);

        assert.ok(result.reason.includes("eslint says no"));
        assert.deepEqual(runs(), [`eslint ${file}`]);
      });

      it("does not run an undeclared oxlint even when it is installed", async () => {
        declare(root, ["@biomejs/biome"]);
        const runs = fakeLinters(["oxlint", "biome"]);
        const file = writeProjectFile(root, "a.mjs", "x");

        const result = await stopAfter(file);

        assert.ok(result.reason.includes("biome says no"));
        assert.deepEqual(runs(), [`biome lint --no-errors-on-unmatched --files-ignore-unknown=true ${file}`]);
      });

      it("picks per file: oxlint for scripts, ESLint for the files oxlint does not handle", async () => {
        declare(root, ["oxlint", "eslint"]);
        writeProjectFile(root, "eslint.config.mjs");
        declare(root, ["eslint"]);
        writeProjectFile(root, ".oxlintrc.json", "{}");
        const runs = fakeLinters(["eslint", "oxlint"]);
        const script = writeProjectFile(root, "a.ts", "x");
        const vue = writeProjectFile(root, "b.vue", "x");
        record(editInput(script), { stateDir });

        const result = await stopAfter(vue);

        assert.ok(result.reason.includes("oxlint says no"));
        assert.ok(result.reason.includes("eslint says no"));
        assert.deepEqual(runs().sort(), [`eslint ${vue}`, `oxlint --no-error-on-unmatched-pattern ${script}`]);
      });
    });

    it("truncates long linter output", async () => {
      writeProjectFile(root, "eslint.config.js");
      declare(root, ["eslint"]);
      fakeBin(root, "eslint", { exit: 1, output: "x".repeat(20_000) });
      const file = writeProjectFile(root, "a.js", "x");

      const { reason } = await stopAfter(file);

      assert.ok(reason.length < 6500);
      assert.match(reason, /자 생략\)/);
    });

    it("runs a linter once with all the files it applies to", async () => {
      writeProjectFile(root, "eslint.config.js");
      declare(root, ["eslint"]);
      fakeBin(root, "eslint", { exit: 1, output: "x" });
      const first = writeProjectFile(root, "src/a.js", "x");
      const second = writeProjectFile(root, "src/b.js", "x");
      record(editInput(first), { stateDir });
      record(editInput(second), { stateDir });

      const { reason } = await check(stopInput({ cwd: root }), { stateDir });

      assert.equal(reason.split("ARGS:").length, 2);
      assert.ok(reason.includes(`ARGS: ${first} ${second}`));
    });

    it("lints only the files whose extension the linter handles", async () => {
      declare(root, ["oxlint"]);
      fakeBin(root, "oxlint", { exit: 1, output: "o" });
      const script = writeProjectFile(root, "src/a.js", "x");
      const view = writeProjectFile(root, "src/App.vue", "x");
      record(editInput(script), { stateDir });
      record(editInput(view), { stateDir });

      const { reason } = await check(stopInput({ cwd: root }), { stateDir });

      assert.ok(reason.includes(`ARGS: --no-error-on-unmatched-pattern ${script}\n`));
      assert.ok(!reason.includes("App.vue"));
    });

    it("runs lint and tsc at the same time", async () => {
      writeProjectFile(root, "eslint.config.js");
      declare(root, ["eslint"]);
      writeProjectFile(root, "tsconfig.json", "{}");
      declare(root, ["typescript"]);
      const marks = join(stateDir, "marks");
      mkdirSync(marks, { recursive: true });
      // Each tool announces itself, then waits (at most 5s) for the other.
      const rendezvous = (self, other, onSuccess) =>
        [
          `touch "${marks}/${self}"`,
          "i=0",
          `while [ ! -f "${marks}/${other}" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done`,
          `if [ -f "${marks}/${other}" ]; then ${onSuccess}; fi`,
          "exit 0",
        ].join("\n");
      fakeShell(root, "tsc", rendezvous("tsc", "eslint", `echo "src/a.ts(3,5): error TS2322: bad"; exit 2`));
      fakeShell(root, "eslint", rendezvous("eslint", "tsc", `echo "lint is unhappy"; exit 1`));

      const result = await stopAfter(writeProjectFile(root, "src/a.ts", "x"));

      assert.equal(result.decision, "block");
      assert.ok(result.reason.includes("lint is unhappy"));
      assert.ok(result.reason.includes("TS2322"));
    });

    it("puts the lint section before the typecheck and test sections", async () => {
      writeProjectFile(root, "eslint.config.js");
      declare(root, ["eslint"]);
      declare(root, ["vitest"]);
      writeProjectFile(root, "tsconfig.json", "{}");
      declare(root, ["typescript"]);
      fakeBin(root, "eslint", { exit: 1, output: "lint is unhappy" });
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });
      fakeBin(root, "vitest", { exit: 1, output: "FAIL  src/a.test.ts > adds" });
      const env = { ...process.env, CLAUDE_HOOKS_SKIP_TESTS: "" };

      const { reason } = await stopAfter(writeProjectFile(root, "src/a.ts", "x"), { env });

      const order = ["[린트]", "[타입 검사]", "[테스트]"].map((title) => reason.indexOf(title));
      assert.ok(order.every((index) => index >= 0));
      assert.deepEqual(order, [...order].sort((a, b) => a - b));
    });

    it("blocks up to three times, says last check on the third, then does not run lint again", async () => {
      writeProjectFile(root, "eslint.config.js");
      declare(root, ["eslint"]);
      writeProjectFile(root, "tsconfig.json", "{}");
      declare(root, ["typescript"]);
      const log = join(stateDir, "eslint.log");
      fakeShell(root, "eslint", `echo run >> "${log}"\necho "lint error"\nexit 1`);
      fakeBin(root, "tsc", { exit: 0 });
      const file = writeProjectFile(root, "src/a.ts", "x");
      const input = stopInput({ stop_hook_active: true, cwd: root });
      const paths = statePaths(input, stateDir);
      record(editInput(file), { stateDir });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await check(input, { stateDir });
        assert.equal(result.decision, "block");
        assert.equal(result.reason.includes("이번이 마지막 확인이다. 고치지 못하면 원인을 보고에 남겨라."), attempt === 2);
        assert.equal(readFileSync(paths.lintBlocksPath, "utf8"), String(attempt + 1));
      }

      // Another kind still blocks, and lint is not run again nor counted.
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });
      const result = await check(input, { stateDir });
      assert.equal(result.decision, "block");
      assert.ok(result.reason.includes("[타입 검사]"));
      assert.ok(!result.reason.includes("[린트]"));
      assert.equal(readFileSync(paths.lintBlocksPath, "utf8"), "3");
      assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3);
    });

    it("counts lint blocks apart from typecheck blocks", async () => {
      writeProjectFile(root, "eslint.config.js");
      declare(root, ["eslint"]);
      writeProjectFile(root, "tsconfig.json", "{}");
      declare(root, ["typescript"]);
      fakeBin(root, "eslint", { exit: 1, output: "lint error" });
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });
      const input = stopInput({ stop_hook_active: true, cwd: root });
      const paths = statePaths(input, stateDir);
      record(editInput(writeProjectFile(root, "src/a.ts", "x")), { stateDir });

      await check(input, { stateDir });
      fakeBin(root, "eslint", { exit: 0 });
      await check(input, { stateDir });

      assert.equal(readFileSync(paths.lintBlocksPath, "utf8"), "1");
      assert.equal(readFileSync(paths.typecheckBlocksPath, "utf8"), "2");
    });

    it("says in a Handback deny that the errors are to be fixed before the report", async () => {
      writeProjectFile(root, "eslint.config.js");
      declare(root, ["eslint"]);
      fakeBin(root, "eslint", { exit: 1, output: "lint error" });
      const agent = { agent_id: "agent-abc", agent_type: "worker" };
      record(editInput(writeProjectFile(root, "src/a.js", "x"), agent), { stateDir });

      const result = await check(
        { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "SubagentHandback", cwd: root, ...agent },
        { stateDir },
      );

      assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
      const reason = result.hookSpecificOutput.permissionDecisionReason;
      assert.ok(reason.startsWith("[린트]"));
      assert.ok(reason.includes("보고 전에 이번 변경으로 생긴 오류는 고친다."));
    });

    it("sends a lint timeout as a notice once and does not block", async () => {
      writeProjectFile(root, "eslint.config.js");
      declare(root, ["eslint"]);
      fakeShell(root, "eslint", "sleep 5");
      const file = writeProjectFile(root, "src/a.js", "x");
      const options = { stateDir, timeouts: { lint: 1000 } };

      const result = await stopAfter(file, options);

      assert.deepEqual(result, {
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: "- eslint가 1초 안에 끝나지 않아 검증하지 못했다.",
        },
      });
    });

    it("keeps the timeout key lint:<tool>:timeout in the notified state of a block", async () => {
      writeProjectFile(root, "eslint.config.js");
      declare(root, ["eslint"]);
      writeProjectFile(root, "tsconfig.json", "{}");
      declare(root, ["typescript"]);
      fakeShell(root, "eslint", "sleep 5");
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });
      const input = stopInput({ stop_hook_active: true, cwd: root });
      record(editInput(writeProjectFile(root, "src/a.ts", "x")), { stateDir });

      const result = await check(input, { stateDir, timeouts: { lint: 1000 } });

      assert.ok(result.reason.endsWith("- eslint가 1초 안에 끝나지 않아 검증하지 못했다."));
      assert.equal(readFileSync(statePaths(input, stateDir).notifiedPath, "utf8"), "lint:eslint:timeout\n");
    });

    it("does not block on a linter that cannot be spawned and says so", async () => {
      writeProjectFile(root, "eslint.config.js");
      declare(root, ["eslint"]);
      chmodSync(writeProjectFile(root, "node_modules/.bin/eslint", "#!/nonexistent/interpreter\n"), 0o755);

      const result = await stopAfter(writeProjectFile(root, "a.js", "x"));

      assert.equal(result.decision, undefined);
      assert.match(result.hookSpecificOutput.additionalContext, /eslint/);
      assert.match(result.hookSpecificOutput.additionalContext, /검증하지 못했다/);
    });

    it("says lint was not run when no time is left", async () => {
      writeProjectFile(root, "eslint.config.js");
      declare(root, ["eslint"]);
      fakeBin(root, "eslint", { exit: 1, output: "lint error" });

      const result = await stopAfter(writeProjectFile(root, "a.js", "x"), { timeouts: { total: 0 } });

      assert.equal(result.hookSpecificOutput.additionalContext, "- 남은 시간이 없어 eslint를 실행하지 못했다.");
    });
  });

  describe("format at stop (check-on-stop)", () => {
    const FORMAT_ARGS = {
      prettier: "--write --ignore-unknown --no-error-on-unmatched-pattern",
      biome: "format --write --no-errors-on-unmatched --files-ignore-unknown=true",
      oxfmt: "--no-error-on-unmatched-pattern",
    };

    function logPath() {
      return join(stateDir, "format.log");
    }

    // Fake formatter: logs its start and end with cwd and arguments, optionally waits, writes `write` into
    // every file argument (the arguments that are not options and exist), prints `output`, exits with `exit`.
    function fakeFormatter(name, { exit = 0, write = `formatted-by-${name}`, sleep = 0, output = "" } = {}) {
      const lines = [
        `echo "start ${name} CWD: $(pwd -P) ARGS: $*" >> "${logPath()}"`,
        sleep > 0 ? `sleep ${sleep}` : "",
        // Biome's lint run (the first argument is `lint`) must leave the files alone.
        write === null
          ? ""
          : `if [ "$1" != lint ]; then for arg in "$@"; do case "$arg" in -*) ;; *) if [ -f "$arg" ]; then printf '%s' "${write}" > "$arg"; fi;; esac; done; fi`,
        `echo "end ${name} ARGS: $*" >> "${logPath()}"`,
        output === "" ? "" : `echo "${output}"`,
        `exit ${exit}`,
      ];
      fakeShell(root, name, lines.filter((line) => line !== "").join("\n"));
    }

    // The format runs of the log: lines of starts and ends, without Biome's lint run.
    function formatLog() {
      if (!existsSync(logPath())) {
        return [];
      }
      return readFileSync(logPath(), "utf8")
        .trim()
        .split("\n")
        .filter((line) => !line.includes("ARGS: lint"));
    }

    function startsOf(name) {
      return formatLog().filter((line) => line.startsWith(`start ${name} `));
    }

    async function stopAfter(file, options = {}, input = {}) {
      record(editInput(file), { stateDir });
      return check(stopInput({ cwd: root, ...input }), { stateDir, ...options });
    }

    // Prettier is selected only by a declaration in dependencies/devDependencies.
    const PRETTIER_DECLARATIONS = [
      ["a prettier devDependency", () => writeProjectFile(root, "package.json", JSON.stringify({ devDependencies: { prettier: "3.0.0" } }))],
      ["a prettier dependency", () => writeProjectFile(root, "package.json", JSON.stringify({ dependencies: { prettier: "3.0.0" } }))],
      [
        "a prettier devDependency and a .prettierrc.toml file",
        () => {
          declare(root, ["prettier"]);
          writeProjectFile(root, ".prettierrc.toml", "semi = false");
        },
      ],
    ];
    for (const [name, setUp] of PRETTIER_DECLARATIONS) {
      it(`runs Prettier from the bin project for ${name}, and a format alone sends nothing`, async () => {
        setUp();
        fakeFormatter("prettier");
        const file = writeProjectFile(root, "src/a.ts", "x");

        const result = await stopAfter(file);

        assert.equal(result, null);
        assert.deepEqual(startsOf("prettier"), [`start prettier CWD: ${root} ARGS: ${FORMAT_ARGS.prettier} ${file}`]);
        assert.equal(readFileSync(file, "utf8"), "formatted-by-prettier");
        assert.equal(existsSync(statePaths(stopInput(), stateDir).filesPath), false);
      });
    }

    // Without a declaration these never select Prettier, whatever else exists next to a bin.
    const PRETTIER_WITHOUT_DECLARATION = [
      ["a .prettierrc file", () => writeProjectFile(root, ".prettierrc", "{}")],
      ["a .prettierrc.toml file", () => writeProjectFile(root, ".prettierrc.toml", "semi = false")],
      ["a prettier.config.mjs file", () => writeProjectFile(root, "prettier.config.mjs", "export default {};")],
      ["a prettier key in package.json", () => writeProjectFile(root, "package.json", JSON.stringify({ prettier: { semi: false } }))],
      [
        "a prettier script and peerDependency in package.json",
        () =>
          writeProjectFile(
            root,
            "package.json",
            JSON.stringify({ scripts: { format: "prettier --write ." }, peerDependencies: { prettier: "3.0.0" } }),
          ),
      ],
    ];
    for (const [name, setUp] of PRETTIER_WITHOUT_DECLARATION) {
      it(`does not run Prettier for ${name} with a bin but no declaration`, async () => {
        setUp();
        fakeFormatter("prettier");
        const file = writeProjectFile(root, "src/a.ts", "x");

        assert.equal(await stopAfter(file), null);

        assert.deepEqual(formatLog(), []);
        assert.equal(readFileSync(file, "utf8"), "x");
      });
    }

    it("does not run Prettier for a bin alone", async () => {
      fakeFormatter("prettier");
      const file = writeProjectFile(root, "src/a.ts", "x");

      assert.equal(await stopAfter(file), null);

      assert.deepEqual(formatLog(), []);
      assert.equal(readFileSync(file, "utf8"), "x");
    });

    it("does not run Prettier when it is declared but has no bin", async () => {
      declare(root, ["prettier"]);
      const file = writeProjectFile(root, "src/a.ts", "x");

      assert.equal(await stopAfter(file), null);

      assert.equal(readFileSync(file, "utf8"), "x");
    });

    it("does not run a formatter whose declaration is for another tool", async () => {
      declare(root, ["vitest"]);
      fakeFormatter("prettier");
      fakeFormatter("biome");
      fakeFormatter("oxfmt");

      assert.equal(await stopAfter(writeProjectFile(root, "src/a.ts", "x")), null);

      assert.deepEqual(formatLog(), []);
    });

    it("does not run a formatter declared only above the .git boundary", async () => {
      const outer = realpathSync(mkdtempSync(join(tmpdir(), "hooks-outer-")));
      try {
        declare(outer, ["prettier"]);
        const inner = join(outer, "project");
        mkdirSync(join(inner, ".git"), { recursive: true });
        fakeShell(inner, "prettier", `echo run >> "${logPath()}"`);
        const file = writeProjectFile(inner, "src/a.ts", "x");

        assert.equal(await stopAfter(file, {}, { cwd: inner }), null);

        assert.deepEqual(formatLog(), []);
      } finally {
        rmSync(outer, { recursive: true, force: true });
      }
    });

    it("runs a formatter declared in the root package.json for a file of a subpackage", async () => {
      declare(root, ["prettier"]);
      fakeFormatter("prettier");
      const file = writeProjectFile(root, "packages/app/src/a.ts", "x");

      await stopAfter(file);

      assert.deepEqual(startsOf("prettier"), [`start prettier CWD: ${root} ARGS: ${FORMAT_ARGS.prettier} ${file}`]);
    });

    it("lets a subpackage declaration decide over the root's: the root's oxfmt is not used", async () => {
      declare(root, ["oxfmt"]);
      declare(root, ["prettier"], "packages/app");
      fakeFormatter("oxfmt");
      fakeFormatter("prettier");
      const inSubpackage = writeProjectFile(root, "packages/app/src/a.ts", "x");
      const inRoot = writeProjectFile(root, "src/b.ts", "x");
      record(editInput(inRoot), { stateDir });

      await stopAfter(inSubpackage);

      assert.equal(readFileSync(inSubpackage, "utf8"), "formatted-by-prettier");
      assert.equal(readFileSync(inRoot, "utf8"), "formatted-by-oxfmt");
    });

    it("does not fall back to the root's formatter when the subpackage declares another one without a bin", async () => {
      declare(root, ["prettier"]);
      declare(root, ["@biomejs/biome"], "packages/app");
      fakeFormatter("prettier");
      const file = writeProjectFile(root, "packages/app/src/a.ts", "x");

      assert.equal(await stopAfter(file), null);

      assert.deepEqual(formatLog(), []);
      assert.equal(readFileSync(file, "utf8"), "x");
    });

    it("runs Prettier from the bin project even when the config is in a subdirectory", async () => {
      writeProjectFile(root, "pkg/.prettierrc.json", "{}");
      declare(root, ["prettier"]);
      fakeFormatter("prettier");
      const file = writeProjectFile(root, "pkg/src/a.ts", "x");

      await stopAfter(file);

      assert.deepEqual(startsOf("prettier"), [`start prettier CWD: ${root} ARGS: ${FORMAT_ARGS.prettier} ${file}`]);
    });

    it("runs Prettier on .vue and .svelte files", async () => {
      declare(root, ["prettier"]);
      fakeFormatter("prettier");
      const vue = writeProjectFile(root, "src/App.vue", "x");
      const svelte = writeProjectFile(root, "src/App.svelte", "x");
      record(editInput(vue), { stateDir });
      record(editInput(svelte), { stateDir });

      await check(stopInput({ cwd: root }), { stateDir });

      assert.deepEqual(startsOf("prettier"), [`start prettier CWD: ${root} ARGS: ${FORMAT_ARGS.prettier} ${vue} ${svelte}`]);
    });

    it("runs Biome from the config directory for .biome.json, and from the bin project without a config", async () => {
      declare(root, ["@biomejs/biome"]);
      fakeFormatter("biome");
      writeProjectFile(root, "pkg/.biome.json", "{}");
      const configured = writeProjectFile(root, "pkg/a.ts", "x");
      await stopAfter(configured);
      assert.deepEqual(startsOf("biome"), [`start biome CWD: ${join(root, "pkg")} ARGS: ${FORMAT_ARGS.biome} ${configured}`]);

      rmSync(logPath());
      rmSync(join(root, "pkg/.biome.json"));
      const declared = writeProjectFile(root, "pkg/b.ts", "x");
      await stopAfter(declared);
      assert.deepEqual(startsOf("biome"), [`start biome CWD: ${root} ARGS: ${FORMAT_ARGS.biome} ${declared}`]);
    });

    it("does not run Biome for a config and a bin without a declaration", async () => {
      writeProjectFile(root, "biome.json", "{}");
      fakeFormatter("biome");
      const file = writeProjectFile(root, "a.ts", "x");

      assert.equal(await stopAfter(file), null);

      assert.deepEqual(formatLog(), []);
      assert.equal(readFileSync(file, "utf8"), "x");
    });

    it("never uses biome check --write", async () => {
      declare(root, ["@biomejs/biome"]);
      writeProjectFile(root, "biome.json", "{}");
      fakeFormatter("biome");

      await stopAfter(writeProjectFile(root, "a.ts", "x"));

      assert.ok(formatLog().every((line) => !line.includes(" check ")));
    });

    it("does not run a declared Biome when its config turns the formatter off", async () => {
      declare(root, ["@biomejs/biome"]);
      for (const [name, text] of [
        ["biome.json", '{ "formatter": { "enabled": false } }'],
        ["biome.jsonc", '{\n // no formatting here\n "formatter": { "enabled": false, },\n}'],
      ]) {
        writeProjectFile(root, name, text);
        fakeFormatter("biome");
        const file = writeProjectFile(root, "a.ts", "x");

        await stopAfter(file);

        assert.deepEqual(formatLog(), [], name);
        assert.equal(readFileSync(file, "utf8"), "x");
        rmSync(join(root, name));
      }
    });

    it("runs Biome when the formatter is only configured, not disabled", async () => {
      declare(root, ["@biomejs/biome"]);
      writeProjectFile(root, "biome.json", '{ "formatter": { "indentStyle": "space" } }');
      fakeFormatter("biome");

      await stopAfter(writeProjectFile(root, "a.ts", "x"));

      assert.equal(startsOf("biome").length, 1);
    });

    for (const [name, setUp] of [
      ["an oxfmt devDependency", () => declare(root, ["oxfmt"])],
      ["an oxfmt dependency", () => writeProjectFile(root, "package.json", JSON.stringify({ dependencies: { oxfmt: "0.75.0" } }))],
      [
        "an oxfmt devDependency and a .oxfmtrc.json file",
        () => {
          declare(root, ["oxfmt"]);
          writeProjectFile(root, ".oxfmtrc.json", "{}");
        },
      ],
      [
        "an oxfmt devDependency and an oxfmt.config.ts file",
        () => {
          declare(root, ["oxfmt"]);
          writeProjectFile(root, "oxfmt.config.ts", "export default {};");
        },
      ],
    ]) {
      it(`runs oxfmt in place from the bin project for ${name}`, async () => {
        setUp();
        fakeFormatter("oxfmt");
        const file = writeProjectFile(root, "src/a.ts", "x");

        await stopAfter(file);

        assert.deepEqual(startsOf("oxfmt"), [`start oxfmt CWD: ${root} ARGS: ${FORMAT_ARGS.oxfmt} ${file}`]);
      });
    }

    for (const [name, setUp] of [
      ["a .oxfmtrc.json file", () => writeProjectFile(root, ".oxfmtrc.json", "{}")],
      ["a .oxfmtrc.jsonc file", () => writeProjectFile(root, ".oxfmtrc.jsonc", "{}")],
      ["an oxfmt.config.ts file", () => writeProjectFile(root, "oxfmt.config.ts", "export default {};")],
    ]) {
      it(`does not run oxfmt for ${name} with a bin but no declaration`, async () => {
        setUp();
        fakeFormatter("oxfmt");
        const file = writeProjectFile(root, "src/a.ts", "x");

        assert.equal(await stopAfter(file), null);

        assert.deepEqual(formatLog(), []);
        assert.equal(readFileSync(file, "utf8"), "x");
      });
    }

    it("gives oxfmt the .vue files but leaves .svelte files to the other formatters", async () => {
      declare(root, ["oxfmt"]);
      fakeFormatter("oxfmt");
      const vue = writeProjectFile(root, "src/App.vue", "x");
      record(editInput(vue), { stateDir });
      record(editInput(writeProjectFile(root, "src/App.svelte", "x")), { stateDir });

      await check(stopInput({ cwd: root }), { stateDir });

      assert.deepEqual(startsOf("oxfmt"), [`start oxfmt CWD: ${root} ARGS: ${FORMAT_ARGS.oxfmt} ${vue}`]);
    });

    it("does not format files that are not scripts", async () => {
      declare(root, ["prettier"]);
      fakeFormatter("prettier");
      record(editInput(writeProjectFile(root, "src/a.ts", "x")), { stateDir });
      // Only a markdown file is recorded by hand.
      writeFileSync(statePaths(stopInput(), stateDir).filesPath, `${writeProjectFile(root, "README.md", "x")}\n`);

      assert.equal(await check(stopInput({ cwd: root }), { stateDir }), null);

      assert.deepEqual(formatLog(), []);
    });

    describe("one formatter per file, in the order oxfmt, Biome, Prettier", () => {
      const ALL_DEPENDENCIES = { prettier: "3.0.0", oxfmt: "0.75.0", "@biomejs/biome": "2.0.0" };

      // Replaces the project's declarations with `dependencies` and installs all three formatters.
      function declareFormatters(dependencies) {
        writeProjectFile(root, "package.json", JSON.stringify({ devDependencies: dependencies }));
        for (const name of ["prettier", "oxfmt", "biome"]) {
          fakeFormatter(name);
        }
      }

      it("runs only oxfmt when oxfmt, Biome and Prettier are all detected", async () => {
        declareFormatters(ALL_DEPENDENCIES);
        const file = writeProjectFile(root, "src/a.ts", "x");

        const result = await stopAfter(file);

        assert.equal(result, null);
        assert.deepEqual(startsOf("oxfmt"), [`start oxfmt CWD: ${root} ARGS: ${FORMAT_ARGS.oxfmt} ${file}`]);
        assert.deepEqual(startsOf("biome"), []);
        assert.deepEqual(startsOf("prettier"), []);
        assert.equal(readFileSync(file, "utf8"), "formatted-by-oxfmt");
      });

      it("falls back to Biome without oxfmt, and to Prettier with neither", async () => {
        declareFormatters({ prettier: "3.0.0", "@biomejs/biome": "2.0.0" });
        const file = writeProjectFile(root, "src/a.ts", "x");

        await stopAfter(file);

        assert.equal(readFileSync(file, "utf8"), "formatted-by-biome");
        assert.deepEqual(startsOf("prettier"), []);

        declareFormatters({ prettier: "3.0.0" });
        writeFileSync(file, "x");
        rmSync(logPath());

        await stopAfter(file);

        assert.equal(readFileSync(file, "utf8"), "formatted-by-prettier");
        assert.deepEqual(startsOf("biome"), []);
      });

      it("skips a higher-priority formatter that cannot handle the file or is turned off", async () => {
        declareFormatters(ALL_DEPENDENCIES);
        writeProjectFile(root, "biome.json", '{ "formatter": { "enabled": false } }');
        const vue = writeProjectFile(root, "src/a.vue", "x");
        const svelte = writeProjectFile(root, "src/b.svelte", "x");
        record(editInput(vue), { stateDir });

        await stopAfter(svelte);

        // oxfmt takes .vue; .svelte is not oxfmt's, and Biome is turned off, so Prettier gets it.
        assert.equal(readFileSync(vue, "utf8"), "formatted-by-oxfmt");
        assert.equal(readFileSync(svelte, "utf8"), "formatted-by-prettier");
        assert.deepEqual(startsOf("biome"), []);
      });
    });

    it("formats before lint, tsc and the tests look at the files", async () => {
      declare(root, ["prettier"]);
      writeProjectFile(root, "eslint.config.js");
      writeProjectFile(root, "tsconfig.json", "{}");
      declare(root, ["typescript", "eslint", "vitest"]);
      fakeFormatter("prettier");
      const file = writeProjectFile(root, "src/a.ts", "x");
      const sees = (message, exit) => `if grep -q formatted-by-prettier "${file}"; then echo "${message}"; exit ${exit}; fi\nexit 0`;
      fakeShell(root, "eslint", sees("eslint saw the formatted file", 1));
      fakeShell(root, "tsc", sees(`src/a.ts(1,1): error TS2322: tsc saw the formatted file`, 2));
      fakeShell(root, "vitest", sees("FAIL  src/a.test.ts > vitest saw the formatted file", 1));
      const env = { ...process.env, CLAUDE_HOOKS_SKIP_TESTS: "" };

      const result = await stopAfter(file, { env });

      assert.equal(result.decision, "block");
      assert.ok(result.reason.includes("eslint saw the formatted file"));
      assert.ok(result.reason.includes("tsc saw the formatted file"));
      assert.ok(result.reason.includes("vitest saw the formatted file"));
    });

    it("lists the changed files first in a block reason and asks to read them again", async () => {
      declare(root, ["prettier"]);
      writeProjectFile(root, "tsconfig.json", "{}");
      declare(root, ["typescript"]);
      fakeFormatter("prettier");
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });
      const changed = writeProjectFile(root, "src/a.ts", "x");
      const kept = writeProjectFile(root, "src/kept.ts", "formatted-by-prettier");
      record(editInput(changed), { stateDir });
      record(editInput(kept), { stateDir });

      const { reason } = await check(stopInput({ cwd: root }), { stateDir });

      assert.ok(reason.startsWith("[포맷]\n"));
      assert.ok(reason.includes("편집하기 전에 다시 읽는다."));
      assert.ok(reason.includes("- src/a.ts\n"));
      assert.ok(!reason.includes("kept.ts"));
      assert.ok(reason.indexOf("[포맷]") < reason.indexOf("[타입 검사]"));
    });

    it("does not mention a formatter that changed nothing", async () => {
      declare(root, ["prettier"]);
      writeProjectFile(root, "tsconfig.json", "{}");
      declare(root, ["typescript"]);
      fakeFormatter("prettier", { write: null });
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });

      const { reason } = await stopAfter(writeProjectFile(root, "src/a.ts", "x"));

      assert.ok(!reason.includes("[포맷]"));
    });

    it("puts the format lines first in additionalContext when a notice is sent", async () => {
      declare(root, ["prettier"]);
      writeProjectFile(root, "tsconfig.json", "{}");
      declare(root, ["typescript"]);
      fakeFormatter("prettier");
      fakeShell(root, "tsc", "sleep 5");

      const result = await stopAfter(writeProjectFile(root, "src/a.ts", "x"), { timeouts: { tsc: 1000 } });

      const context = result.hookSpecificOutput.additionalContext;
      assert.ok(context.startsWith("[포맷]\n"));
      assert.ok(context.endsWith("- tsc가 1초 안에 끝나지 않아 검증하지 못했다."));
    });

    it("puts the format lines first in a Handback deny", async () => {
      declare(root, ["prettier"]);
      writeProjectFile(root, "tsconfig.json", "{}");
      declare(root, ["typescript"]);
      fakeFormatter("prettier");
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });
      const agent = { agent_id: "agent-abc", agent_type: "worker" };
      record(editInput(writeProjectFile(root, "src/a.ts", "x"), agent), { stateDir });

      const result = await check(
        { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "SubagentHandback", cwd: root, ...agent },
        { stateDir },
      );

      const reason = result.hookSpecificOutput.permissionDecisionReason;
      assert.ok(reason.startsWith("[포맷]\n"));
      assert.ok(reason.includes("보고 전에 이번 변경으로 생긴 오류는 고친다."));
    });

    it("tells about a formatter that exits non-zero without blocking, once across blocks", async () => {
      declare(root, ["prettier"]);
      writeProjectFile(root, "tsconfig.json", "{}");
      declare(root, ["typescript"]);
      fakeFormatter("prettier", { exit: 2, write: null, output: "SyntaxError: boom" });
      const file = writeProjectFile(root, "src/a.ts", "x");

      const first = await stopAfter(file);
      assert.equal(first.decision, undefined);
      assert.match(first.hookSpecificOutput.additionalContext, /prettier가 결과를 내지 못하고 끝나 포맷하지 못했다: /);
      assert.match(first.hookSpecificOutput.additionalContext, /SyntaxError: boom/);

      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });
      const input = stopInput({ stop_hook_active: true, cwd: root });
      record(editInput(file), { stateDir });
      const second = await check(input, { stateDir });
      const third = await check(input, { stateDir });

      assert.ok(second.reason.includes("prettier가"));
      assert.ok(!third.reason.includes("prettier가"));
      assert.equal(readFileSync(statePaths(input, stateDir).notifiedPath, "utf8"), "format:prettier:tool\n");
    });

    it("tells about a formatter timeout without blocking and does not wait for it", async () => {
      declare(root, ["prettier"]);
      fakeFormatter("prettier", { sleep: 5 });
      const file = writeProjectFile(root, "src/a.ts", "x");

      const result = await stopAfter(file, { timeouts: { format: 1000 } });

      assert.deepEqual(result, {
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: "- prettier가 1초 안에 끝나지 않아 포맷하지 못했다.",
        },
      });
      assert.equal(readFileSync(file, "utf8"), "x");
    });

    it("tells about a formatter that cannot be spawned", async () => {
      declare(root, ["prettier"]);
      chmodSync(writeProjectFile(root, "node_modules/.bin/prettier", "#!/nonexistent/interpreter\n"), 0o755);

      const result = await stopAfter(writeProjectFile(root, "src/a.ts", "x"));

      assert.equal(result.decision, undefined);
      assert.match(result.hookSpecificOutput.additionalContext, /prettier를 실행하지 못해 포맷하지 못했다/);
    });

    it("says a formatter was not run when no time is left", async () => {
      declare(root, ["prettier"]);
      fakeFormatter("prettier");

      const result = await stopAfter(writeProjectFile(root, "src/a.ts", "x"), { timeouts: { total: 0 } });

      assert.equal(result.hookSpecificOutput.additionalContext, "- 남은 시간이 없어 prettier를 실행하지 못했다.");
      assert.deepEqual(formatLog(), []);
    });

    it("keeps the files recorded after a block so the next stop formats and checks them again", async () => {
      declare(root, ["prettier"]);
      writeProjectFile(root, "tsconfig.json", "{}");
      declare(root, ["typescript"]);
      fakeFormatter("prettier");
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });
      const file = writeProjectFile(root, "src/a.ts", "x");
      const input = stopInput({ stop_hook_active: true, cwd: root });
      record(editInput(file), { stateDir });

      await check(input, { stateDir });
      writeFileSync(file, "edited again");
      await check(input, { stateDir });

      assert.equal(startsOf("prettier").length, 2);
      assert.equal(readFileSync(file, "utf8"), "formatted-by-prettier");
    });
  });

  describe("check-on-stop", () => {
    const TSC_OUTPUT = [
      "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  Detail line for a.",
      "src/other.ts(1,1): error TS1005: ';' expected.",
    ].join("\n");

    function setup({ tscOutput = TSC_OUTPUT, tscExit = 2 } = {}) {
      writeProjectFile(root, "tsconfig.json", "{}");
      declare(root, ["typescript"]);
      fakeBin(root, "tsc", { exit: tscExit, output: tscOutput });
      const edited = writeProjectFile(root, "src/a.ts", "x");
      writeProjectFile(root, "src/other.ts", "x");
      record(editInput(edited), { stateDir });
      return edited;
    }

    it("parses diagnostics and folds continuation lines", async () => {
      const parsed = parseDiagnostics(TSC_OUTPUT, root);
      assert.equal(parsed.length, 2);
      assert.equal(parsed[0].file, join(root, "src", "a.ts"));
      assert.equal(parsed[0].code, "TS2322");
      assert.match(parsed[0].message, /Detail line for a\./);
    });

    it("blocks with only the diagnostics of edited files", async () => {
      setup();

      const result = await check(stopInput({ cwd: root }), { stateDir });

      assert.equal(result.decision, "block");
      assert.ok(result.reason.includes("src/a.ts"));
      assert.ok(result.reason.includes("TS2322"));
      assert.ok(result.reason.includes("Detail line for a."));
      assert.ok(!result.reason.includes("TS1005"));
      assert.ok(existsSync(statePaths(stopInput(), stateDir).filesPath));
    });

    it("uses the nearest tsconfig and resolves diagnostic paths against its directory", async () => {
      declare(root, ["typescript"]);
      writeProjectFile(root, "packages/app/tsconfig.json", "{}");
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(2,2): error TS2304: nested" });
      const file = writeProjectFile(root, "packages/app/src/a.ts", "x");
      record(editInput(file), { stateDir });

      const result = await check(stopInput({ cwd: root }), { stateDir });

      assert.equal(result.decision, "block");
      assert.ok(result.reason.includes("packages/app/src/a.ts"));
    });

    it("passes and clears state when edited files have no diagnostics", async () => {
      setup({ tscOutput: "src/other.ts(1,1): error TS1005: ';' expected." });

      assert.equal(await check(stopInput({ cwd: root }), { stateDir }), null);
      assert.equal(existsSync(statePaths(stopInput(), stateDir).filesPath), false);
    });

    it("does not block when tsc fails without parseable diagnostics, and says so once", async () => {
      setup({ tscOutput: "error TS5083: Cannot read file tsconfig.json." });

      const result = await check(stopInput({ cwd: root }), { stateDir });

      assert.equal(result.decision, undefined);
      assert.equal(result.hookSpecificOutput.hookEventName, "Stop");
      assert.ok(result.hookSpecificOutput.additionalContext.includes("TS5083"));
      assert.ok(result.hookSpecificOutput.additionalContext.includes("검증하지 못했다"));
      assert.ok(!result.hookSpecificOutput.additionalContext.includes("보고에 남겨라"));
    });

    it("passes when nothing was edited", async () => {
      assert.equal(await check(stopInput(), { stateDir }), null);
    });

    it("passes when typescript is declared but the project has no tsc", async () => {
      writeProjectFile(root, "tsconfig.json", "{}");
      declare(root, ["typescript"]);
      const file = writeProjectFile(root, "src/a.ts", "x");
      record(editInput(file), { stateDir });
      assert.equal(await check(stopInput({ cwd: root }), { stateDir }), null);
    });

    it("passes without running tsc when typescript is not declared, even with a tsconfig and a tsc bin", async () => {
      const log = join(stateDir, "tsc.log");
      writeProjectFile(root, "tsconfig.json", "{}");
      fakeShell(root, "tsc", `echo run >> "${log}"\necho "src/a.ts(3,5): error TS2322: bad"\nexit 2`);
      record(editInput(writeProjectFile(root, "src/a.ts", "x")), { stateDir });

      assert.equal(await check(stopInput({ cwd: root }), { stateDir }), null);
      assert.equal(existsSync(log), false);
    });

    it("passes when only another package is declared, or typescript only in scripts or peerDependencies", async () => {
      writeProjectFile(root, "tsconfig.json", "{}");
      writeProjectFile(
        root,
        "package.json",
        JSON.stringify({
          devDependencies: { vitest: "1.0.0" },
          scripts: { typecheck: "tsc --noEmit" },
          peerDependencies: { typescript: "5.0.0" },
        }),
      );
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });
      record(editInput(writeProjectFile(root, "src/a.ts", "x")), { stateDir });

      assert.equal(await check(stopInput({ cwd: root }), { stateDir }), null);
    });

    it("runs tsc when typescript is declared in dependencies", async () => {
      writeProjectFile(root, "tsconfig.json", "{}");
      writeProjectFile(root, "package.json", JSON.stringify({ dependencies: { typescript: "5.0.0" } }));
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });
      record(editInput(writeProjectFile(root, "src/a.ts", "x")), { stateDir });

      assert.equal((await check(stopInput({ cwd: root }), { stateDir })).decision, "block");
    });

    it("runs tsc for a subpackage tsconfig when only the root package.json declares typescript", async () => {
      declare(root, ["typescript"]);
      writeProjectFile(root, "packages/app/tsconfig.json", "{}");
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(2,2): error TS2304: nested" });
      record(editInput(writeProjectFile(root, "packages/app/src/a.ts", "x")), { stateDir });

      const result = await check(stopInput({ cwd: root }), { stateDir });

      assert.equal(result.decision, "block");
      assert.ok(result.reason.includes("packages/app/src/a.ts"));
    });

    it("uses the root's typescript declaration when the subpackage's package.json declares other packages only", async () => {
      declare(root, ["typescript"]);
      declare(root, ["vitest"], "packages/app");
      writeProjectFile(root, "packages/app/tsconfig.json", "{}");
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(2,2): error TS2304: nested" });
      record(editInput(writeProjectFile(root, "packages/app/src/a.ts", "x")), { stateDir });

      assert.equal((await check(stopInput({ cwd: root }), { stateDir })).decision, "block");
    });

    it("does not use a typescript declaration above the .git boundary", async () => {
      const outer = realpathSync(mkdtempSync(join(tmpdir(), "hooks-outer-")));
      try {
        declare(outer, ["typescript"]);
        const inner = join(outer, "project");
        mkdirSync(join(inner, ".git"), { recursive: true });
        writeProjectFile(inner, "tsconfig.json", "{}");
        fakeBin(inner, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });
        record(editInput(writeProjectFile(inner, "src/a.ts", "x")), { stateDir });

        assert.equal(await check(stopInput({ cwd: inner }), { stateDir }), null);
      } finally {
        rmSync(outer, { recursive: true, force: true });
      }
    });

    it("passes when there is no tsconfig", async () => {
      declare(root, ["typescript"]);
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(1,1): error TS1005: x" });
      const file = writeProjectFile(root, "src/a.ts", "x");
      record(editInput(file), { stateDir });
      assert.equal(await check(stopInput({ cwd: root }), { stateDir }), null);
    });

    it("keeps state per agent: a subagent stop ignores main's files", async () => {
      setup();
      assert.equal(await check(stopInput({ hook_event_name: "SubagentStop", agent_id: "agent-zzz" }), { stateDir }), null);
      assert.equal((await check(stopInput({ cwd: root }), { stateDir })).decision, "block");
    });

    it("matches subagent edits and stops through the normalized agent id", async () => {
      writeProjectFile(root, "tsconfig.json", "{}");
      declare(root, ["typescript"]);
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });
      const file = writeProjectFile(root, "src/a.ts", "x");
      record(editInput(file, { agent_id: "agent-abc" }), { stateDir });

      const result = await check(stopInput({ hook_event_name: "SubagentStop", agent_id: "abc", cwd: root }), { stateDir });
      assert.equal(result.decision, "block");
    });

    it("gives up after three blocks and clears state", async () => {
      setup();
      const input = stopInput({ stop_hook_active: true, cwd: root });

      // Different diagnostics each time, so only the block limit can end it.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        fakeBin(root, "tsc", { exit: 2, output: `src/a.ts(${attempt + 1},1): error TS2322: attempt ${attempt}` });
        const result = await check(input, { stateDir });
        assert.equal(result.decision, "block");
        assert.equal(result.reason.includes("이번이 마지막 확인이다. 고치지 못하면 원인을 보고에 남겨라."), attempt === 2);
        assert.equal(readFileSync(statePaths(input, stateDir).typecheckBlocksPath, "utf8"), String(attempt + 1));
      }
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(9,1): error TS2322: attempt 3" });
      assert.equal(await check(input, { stateDir }), null);
      assert.equal(existsSync(statePaths(input, stateDir).filesPath), false);
      assert.equal(existsSync(statePaths(input, stateDir).typecheckBlocksPath), false);
    });

    it("tells Claude to leave pre-existing errors out of scope", async () => {
      setup();

      const { reason } = await check(stopInput({ cwd: root }), { stateDir });

      assert.ok(reason.includes("이번 변경으로 생긴 오류는 고친다."));
      assert.ok(reason.includes("원래 있던 오류는 작업 범위 밖이면 고치지 말고 보고에 남긴다."));
    });

    it("keeps blocking on the same diagnostics up to three times, then passes and clears state", async () => {
      setup();
      const input = stopInput({ stop_hook_active: true, cwd: root });
      const paths = statePaths(input, stateDir);

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        assert.equal((await check(input, { stateDir })).decision, "block");
        assert.equal(readFileSync(paths.typecheckBlocksPath, "utf8"), String(attempt));
      }

      assert.equal(await check(input, { stateDir }), null);
      assert.equal(existsSync(paths.filesPath), false);
      assert.equal(existsSync(paths.typecheckBlocksPath), false);
      assert.equal(existsSync(paths.lintBlocksPath), false);
      assert.equal(existsSync(paths.testBlocksPath), false);
      assert.equal(existsSync(paths.notifiedPath), false);
    });

    it("tells Claude on the third block that this is the last check", async () => {
      setup();
      const input = stopInput({ stop_hook_active: true, cwd: root });

      const first = await check(input, { stateDir });
      const second = await check(input, { stateDir });
      const third = await check(input, { stateDir });

      assert.ok(!first.reason.includes("이번이 마지막 확인이다."));
      assert.ok(!second.reason.includes("이번이 마지막 확인이다."));
      assert.ok(third.reason.includes("이번이 마지막 확인이다. 고치지 못하면 원인을 보고에 남겨라."));
    });

    it("deletes state files of the earlier format when it clears state", async () => {
      setup();
      const input = stopInput({ cwd: root });
      const paths = statePaths(input, stateDir);
      writeFileSync(paths.legacyBlocksPath, "2");
      writeFileSync(paths.legacyLastPath, "abc");
      fakeBin(root, "tsc", { exit: 0 });

      assert.equal(await check(input, { stateDir }), null);
      assert.equal(existsSync(paths.legacyBlocksPath), false);
      assert.equal(existsSync(paths.legacyLastPath), false);
    });

    it("blocks again when the diagnostics change between stops", async () => {
      setup();
      const input = stopInput({ stop_hook_active: true, cwd: root });

      assert.equal((await check(input, { stateDir })).decision, "block");
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: a different message" });
      assert.equal((await check(input, { stateDir })).decision, "block");
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(4,5): error TS2322: a different message" });
      assert.equal((await check(input, { stateDir })).decision, "block");
    });

    describe("before the final report (PreToolUse on SubagentHandback)", () => {
      const AGENT = { agent_id: "agent-abc", agent_type: "worker" };
      const handbackInput = (extra = {}) => ({
        session_id: "s1",
        hook_event_name: "PreToolUse",
        tool_name: "SubagentHandback",
        tool_input: { message: "done" },
        ...AGENT,
        cwd: root,
        ...extra,
      });
      const subagentStop = (extra = {}) => stopInput({ hook_event_name: "SubagentStop", ...AGENT, cwd: root, ...extra });

      function setupSubagent() {
        writeProjectFile(root, "tsconfig.json", "{}");
        declare(root, ["typescript"]);
        fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });
        record(editInput(writeProjectFile(root, "src/a.ts", "x"), AGENT), { stateDir });
      }

      it("denies with the PreToolUse output format and a before-report reason", async () => {
        setupSubagent();

        const result = await check(handbackInput(), { stateDir });

        assert.deepEqual(Object.keys(result), ["hookSpecificOutput"]);
        assert.equal(result.hookSpecificOutput.hookEventName, "PreToolUse");
        assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
        const reason = result.hookSpecificOutput.permissionDecisionReason;
        assert.ok(reason.includes("TS2322"));
        assert.ok(reason.includes("보고 전에 이번 변경으로 생긴 오류는 고친다."));
        assert.ok(reason.includes("원래 있던 오류는 작업 범위 밖이면 고치지 말고 보고에 남긴다."));
      });

      it("keeps the Stop and SubagentStop output as decision block", async () => {
        setupSubagent();

        const result = await check(subagentStop(), { stateDir });

        assert.equal(result.decision, "block");
        assert.equal(result.hookSpecificOutput, undefined);
      });

      it("does nothing for other tools", async () => {
        setupSubagent();
        assert.equal(await check(handbackInput({ tool_name: "Bash" }), { stateDir }), null);
        assert.equal(await check(handbackInput({ tool_name: "Read" }), { stateDir }), null);
        // and does not consume the block count
        assert.equal(existsSync(statePaths(handbackInput(), stateDir).typecheckBlocksPath), false);
      });

      it("passes the report and the later SubagentStop when there are no diagnostics", async () => {
        writeProjectFile(root, "tsconfig.json", "{}");
        declare(root, ["typescript"]);
        fakeBin(root, "tsc", { exit: 0 });
        record(editInput(writeProjectFile(root, "src/a.ts", "x"), AGENT), { stateDir });

        assert.equal(await check(handbackInput(), { stateDir }), null);
        assert.equal(existsSync(statePaths(handbackInput(), stateDir).filesPath), false);
        assert.equal(await check(subagentStop(), { stateDir }), null);
      });

      it("allows the report after the errors are fixed, and the SubagentStop after it", async () => {
        setupSubagent();
        assert.equal((await check(handbackInput(), { stateDir })).hookSpecificOutput.permissionDecision, "deny");

        fakeBin(root, "tsc", { exit: 0 });
        assert.equal(await check(handbackInput(), { stateDir }), null);
        assert.equal(await check(subagentStop(), { stateDir }), null);
      });

      it("denies the report again when the same diagnostics repeat", async () => {
        setupSubagent();

        assert.equal((await check(handbackInput(), { stateDir })).hookSpecificOutput.permissionDecision, "deny");
        assert.equal((await check(handbackInput(), { stateDir })).hookSpecificOutput.permissionDecision, "deny");
      });

      it("shares the three-block limit with Stop and SubagentStop", async () => {
        setupSubagent();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          fakeBin(root, "tsc", { exit: 2, output: `src/a.ts(${attempt + 1},1): error TS2322: attempt ${attempt}` });
          assert.ok(await check(attempt % 2 === 0 ? handbackInput() : subagentStop(), { stateDir }) !== null);
        }
        fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(9,1): error TS2322: attempt 3" });
        assert.equal(await check(handbackInput(), { stateDir }), null);
      });

      it("denies a Handback with a text-only notice once, then lets the report through", async () => {
        writeProjectFile(root, "tsconfig.json", "{}");
        declare(root, ["typescript"]);
        chmodSync(writeProjectFile(root, "node_modules/.bin/tsc", "#!/bin/sh\nsleep 5\n"), 0o755);
        record(editInput(writeProjectFile(root, "src/a.ts", "x"), AGENT), { stateDir });
        const options = { stateDir, timeouts: { tsc: 1000 } };

        const first = await check(handbackInput(), options);

        assert.equal(first.hookSpecificOutput.hookEventName, "PreToolUse");
        assert.equal(first.hookSpecificOutput.permissionDecision, "deny");
        assert.equal(
          first.hookSpecificOutput.permissionDecisionReason,
          "다음 항목을 검증하지 못했다. 보고에 남기고 SubagentHandback을 다시 호출하라\n- tsc가 1초 안에 끝나지 않아 검증하지 못했다.",
        );
        assert.equal(await check(handbackInput(), options), null);
        assert.equal(await check(subagentStop(), options), null);
      });
    });

    describe("with related tests, notices and parallel runs", () => {
      const TEST_FAIL = "FAIL  src/a.test.ts > adds";

      // Script run by `sh`; `body` is its text after the shebang.
      function fakeScript(name, body) {
        chmodSync(writeProjectFile(root, `node_modules/.bin/${name}`, `#!/bin/sh\n${body}\n`), 0o755);
      }

      function fakeVitest({ exit = 1, output = TEST_FAIL } = {}) {
        fakeBin(root, "vitest", { exit, output });
      }

      // A TS project whose edited file src/a.ts has a type error, with vitest configured.
      function setupBoth({ tscExit = 2, edited = "src/a.ts", agent = {} } = {}) {
        declare(root, ["vitest"]);
        writeProjectFile(root, "tsconfig.json", "{}");
        declare(root, ["typescript"]);
        fakeBin(root, "tsc", { exit: tscExit, output: "src/a.ts(3,5): error TS2322: bad" });
        fakeVitest();
        const file = writeProjectFile(root, edited, "x");
        record(editInput(file, agent), { stateDir });
        return file;
      }

      const envWith = (extra = {}) => {
        const { CLAUDE_HOOKS_SKIP_TESTS: _skip, ...rest } = process.env;
        return { ...rest, ...extra };
      };

      it("reports type errors and test failures in one reason with a section each", async () => {
        setupBoth();
        const input = stopInput({ cwd: root });
        const paths = statePaths(input, stateDir);

        const result = await check(input, { stateDir, env: envWith() });

        assert.equal(result.decision, "block");
        assert.ok(result.reason.includes("[타입 검사]"));
        assert.ok(result.reason.includes("TS2322"));
        assert.ok(result.reason.includes("[테스트]"));
        assert.ok(result.reason.includes(TEST_FAIL));
        assert.ok(result.reason.includes("테스트를 통과시키려고 기대값을 바꾸지 않는다. 테스트가 틀렸다고 판단하면 근거를 보고에 남긴다."));
        assert.ok(result.reason.indexOf("[타입 검사]") < result.reason.indexOf("[테스트]"));
        assert.equal(readFileSync(paths.typecheckBlocksPath, "utf8"), "1");
        assert.equal(readFileSync(paths.testBlocksPath, "utf8"), "1");
      });

      it("blocks on test failures alone", async () => {
        setupBoth({ tscExit: 0 });

        const result = await check(stopInput({ cwd: root }), { stateDir, env: envWith() });

        assert.equal(result.decision, "block");
        assert.ok(result.reason.includes("[테스트]"));
        assert.ok(!result.reason.includes("[타입 검사]"));
      });

      it("runs typecheck and tests at the same time", async () => {
        declare(root, ["vitest"]);
        writeProjectFile(root, "tsconfig.json", "{}");
        declare(root, ["typescript"]);
        const marks = join(stateDir, "marks");
        mkdirSync(marks, { recursive: true });
        // Each tool announces itself, then waits (at most 5s) for the other. Run one after the other,
        // the first one would time out waiting and report nothing.
        const rendezvous = (self, other, onSuccess) =>
          [
            `touch "${marks}/${self}"`,
            "i=0",
            `while [ ! -f "${marks}/${other}" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done`,
            `if [ -f "${marks}/${other}" ]; then ${onSuccess}; fi`,
            "exit 0",
          ].join("\n");
        fakeScript("tsc", rendezvous("tsc", "vitest", `echo "src/a.ts(3,5): error TS2322: bad"; exit 2`));
        fakeScript("vitest", rendezvous("vitest", "tsc", `echo "${TEST_FAIL}"; exit 1`));
        record(editInput(writeProjectFile(root, "src/a.ts", "x")), { stateDir });

        const result = await check(stopInput({ cwd: root }), { stateDir, env: envWith() });

        assert.equal(result.decision, "block");
        assert.ok(result.reason.includes("TS2322"));
        assert.ok(result.reason.includes(TEST_FAIL));
      });

      it("counts blocks per kind: tests still block after typecheck reached its limit", async () => {
        setupBoth({ tscExit: 2 });
        fakeVitest({ exit: 0, output: "ok" });
        const input = stopInput({ stop_hook_active: true, cwd: root });
        const paths = statePaths(input, stateDir);

        for (let attempt = 1; attempt <= 3; attempt += 1) {
          assert.equal((await check(input, { stateDir, env: envWith() })).decision, "block");
        }
        assert.equal(readFileSync(paths.typecheckBlocksPath, "utf8"), "3");
        assert.equal(existsSync(paths.testBlocksPath), false);

        fakeVitest();
        const result = await check(input, { stateDir, env: envWith() });

        assert.equal(result.decision, "block");
        assert.ok(result.reason.includes("[테스트]"));
        assert.ok(!result.reason.includes("[타입 검사]"));
        assert.equal(readFileSync(paths.typecheckBlocksPath, "utf8"), "3");
        assert.equal(readFileSync(paths.testBlocksPath, "utf8"), "1");
      });

      it("does not run a kind that reached its limit", async () => {
        setupBoth({ tscExit: 0 });
        const log = join(stateDir, "vitest.log");
        fakeScript("vitest", `echo run >> "${log}"\necho "${TEST_FAIL}"\nexit 1`);
        const input = stopInput({ stop_hook_active: true, cwd: root });

        for (let attempt = 1; attempt <= 3; attempt += 1) {
          assert.equal((await check(input, { stateDir, env: envWith() })).decision, "block");
        }
        assert.equal(await check(input, { stateDir, env: envWith() }), null);

        assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3);
      });

      it("sends a timeout as additionalContext with the SubagentStop event name, once", async () => {
        writeProjectFile(root, "tsconfig.json", "{}");
        declare(root, ["typescript"]);
        fakeScript("tsc", "sleep 5");
        const agent = { agent_id: "agent-abc", agent_type: "worker" };
        record(editInput(writeProjectFile(root, "src/a.ts", "x"), agent), { stateDir });
        const input = stopInput({ hook_event_name: "SubagentStop", ...agent, cwd: root });

        const result = await check(input, { stateDir, timeouts: { tsc: 1000 } });

        assert.deepEqual(result, {
          hookSpecificOutput: {
            hookEventName: "SubagentStop",
            additionalContext: "- tsc가 1초 안에 끝나지 않아 검증하지 못했다.",
          },
        });
        assert.equal(await check(input, { stateDir, timeouts: { tsc: 1000 } }), null);
      });

      it("uses the Stop event name for Stop notices", async () => {
        writeProjectFile(root, "tsconfig.json", "{}");
        declare(root, ["typescript"]);
        fakeScript("tsc", "sleep 5");
        record(editInput(writeProjectFile(root, "src/a.ts", "x")), { stateDir });

        const result = await check(stopInput({ cwd: root }), { stateDir, timeouts: { tsc: 500 } });

        assert.equal(result.hookSpecificOutput.hookEventName, "Stop");
        assert.equal(result.decision, undefined);
      });

      it("does not block on a spawn failure and reports it", async () => {
        writeProjectFile(root, "tsconfig.json", "{}");
        declare(root, ["typescript"]);
        // Executable bit set but the interpreter does not exist: spawn fails.
        chmodSync(writeProjectFile(root, "node_modules/.bin/tsc", "#!/nonexistent/interpreter\n"), 0o755);
        record(editInput(writeProjectFile(root, "src/a.ts", "x")), { stateDir });

        const result = await check(stopInput({ cwd: root }), { stateDir });

        assert.equal(result.decision, undefined);
        assert.match(result.hookSpecificOutput.additionalContext, /tsc/);
        assert.match(result.hookSpecificOutput.additionalContext, /검증하지 못했다/);
        assert.ok(!result.hookSpecificOutput.additionalContext.includes("보고에 남겨라"));
      });

      it("appends a notice to a block and does not repeat it on the next block", async () => {
        setupBoth({ tscExit: 2 });
        fakeScript("vitest", "sleep 5");
        const input = stopInput({ stop_hook_active: true, cwd: root });
        const options = { stateDir, env: envWith(), timeouts: { test: 1000 } };

        const first = await check(input, options);
        const second = await check(input, options);

        assert.equal(first.decision, "block");
        assert.ok(first.reason.includes("[타입 검사]"));
        assert.ok(first.reason.endsWith("- vitest가 1초 안에 끝나지 않아 검증하지 못했다."));
        assert.equal(second.decision, "block");
        assert.ok(!second.reason.includes("vitest가"));
        assert.equal(readFileSync(statePaths(input, stateDir).notifiedPath, "utf8"), "test:vitest:timeout\n");
      });

      it("skips only the tests when CLAUDE_HOOKS_SKIP_TESTS is 1", async () => {
        setupBoth({ tscExit: 0 });
        const skip = envWith({ CLAUDE_HOOKS_SKIP_TESTS: "1" });
        assert.equal(await check(stopInput({ cwd: root }), { stateDir, env: skip }), null);

        record(editInput(join(root, "src/a.ts")), { stateDir });
        fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });
        const result = await check(stopInput({ cwd: root }), { stateDir, env: skip });

        assert.ok(result.reason.includes("[타입 검사]"));
        assert.ok(!result.reason.includes("[테스트]"));
      });

      it("typechecks edited JS files; no diagnostics for them means no block", async () => {
        declare(root, ["vitest"]);
        writeProjectFile(root, "tsconfig.json", "{}");
        declare(root, ["typescript"]);
        const log = join(stateDir, "tsc.log");
        fakeScript("tsc", `echo run >> "${log}"\nexit 0`);
        fakeVitest();
        record(editInput(writeProjectFile(root, "src/a.js", "x")), { stateDir });

        const result = await check(stopInput({ cwd: root }), { stateDir, env: envWith() });

        assert.ok(result.reason.includes("[테스트]"));
        assert.ok(!result.reason.includes("[타입 검사]"));
        assert.equal(existsSync(log), true);
      });

      it("blocks a .vue edit on vitest failures and does not run tsc for it", async () => {
        declare(root, ["vitest"]);
        writeProjectFile(root, "tsconfig.json", "{}");
        declare(root, ["typescript"]);
        const log = join(stateDir, "tsc.log");
        fakeScript("tsc", `echo run >> "${log}"\nexit 0`);
        fakeVitest();
        record(editInput(writeProjectFile(root, "src/App.vue", "x")), { stateDir });

        const result = await check(stopInput({ cwd: root }), { stateDir, env: envWith() });

        assert.equal(result.decision, "block");
        assert.ok(result.reason.includes("[테스트]"));
        assert.ok(result.reason.includes("ARGS: related --run --passWithNoTests src/App.vue"));
        assert.ok(!result.reason.includes("[타입 검사]"));
        assert.equal(existsSync(log), false);
      });

      it("blocks on a diagnostic in an edited JS file", async () => {
        writeProjectFile(root, "tsconfig.json", "{}");
        declare(root, ["typescript"]);
        fakeBin(root, "tsc", { exit: 2, output: "src/a.js(3,5): error TS2322: bad js" });
        record(editInput(writeProjectFile(root, "src/a.js", "x")), { stateDir });

        const result = await check(stopInput({ cwd: root }), { stateDir, env: envWith() });

        assert.equal(result.decision, "block");
        assert.ok(result.reason.includes("[타입 검사]"));
        assert.ok(result.reason.includes("src/a.js"));
        assert.ok(result.reason.includes("TS2322: bad js"));
      });

      const NO_BLOCK_FOR_JS = [
        ["diagnostics only in another file", 2, "src/other.js(1,1): error TS2322: elsewhere"],
        ["tsc exits with 0", 0, ""],
        ["only TS18003 is reported", 1, "error TS18003: No inputs were found in config file '/p/tsconfig.json'."],
        ["TS18003 is reported with a location", 1, "tsconfig.json(1,1): error TS18003: No inputs were found."],
      ];
      for (const [name, exit, output] of NO_BLOCK_FOR_JS) {
        it(`passes an edited JS file and clears state when ${name}`, async () => {
          writeProjectFile(root, "tsconfig.json", "{}");
          declare(root, ["typescript"]);
          fakeBin(root, "tsc", { exit, output });
          writeProjectFile(root, "src/other.js", "x");
          record(editInput(writeProjectFile(root, "src/a.js", "x")), { stateDir });

          assert.equal(await check(stopInput({ cwd: root }), { stateDir, env: envWith() }), null);
          assert.equal(existsSync(statePaths(stopInput(), stateDir).filesPath), false);
        });
      }

      it("still reports a TS18003 mixed with another tool error as a notice", async () => {
        writeProjectFile(root, "tsconfig.json", "{}");
        declare(root, ["typescript"]);
        fakeBin(root, "tsc", { exit: 1, output: "error TS18003: No inputs.\nerror TS5083: Cannot read file." });
        record(editInput(writeProjectFile(root, "src/a.js", "x")), { stateDir });

        const result = await check(stopInput({ cwd: root }), { stateDir, env: envWith() });

        assert.match(result.hookSpecificOutput.additionalContext, /TS5083/);
      });

      it("finds the nearest tsconfig of an edited nested JS file", async () => {
        writeProjectFile(root, "tsconfig.json", "{}");
        declare(root, ["typescript"]);
        writeProjectFile(root, "packages/app/tsconfig.json", "{}");
        const log = join(stateDir, "tsc-args.log");
        fakeScript("tsc", `echo "$*" >> "${log}"\nexit 0`);
        record(editInput(writeProjectFile(root, "packages/app/src/a.js", "x")), { stateDir });

        assert.equal(await check(stopInput({ cwd: root }), { stateDir, env: envWith() }), null);

        const calls = readFileSync(log, "utf8").trim().split("\n");
        assert.equal(calls.length, 1);
        assert.ok(calls[0].includes(`-p ${join(root, "packages/app/tsconfig.json")}`));
      });

      describe("notices as facts", () => {
        it("says tsc was not run when no time is left, without seconds", async () => {
          writeProjectFile(root, "tsconfig.json", "{}");
          declare(root, ["typescript"]);
          fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });
          record(editInput(writeProjectFile(root, "src/a.ts", "x")), { stateDir });

          const result = await check(stopInput({ cwd: root }), {
            stateDir,
            env: envWith(),
            timeouts: { total: 0 },
          });

          assert.deepEqual(result, {
            hookSpecificOutput: {
              hookEventName: "Stop",
              additionalContext: "- 남은 시간이 없어 tsc를 실행하지 못했다.",
            },
          });
        });

        it("says vitest was not run when no time is left, without seconds", async () => {
          setupBoth();

          const result = await check(stopInput({ cwd: root }), {
            stateDir,
            env: envWith(),
            timeouts: { total: 0 },
          });

          const context = result.hookSpecificOutput.additionalContext;
          assert.ok(context.includes("- 남은 시간이 없어 tsc를 실행하지 못했다."));
          assert.ok(context.includes("- 남은 시간이 없어 vitest를 실행하지 못했다."));
          assert.ok(!context.includes("0초"));
          assert.ok(!context.includes("280초"));
          assert.ok(!context.includes("보고에 남겨라"));
        });

        it("rounds a timeout to whole seconds for tsc and for tests", async () => {
          declare(root, ["vitest"]);
          writeProjectFile(root, "tsconfig.json", "{}");
          declare(root, ["typescript"]);
          fakeScript("tsc", "sleep 5");
          fakeScript("vitest", "sleep 5");
          record(editInput(writeProjectFile(root, "src/a.ts", "x")), { stateDir });

          const result = await check(stopInput({ cwd: root }), {
            stateDir,
            env: envWith(),
            timeouts: { tsc: 1400, test: 1600 },
          });

          assert.equal(
            result.hookSpecificOutput.additionalContext,
            "- tsc가 1초 안에 끝나지 않아 검증하지 못했다.\n- vitest가 2초 안에 끝나지 않아 검증하지 못했다.",
          );
        });

        it("introduces the not-verified section of a block with a statement", async () => {
          setupBoth({ tscExit: 2 });
          fakeScript("vitest", "sleep 5");

          const result = await check(stopInput({ stop_hook_active: true, cwd: root }), {
            stateDir,
            env: envWith(),
            timeouts: { test: 1000 },
          });

          assert.ok(
            result.reason.endsWith(
              "[검증하지 못한 항목]\n다음 항목은 검증하지 못했다. 보고에 남긴다.\n- vitest가 1초 안에 끝나지 않아 검증하지 못했다.",
            ),
          );
        });
      });

      it("does not run vitest for a bin and a test script without a declaration", async () => {
        writeProjectFile(root, "package.json", JSON.stringify({ scripts: { test: "vitest" } }));
        fakeVitest();
        record(editInput(writeProjectFile(root, "src/a.ts", "x")), { stateDir });

        assert.equal(await check(stopInput({ cwd: root }), { stateDir, env: envWith() }), null);
      });

      it("does not run tests for files that are not scripts", async () => {
        declare(root, ["vitest"]);
        fakeVitest();
        const file = writeProjectFile(root, "src/a.ts", "x");
        record(editInput(file), { stateDir });
        // Only a markdown file is recorded by hand.
        const paths = statePaths(stopInput(), stateDir);
        writeFileSync(paths.filesPath, `${writeProjectFile(root, "README.md", "x")}\n`);

        assert.equal(await check(stopInput({ cwd: root }), { stateDir, env: envWith() }), null);
      });
    });

    describe("solution-style tsconfig", () => {
      const solution = (references) => JSON.stringify({ files: [], references });

      it("also checks referenced projects, given as directories or files", async () => {
        writeProjectFile(root, "tsconfig.json", solution([{ path: "./app" }, { path: "./tsconfig.node.json" }]));
        declare(root, ["typescript"]);
        writeProjectFile(root, "app/tsconfig.json", "{}");
        writeProjectFile(root, "tsconfig.node.json", "{}");
        // Reports an error only when run for the app project.
        const script = `#!/bin/sh\ncase "$*" in *app/tsconfig.json*) echo "src/a.ts(2,3): error TS2304: in app";; esac\nexit 2\n`;
        const bin = writeProjectFile(root, "node_modules/.bin/tsc", script);
        chmodSync(bin, 0o755);
        const file = writeProjectFile(root, "app/src/a.ts", "x");
        record(editInput(file), { stateDir });

        const result = await check(stopInput({ cwd: root }), { stateDir });

        assert.equal(result.decision, "block");
        assert.ok(result.reason.includes("TS2304: in app"));
      });

      it("runs tsc for the root and every referenced project, once each", async () => {
        writeProjectFile(root, "tsconfig.json", solution([{ path: "./a" }, { path: "./b/tsconfig.json" }]));
        declare(root, ["typescript"]);
        writeProjectFile(root, "a/tsconfig.json", solution([{ path: "../b" }]));
        writeProjectFile(root, "b/tsconfig.json", "{}");
        const log = join(stateDir, "tsc.log");
        const script = `#!/bin/sh\necho "$*" >> "${log}"\nexit 0\n`;
        chmodSync(writeProjectFile(root, "node_modules/.bin/tsc", script), 0o755);
        record(editInput(writeProjectFile(root, "a/src/x.ts", "x")), { stateDir });
        writeProjectFile(root, "src/y.ts", "x");
        record(editInput(join(root, "src/y.ts")), { stateDir });

        await check(stopInput({ cwd: root }), { stateDir });

        const runs = readFileSync(log, "utf8").trim().split("\n");
        const projects = runs.map((line) => line.split("-p ")[1]).sort();
        assert.deepEqual(projects, [
          join(root, "a/tsconfig.json"),
          join(root, "b/tsconfig.json"),
          join(root, "tsconfig.json"),
        ]);
      });

      it("deduplicates a diagnostic reported by several projects", async () => {
        writeProjectFile(root, "tsconfig.json", solution([{ path: "./a" }, { path: "./b" }]));
        declare(root, ["typescript"]);
        writeProjectFile(root, "a/tsconfig.json", "{}");
        writeProjectFile(root, "b/tsconfig.json", "{}");
        fakeBin(root, "tsc", { exit: 2, output: "src/x.ts(1,1): error TS2304: shared" });
        const file = writeProjectFile(root, "src/x.ts", "x");
        record(editInput(file), { stateDir });

        const { reason } = await check(stopInput({ cwd: root }), { stateDir });

        assert.equal(reason.split("TS2304: shared").length, 2);
      });

      it("ignores TS6305 (referenced project not built)", async () => {
        writeProjectFile(root, "tsconfig.json", "{}");
        declare(root, ["typescript"]);
        fakeBin(root, "tsc", { exit: 2, output: "src/x.ts(1,1): error TS6305: Output file has not been built" });
        record(editInput(writeProjectFile(root, "src/x.ts", "x")), { stateDir });

        assert.equal(await check(stopInput({ cwd: root }), { stateDir }), null);
      });

      it("terminates on reference cycles", async () => {
        writeProjectFile(root, "tsconfig.json", solution([{ path: "./a" }]));
        declare(root, ["typescript"]);
        writeProjectFile(root, "a/tsconfig.json", solution([{ path: ".." }, { path: "." }]));
        fakeBin(root, "tsc", { exit: 2, output: "src/x.ts(1,1): error TS2304: x" });
        record(editInput(writeProjectFile(root, "src/x.ts", "x")), { stateDir });

        assert.equal((await check(stopInput({ cwd: root }), { stateDir })).decision, "block");
      });

      it("limits the reference depth", async () => {
        declare(root, ["typescript"]);
        for (let level = 0; level < 12; level += 1) {
          writeProjectFile(root, `${"d/".repeat(level)}tsconfig.json`, solution([{ path: "d" }]));
        }
        const log = join(stateDir, "tsc.log");
        chmodSync(
          writeProjectFile(root, "node_modules/.bin/tsc", `#!/bin/sh\necho run >> "${log}"\nexit 0\n`),
          0o755,
        );
        record(editInput(writeProjectFile(root, "x.ts", "x")), { stateDir });

        await check(stopInput({ cwd: root }), { stateDir });

        const runs = readFileSync(log, "utf8").trim().split("\n").length;
        assert.ok(runs >= 2 && runs < 12);
      });

      it("treats unparseable tsconfig and missing references as having none", async () => {
        writeProjectFile(root, "tsconfig.json", "{ not json");
        declare(root, ["typescript"]);
        fakeBin(root, "tsc", { exit: 2, output: "src/x.ts(1,1): error TS2304: x" });
        record(editInput(writeProjectFile(root, "src/x.ts", "x")), { stateDir });
        assert.equal((await check(stopInput({ cwd: root }), { stateDir })).decision, "block");

        // Entries that point nowhere are skipped; the root project still runs.
        writeProjectFile(root, "tsconfig.json", solution([{ path: "./missing" }, {}, "x"]));
        declare(root, ["typescript"]);
        const other = { session_id: "s2" };
        record(editInput(join(root, "src/x.ts"), other), { stateDir });
        assert.equal((await check(stopInput({ ...other, cwd: root }), { stateDir })).decision, "block");
      });

      it("reads tsconfig with comments and trailing commas", async () => {
        const text = `{
          // solution
          "files": [], /* none */
          "references": [
            { "path": "./a/*not-a-comment*/", },
          ],
          "x": "a,]//b",
        }`;
        assert.deepEqual(parseJsonc(text), {
          files: [],
          references: [{ path: "./a/*not-a-comment*/" }],
          x: "a,]//b",
        });
        assert.equal(parseJsonc("{ nope"), null);
      });
    });
  });
});

describe("delegation-guard", () => {
  let stateDir;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "hooks-state-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  const workerNode = (extra = {}) => ({
    plan: "p1",
    id: "n1",
    agent: "worker",
    dependsOn: [],
    writes: ["src/a.ts"],
    acceptanceCriteria: ["a() returns null"],
    inputs: ["src/a.ts:1-10"],
    ...extra,
  });
  const reviewerNode = (extra = {}) => ({
    plan: "p1",
    id: "r1",
    agent: "reviewer",
    dependsOn: ["n1"],
    writes: [],
    verifies: "n1",
    acceptanceCriteria: ["checked"],
    inputs: ["src/a.ts:1-10"],
    ...extra,
  });
  const researcherNode = (extra = {}) => ({
    plan: "p1",
    id: "q1",
    agent: "researcher",
    dependsOn: [],
    acceptanceCriteria: ["found"],
    ...extra,
  });
  const withBlock = (node, body = "본문") => `\`\`\`plan-node\n${JSON.stringify(node)}\n\`\`\`\n\n${body}`;
  // A worker launch is a background launch unless `toolInput` says otherwise (a key set to undefined is omitted).
  const launchInput = (type, prompt, { toolInput = {}, ...extra } = {}) => ({
    session_id: "s1",
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: JSON.parse(
      JSON.stringify({ subagent_type: type, prompt, ...(type === "worker" ? { run_in_background: true } : {}), ...toolInput }),
    ),
    ...extra,
  });
  const run = (input) => guardAgents(input, { stateDir });
  const verdictOf = (result) => (result === null ? "allow" : result.hookSpecificOutput.permissionDecision);
  const reasonOf = (result) => result.hookSpecificOutput.permissionDecisionReason;

  describe("format check", () => {
    it("allows well-formed blocks for each agent type", () => {
      assert.equal(run(launchInput("worker", withBlock(workerNode()))), null);
      assert.equal(run(launchInput("reviewer", withBlock(reviewerNode()))), null);
      assert.equal(run(launchInput("researcher", withBlock(researcherNode()))), null);
    });

    it("allows leading blank lines and indentation-free whitespace before the block", () => {
      assert.equal(run(launchInput("worker", `\n  \n${withBlock(workerNode())}`)), null);
    });

    it("passes unrelated agent types without a block", () => {
      assert.equal(run(launchInput("planner", "plan this")), null);
      assert.equal(run(launchInput("general-purpose", "do it")), null);
      assert.equal(run({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { prompt: "x" } }), null);
    });

    it("makes the block optional for researcher", () => {
      assert.equal(run(launchInput("researcher", "그냥 조사해라")), null);
    });

    it("validates a researcher block when one is present", () => {
      const result = run(launchInput("researcher", withBlock(researcherNode({ acceptanceCriteria: [] }))));
      assert.equal(verdictOf(result), "deny");
    });

    it("checks nested calls from subagents too", () => {
      const result = run(launchInput("researcher", withBlock(researcherNode({ acceptanceCriteria: [] })), { agent_id: "a1", agent_type: "worker" }));
      assert.equal(verdictOf(result), "deny");
    });

    const structural = [
      ["a missing block", "그냥 지시", "맨 앞에 plan-node 블록이 없다"],
      ["a block that is not the first content", `먼저 설명\n\n${"```plan-node"}\n{}\n\`\`\``, "맨 앞"],
      ["an invalid JSON block", "```plan-node\n{not json}\n```\n본문", "올바른 JSON이 아니다"],
      ["a JSON array block", "```plan-node\n[]\n```\n본문", "JSON 객체 하나"],
      ["an unclosed block", `\`\`\`plan-node\n${JSON.stringify(workerNode())}\n본문`, "닫는"],
      ["an open line with an extra info string", `\`\`\`plan-node json\n${JSON.stringify(workerNode())}\n\`\`\``, "정확히"],
    ];
    for (const [name, prompt, expected] of structural) {
      it(`denies ${name}`, () => {
        const result = run(launchInput("worker", prompt));
        assert.equal(verdictOf(result), "deny");
        assert.ok(reasonOf(result).includes(expected), reasonOf(result));
        assert.ok(reasonOf(result).includes("planner.md"));
      });
    }

    it("treats plan-node blocks after the first as body text", () => {
      const prompt = `${withBlock(workerNode())}\n\n예시를 이렇게 고쳐라:\n\n${withBlock(workerNode({ id: "example" }))}`;
      assert.equal(run(launchInput("worker", prompt)), null);
    });

    it("denies an indented opening fence and says so", () => {
      const result = run(launchInput("worker", `  \`\`\`plan-node\n${JSON.stringify(workerNode())}\n  \`\`\``));
      assert.equal(verdictOf(result), "deny");
      assert.ok(reasonOf(result).includes("들여쓰기 없이"), reasonOf(result));
    });

    const fieldCases = [
      ["agent differs from subagent_type", "worker", workerNode({ agent: "reviewer" }), "agent는"],
      ["empty id", "worker", workerNode({ id: "" }), "id는"],
      ["numeric id", "worker", workerNode({ id: 1 }), "id는"],
      ["missing plan", "worker", (({ plan: _plan, ...rest }) => rest)(workerNode()), "plan은"],
      ["numeric plan", "worker", workerNode({ plan: 3 }), "plan은"],
      ["non-array dependsOn", "worker", workerNode({ dependsOn: "n1" }), "dependsOn"],
      ["non-string dependsOn item", "worker", workerNode({ dependsOn: [1] }), "dependsOn"],
      ["empty acceptanceCriteria", "worker", workerNode({ acceptanceCriteria: [] }), "acceptanceCriteria"],
      ["empty worker writes", "worker", workerNode({ writes: [] }), "writes는 1개 이상"],
      ["exclusive that is not boolean", "worker", workerNode({ exclusive: "yes" }), "exclusive"],
      ["empty writes with exclusive false", "worker", workerNode({ writes: [], exclusive: false }), "writes는 1개 이상"],
      ["worker plan node without inputs", "worker", (({ inputs: _inputs, ...rest }) => rest)(workerNode()), "inputs"],
      ["worker plan node with empty inputs", "worker", workerNode({ inputs: [] }), "inputs"],
      ["requirement without excerpt", "worker", workerNode({ requirement: { link: "x" } }), "requirement"],
      ["requirement that is a string", "worker", workerNode({ requirement: "x" }), "requirement"],
      ["writes with a .. segment", "worker", workerNode({ writes: ["a/../b.ts"] }), ".."],
      ["writes starting with ./", "worker", workerNode({ writes: ["./a.ts"] }), "./"],
      ["writes starting with ~", "worker", workerNode({ writes: ["~/.claude/a.ts"] }), "`~`"],
      ["exclusive on a reviewer", "reviewer", reviewerNode({ exclusive: true }), "exclusive"],
      ["exclusive false on a reviewer", "reviewer", reviewerNode({ exclusive: false }), "exclusive"],
      ["exclusive on a researcher", "researcher", researcherNode({ exclusive: true }), "exclusive"],
      ["writes with * in the middle", "worker", workerNode({ writes: ["src/*.ts"] }), "와일드카드"],
      ["writes with ?", "worker", workerNode({ writes: ["src/a?.ts"] }), "와일드카드"],
      ["writes with [", "worker", workerNode({ writes: ["src/[ab].ts"] }), "와일드카드"],
      ["writes with ** not at the end", "worker", workerNode({ writes: ["src/**/a.ts"] }), "와일드카드"],
      ["reviewer with non-empty writes", "reviewer", reviewerNode({ writes: ["a.ts"] }), "writes는 []"],
      ["reviewer without verifies", "reviewer", (({ verifies: _verifies, ...rest }) => rest)(reviewerNode()), "verifies"],
      ["reviewer plan node without inputs", "reviewer", (({ inputs: _inputs, ...rest }) => rest)(reviewerNode()), "inputs"],
      ["researcher with writes", "researcher", researcherNode({ writes: ["a.ts"] }), "researcher의 writes"],
    ];
    for (const [name, type, node, expected] of fieldCases) {
      it(`denies ${name}`, () => {
        const result = run(launchInput(type, withBlock(node)));
        assert.equal(verdictOf(result), "deny");
        assert.ok(reasonOf(result).includes(expected), reasonOf(result));
      });
    }

    it("lists every violation in one reason", () => {
      const result = run(launchInput("worker", withBlock(workerNode({ id: "", writes: ["./a", "b/../c"], acceptanceCriteria: [] }))));
      const reason = reasonOf(result);
      for (const part of ["id는", "./", "..", "acceptanceCriteria"]) {
        assert.ok(reason.includes(part), reason);
      }
    });

    const allowedCases = [
      ["exclusive worker with empty writes", "worker", workerNode({ writes: [], exclusive: true })],
      ["directory writes with /**", "worker", workerNode({ writes: ["src/**", "/abs/path/a.ts"] })],
      ["null plan without inputs", "worker", (({ inputs: _inputs, ...rest }) => ({ ...rest, plan: null }))(workerNode())],
      ["null requirement", "worker", workerNode({ requirement: null })],
      ["requirement object", "worker", workerNode({ requirement: { link: "https://x", excerpt: "e" } })],
      ["reviewer with null plan", "reviewer", (({ inputs: _inputs, ...rest }) => ({ ...rest, plan: null }))(reviewerNode())],
      ["researcher with empty writes", "researcher", researcherNode({ writes: [] })],
    ];
    for (const [name, type, node] of allowedCases) {
      it(`allows ${name}`, () => {
        assert.equal(run(launchInput(type, withBlock(node))), null);
      });
    }
  });

  describe("launch rules", () => {
    const BACKGROUND_REASON = "run_in_background: false";
    const NESTED_REASON = "하위 위임하지 않는다";

    it("denies a worker launch only when run_in_background is explicitly false", () => {
      for (const [index, [name, value]] of [["true", true], ["the string true", "true"], ["undefined", undefined], ["null", null]].entries()) {
        const node = workerNode({ id: `n${index + 1}`, writes: [`allowed-${index}.txt`] });
        assert.equal(run(launchInput("worker", withBlock(node), { toolInput: { run_in_background: value } })), null, name);
      }
      for (const [name, value] of [["false", false], ["the string false", "false"]]) {
        const result = run(launchInput("worker", withBlock(workerNode()), { toolInput: { run_in_background: value } }));
        assert.equal(verdictOf(result), "deny", name);
        assert.ok(reasonOf(result).includes(BACKGROUND_REASON), `${name}: ${reasonOf(result)}`);
        assert.ok(reasonOf(result).includes("종료 기록"), reasonOf(result));
      }
    });

    it("allows a worker launch whose tool input has no run_in_background key", () => {
      const input = launchInput("worker", withBlock(workerNode()));
      const toolInput = { ...input.tool_input };
      delete toolInput.run_in_background;
      assert.ok(!("run_in_background" in toolInput));
      assert.equal(run({ ...input, tool_input: toolInput }), null);
    });

    it("does not require a background launch for reviewer and researcher", () => {
      for (const value of [false, undefined, true]) {
        assert.equal(run(launchInput("reviewer", withBlock(reviewerNode()), { toolInput: { run_in_background: value } })), null);
        assert.equal(run(launchInput("researcher", withBlock(researcherNode()), { toolInput: { run_in_background: value } })), null);
        assert.equal(run(launchInput("researcher", "그냥 조사해라", { toolInput: { run_in_background: value } })), null);
      }
    });

    it("denies a worker launch made from inside a subagent, with or without a block", () => {
      for (const prompt of [withBlock(workerNode()), "no block"]) {
        const result = run(launchInput("worker", prompt, { agent_id: "a1", agent_type: "worker" }));
        assert.equal(verdictOf(result), "deny");
        assert.ok(reasonOf(result).includes(NESTED_REASON), reasonOf(result));
        assert.ok(reasonOf(result).includes("보고에 적어"), reasonOf(result));
      }
      assert.equal(verdictOf(run(launchInput("worker", withBlock(workerNode()), { agent_id: "a1", agent_type: "reviewer" }))), "deny");
    });

    it("handles a researcher or reviewer launch from inside a subagent as before", () => {
      const nested = { agent_id: "a1", agent_type: "worker" };
      assert.equal(run(launchInput("researcher", withBlock(researcherNode()), nested)), null);
      assert.equal(run(launchInput("researcher", "그냥 조사해라", nested)), null);
      assert.equal(run(launchInput("reviewer", withBlock(reviewerNode()), nested)), null);
      assert.equal(verdictOf(run(launchInput("reviewer", "no block", nested))), "deny");
    });

    it("collects every reason in one deny", () => {
      const result = run(launchInput("worker", withBlock(workerNode()), { toolInput: { run_in_background: false }, agent_id: "a1", agent_type: "worker" }));
      assert.equal(verdictOf(result), "deny");
      assert.ok(reasonOf(result).startsWith("위임을 거부한다:"), reasonOf(result));
      assert.ok(reasonOf(result).includes(BACKGROUND_REASON) && reasonOf(result).includes(NESTED_REASON), reasonOf(result));
      assert.ok(!reasonOf(result).includes("planner.md"), reasonOf(result));

      const withFormat = run(launchInput("worker", "no block", { toolInput: { run_in_background: "false" }, agent_id: "a1", agent_type: "worker" }));
      const reason = reasonOf(withFormat);
      assert.ok(reason.includes("plan-node 블록이 없다") && reason.includes(BACKGROUND_REASON) && reason.includes(NESTED_REASON), reason);
      assert.ok(reason.includes("planner.md"), reason);
    });

    it("does not record a launch it denied", () => {
      run(launchInput("worker", withBlock(workerNode()), { toolInput: { run_in_background: false }, tool_use_id: "t1" }));
      run(launchInput("worker", withBlock(workerNode({ id: "n2" })), { agent_id: "a1", tool_use_id: "t2" }));
      assert.deepEqual(readJsonl(sessionStatePath({ session_id: "s1" }, "delegation.jsonl", stateDir)), []);
    });
  });

  describe("retry limit", () => {
    const stop = (agentId, message) => ({
      session_id: "s1",
      hook_event_name: "SubagentStop",
      agent_id: agentId,
      agent_type: "reviewer",
      ...(message === undefined ? {} : { last_assistant_message: message }),
    });
    const handback = (agentId, message) => ({
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "SubagentHandback",
      agent_id: agentId,
      agent_type: "reviewer",
      tool_input: { message },
    });
    const bind = (toolUseId, agentId, extra = {}) => ({
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_use_id: toolUseId,
      tool_input: { subagent_type: "reviewer", prompt: "x" },
      tool_response: { status: "completed", agentId },
      ...extra,
    });

    const permutations = (items) =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
    // The events one reviewer produces in handback mode, in every order they could arrive in.
    const HANDBACK_ORDERS = permutations(["handback", "stop", "bind"]);

    let counter = 0;
    beforeEach(() => {
      counter = 0;
    });

    function launchReviewer({ plan = "p1", node = "n1" } = {}) {
      counter += 1;
      const toolUseId = `t${counter}`;
      const agentId = `rev${counter}`;
      assert.equal(run(launchInput("reviewer", withBlock(reviewerNode({ plan, verifies: node })), { tool_use_id: toolUseId })), null);
      return { toolUseId, agentId };
    }

    // Launch a reviewer and deliver its events in `order`. `stop` carries no message in handback mode.
    function review(text, { order = ["handback", "stop", "bind"], ...launchOptions } = {}) {
      const { toolUseId, agentId } = launchReviewer(launchOptions);
      deliver({ toolUseId, agentId }, text, order);
      return agentId;
    }
    function deliver({ toolUseId, agentId }, text, order = ["handback", "stop", "bind"]) {
      const events = {
        handback: () => handback(agentId, text),
        stop: () => stop(agentId),
        stopWithMessage: () => stop(agentId, text),
        bind: () => bind(toolUseId, agentId),
      };
      for (const name of order) {
        assert.equal(run(events[name]()), null);
      }
    }
    const verdict = (node, result) => `근거...\n\nVERDICT ${node}: ${result}\n`;
    // A probe launch; an allowed worker is bound and stopped at once so it does not count as running for the
    // next probe.
    const workerLaunch = (node = {}) => {
      counter += 1;
      const toolUseId = `w${counter}`;
      const agentId = `worker${counter}`;
      const result = run(launchInput("worker", withBlock(workerNode(node)), { tool_use_id: toolUseId }));
      if (result === null) {
        run(bind(toolUseId, agentId, { tool_input: { subagent_type: "worker", prompt: "x" }, tool_response: { status: "async_launched", agentId } }));
        run({ session_id: "s1", hook_event_name: "SubagentStop", agent_id: agentId, agent_type: "worker" });
      }
      return result;
    };

    it("allows after one or two fails and denies at the third", () => {
      review(verdict("n1", "fail"));
      assert.equal(workerLaunch(), null);
      review(verdict("n1", "fail"));
      assert.equal(workerLaunch(), null);
      review(verdict("n1", "fail"));
      const result = workerLaunch();
      assert.equal(verdictOf(result), "deny");
      assert.ok(reasonOf(result).includes("3회 실패"));
      assert.ok(reasonOf(result).includes("새 노드 id"));
    });

    it("also denies a reviewer launch for a node that failed three times", () => {
      for (let i = 0; i < 3; i++) {
        review(verdict("n1", "fail"));
      }
      assert.equal(verdictOf(run(launchInput("reviewer", withBlock(reviewerNode())))), "deny");
    });

    it("resets the count after a pass", () => {
      for (const result of ["fail", "fail", "pass", "fail", "fail"]) {
        review(verdict("n1", result));
      }
      assert.equal(workerLaunch(), null);
      review(verdict("n1", "fail"));
      assert.equal(verdictOf(workerLaunch()), "deny");
    });

    it("counts fails per node and per plan", () => {
      for (let i = 0; i < 3; i++) {
        review(verdict("n1", "fail"));
      }
      assert.equal(verdictOf(workerLaunch()), "deny");
      assert.equal(workerLaunch({ id: "n2" }), null);
      assert.equal(workerLaunch({ plan: "p2" }), null);
    });

    it("keys plan-less nodes by node id", () => {
      for (let i = 0; i < 3; i++) {
        review(verdict("n1", "fail"), { plan: null });
      }
      assert.equal(verdictOf(workerLaunch({ plan: null })), "deny");
      assert.equal(workerLaunch({ plan: null, id: "other" }), null);
    });

    it("counts a missing or malformed verdict line as fail", () => {
      review(verdict("n1", "fail"));
      review("판정을 적지 않은 보고");
      review("VERDICT n1: maybe");
      assert.equal(verdictOf(workerLaunch()), "deny");
    });

    it("requires the verdict on the last non-empty line", () => {
      review("VERDICT n1: pass\n\n추가 설명");
      review("VERDICT n1: pass extra");
      review("VERDICT n1:pass");
      assert.equal(verdictOf(workerLaunch()), "deny");
    });

    it("accepts emphasis around the verdict line", () => {
      const decorations = ["**VERDICT {n}: pass**", "`VERDICT {n}: pass`", "__VERDICT {n}: pass__", "  *VERDICT {n}: pass*  "];
      decorations.forEach((template, index) => {
        const node = `e${index}`;
        // Two fails and a decorated pass: if the pass were not read, the third fail would block the node.
        review(verdict(node, "fail"), { node });
        review(verdict(node, "fail"), { node });
        review(template.replace("{n}", node), { node });
        assert.equal(workerLaunch({ id: node }), null, template);
        review(verdict(node, "fail"), { node });
        assert.equal(workerLaunch({ id: node }), null, template);
      });
    });

    it("reads the verdict from SubagentStop when there is no handback", () => {
      for (let i = 0; i < 3; i++) {
        review(verdict("n1", "fail"), { order: ["stopWithMessage", "bind"] });
      }
      assert.equal(verdictOf(workerLaunch()), "deny");
    });

    describe("event order", () => {
      for (const order of HANDBACK_ORDERS) {
        it(`attributes verdicts correctly when events arrive as ${order.join(" > ")}`, () => {
          // Reviewers for A and B run at the same time; B reports a bold pass.
          const a = [launchReviewer({ node: "A" }), launchReviewer({ node: "A" }), launchReviewer({ node: "A" })];
          const b = launchReviewer({ node: "B" });
          deliver(b, "**VERDICT B: pass**", order);
          for (const reviewer of a) {
            deliver(reviewer, verdict("A", "fail"), order);
          }
          assert.equal(verdictOf(workerLaunch({ id: "A" })), "deny");
          assert.equal(workerLaunch({ id: "B" }), null);
        });

        it(`resets on a pass and counts later fails when events arrive as ${order.join(" > ")}`, () => {
          for (const [text, expected] of [
            [verdict("n1", "fail"), null],
            [verdict("n1", "fail"), null],
            ["**VERDICT n1: pass**", null],
            [verdict("n1", "fail"), null],
            [verdict("n1", "fail"), null],
            [verdict("n1", "fail"), "deny"],
          ]) {
            review(text, { order });
            assert.equal(verdictOf(workerLaunch()), expected ?? "allow");
          }
        });
      }

      for (const order of permutations(["stopWithMessage", "bind"])) {
        it(`works without a handback when events arrive as ${order.join(" > ")}`, () => {
          for (const text of [verdict("n1", "fail"), verdict("n1", "fail"), verdict("n1", "fail")]) {
            review(text, { order });
          }
          assert.equal(verdictOf(workerLaunch()), "deny");
        });
      }
    });

    describe("attribution", () => {
      const records = () => readJsonl(sessionStatePath({ session_id: "s1" }, "delegation.jsonl", stateDir));

      it("records only facts at event time", () => {
        const reviewer = launchReviewer();
        deliver(reviewer, verdict("n1", "fail"));
        const kinds = records().map((record) => record.kind);
        assert.deepEqual(kinds, ["launch", "verdict", "bind"]);
        assert.deepEqual(
          records().find((record) => record.kind === "bind"),
          { kind: "bind", ts: records()[2].ts, toolUseId: reviewer.toolUseId, agentId: reviewer.agentId, status: "completed" },
        );
      });

      it("does not record a SubagentStop without a message", () => {
        launchReviewer();
        run(stop("rev1"));
        assert.equal(records().filter((record) => record.kind === "verdict").length, 0);
      });

      it("ignores a verdict that is bound to nothing and names no node", () => {
        launchReviewer();
        for (let i = 0; i < 3; i++) {
          run(stop(`ghost${i}`, "정리했다"));
        }
        assert.equal(workerLaunch(), null);
      });

      it("falls back to the node on the verdict line when the bind is missing", () => {
        for (let i = 0; i < 3; i++) {
          const { agentId } = launchReviewer({ plan: "p9" });
          run(handback(agentId, verdict("n1", "fail")));
        }
        assert.equal(verdictOf(workerLaunch({ plan: "p9" })), "deny");
        assert.equal(workerLaunch({ plan: "p1" }), null);
      });

      it("falls back to the latest launch that verifies the node", () => {
        launchReviewer({ plan: "p1" });
        launchReviewer({ plan: "p2" });
        for (let i = 0; i < 3; i++) {
          run(handback(`orphan${i}`, verdict("n1", "fail")));
        }
        assert.equal(verdictOf(workerLaunch({ plan: "p2" })), "deny");
        assert.equal(workerLaunch({ plan: "p1" }), null);
      });

      it("ignores a verdict whose node matches no launch and has no bind", () => {
        launchReviewer();
        for (let i = 0; i < 3; i++) {
          run(handback(`orphan${i}`, verdict("zzz", "fail")));
        }
        assert.equal(workerLaunch({ id: "zzz" }), null);
        assert.equal(workerLaunch(), null);
      });

      it("trusts the bound launch over the node written on the line", () => {
        for (let i = 0; i < 3; i++) {
          review(verdict("n1-typo", "fail"));
        }
        assert.equal(verdictOf(workerLaunch()), "deny");
      });

      it("counts one reviewer agent once, using its latest verdict", () => {
        const reviewer = launchReviewer();
        deliver(reviewer, verdict("n1", "fail"));
        run(stop(reviewer.agentId, verdict("n1", "fail")));
        run(handback(reviewer.agentId, verdict("n1", "fail")));
        review(verdict("n1", "fail"));
        assert.equal(workerLaunch(), null);
        review(verdict("n1", "fail"));
        assert.equal(verdictOf(workerLaunch()), "deny");
      });

      it("uses the newest verdict when the same agent is resumed and re-judges", () => {
        review(verdict("n1", "fail"));
        review(verdict("n1", "fail"));
        const resumed = launchReviewer();
        deliver(resumed, verdict("n1", "fail"));
        assert.equal(verdictOf(workerLaunch()), "deny");
        run(stop(resumed.agentId, verdict("n1", "pass")));
        assert.equal(workerLaunch(), null);
      });

      it("ignores verdicts from other agent types", () => {
        for (let i = 0; i < 3; i++) {
          launchReviewer();
          run({ ...handback(`w${i}`, verdict("n1", "fail")), agent_type: "worker" });
        }
        assert.equal(workerLaunch(), null);
      });

      it("binds only worker and reviewer launches", () => {
        run(bind("tx", "agx", { tool_input: { subagent_type: "researcher", prompt: "x" } }));
        run(bind("ty", undefined));
        assert.equal(records().length, 0);
      });

      it("keeps state per session", () => {
        for (let i = 0; i < 3; i++) {
          review(verdict("n1", "fail"));
        }
        assert.equal(run(launchInput("worker", withBlock(workerNode()), { session_id: "s2" })), null);
      });

      it("does not record or block on unrelated events", () => {
        assert.equal(run({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }), null);
        assert.equal(run({ session_id: "s1", hook_event_name: "Stop" }), null);
      });
    });
  });

  describe("write overlap between workers", () => {
    const HOUR = 60 * 60 * 1000;
    let repo;
    let cwd;
    let counter;

    beforeEach(() => {
      repo = realpathSync(mkdtempSync(join(tmpdir(), "hooks-repo-")));
      mkdirSync(join(repo, ".git"));
      mkdirSync(join(repo, "sub"));
      cwd = join(repo, "sub");
      counter = 0;
    });

    afterEach(() => {
      rmSync(repo, { recursive: true, force: true });
    });

    // Try to launch a worker; returns { result, toolUseId, agentId }. `agentId` is the id its bind will carry.
    function attempt(node, { launchCwd = cwd, now } = {}) {
      counter += 1;
      const toolUseId = `t${counter}`;
      const input = launchInput("worker", withBlock(workerNode({ dependsOn: [], ...node })), { tool_use_id: toolUseId, cwd: launchCwd });
      const result = guardAgents(input, now === undefined ? { stateDir } : { stateDir, now });
      return { result, toolUseId, agentId: `w${counter}` };
    }
    function launch(node, options) {
      const worker = attempt(node, options);
      assert.equal(worker.result, null, worker.result === null ? "" : reasonOf(worker.result));
      return worker;
    }
    const post = (toolUseId, agentId, status) =>
      run({
        session_id: "s1",
        hook_event_name: "PostToolUse",
        tool_name: "Agent",
        tool_use_id: toolUseId,
        tool_input: { subagent_type: "worker", prompt: "x" },
        tool_response: { status, agentId },
      });
    const completedBind = ({ toolUseId, agentId }) => post(toolUseId, agentId, "completed");
    const startBackground = ({ toolUseId, agentId }) => post(toolUseId, agentId, "async_launched");
    const stopWorker = ({ agentId }, message) =>
      run({
        session_id: "s1",
        hook_event_name: "SubagentStop",
        agent_id: agentId,
        agent_type: "worker",
        ...(message === undefined ? {} : { last_assistant_message: message }),
      });
    // The normal end of a worker: its async bind, then its SubagentStop.
    const finish = (worker) => {
      startBackground(worker);
      stopWorker(worker);
    };
    const blocked = (node, options) => {
      const { result } = attempt(node, options);
      assert.equal(verdictOf(result), "deny");
      return reasonOf(result);
    };
    const allowed = (node, options) => assert.equal(attempt(node, options).result, null);

    it("denies a worker whose writes overlap a running worker and names the node, the path and the way out", () => {
      launch({ id: "n1", writes: ["src/a.ts"] });
      const reason = blocked({ id: "n2", writes: ["src/a.ts"] });
      assert.ok(reason.includes("p1/n1"), reason);
      assert.ok(reason.includes(join(repo, "src/a.ts")), reason);
      assert.ok(reason.includes("dependsOn"), reason);
      assert.ok(reason.includes("끝난 뒤"), reason);
    });

    it("allows the same file again once a background worker has stopped (async bind, then SubagentStop)", () => {
      const first = launch({ id: "n1", writes: ["src/a.ts"] });
      blocked({ id: "n2", writes: ["src/a.ts"] });
      startBackground(first);
      blocked({ id: "n2", writes: ["src/a.ts"] });
      stopWorker(first);
      allowed({ id: "n2", writes: ["src/a.ts"] });
    });

    it("keeps a launch running until its own bind and stop arrive, whatever happened to other workers", () => {
      launch({ id: "n1", writes: ["src/a.ts"] });
      const other = launch({ id: "n3", writes: ["src/c.ts"] });
      finish(other);
      blocked({ id: "n2", writes: ["src/a.ts"] });
    });

    it("keeps a background worker running after its handback until its SubagentStop", () => {
      const first = launch({ id: "n1", writes: ["src/a.ts"] });
      startBackground(first);
      run({ session_id: "s1", hook_event_name: "PostToolUse", tool_name: "SubagentHandback", agent_id: first.agentId, agent_type: "worker", tool_input: { message: "NODE n1: done" } });
      blocked({ id: "n2", writes: ["src/a.ts"] });
      stopWorker(first);
      allowed({ id: "n2", writes: ["src/a.ts"] });
    });

    it("still treats a completed bind as a completion, as a defence", () => {
      const first = launch({ id: "n1", writes: ["src/a.ts"] });
      blocked({ id: "n2", writes: ["src/a.ts"] });
      completedBind(first);
      allowed({ id: "n2", writes: ["src/a.ts"] });
    });

    it("says the node is freed when the earlier one ends, and that a vanished worker expires", () => {
      launch({ id: "n1", writes: ["src/a.ts"] });
      const reason = blocked({ id: "n2", writes: ["src/a.ts"] });
      assert.ok(reason.includes("앞 노드가 끝나면 풀린다. 종료 기록 없이 사라진 worker는 3시간 뒤 만료된다."), reason);
      assert.ok(!reason.includes("중단됐다면") && !reason.includes("다음 메시지"), reason);
    });

    it("keeps a background worker running after its async bind until its SubagentStop", () => {
      const first = launch({ id: "n1", writes: ["src/a.ts"] });
      startBackground(first);
      blocked({ id: "n2", writes: ["src/a.ts"] });
      stopWorker(first);
      allowed({ id: "n2", writes: ["src/a.ts"] });
    });

    it("counts a SubagentStop without a message", () => {
      const first = launch({ id: "n1", writes: ["src/a.ts"] });
      startBackground(first);
      stopWorker(first, undefined);
      allowed({ id: "n2", writes: ["src/a.ts"] });
    });

    it("counts a SubagentStop that arrives before the async bind", () => {
      const first = launch({ id: "n1", writes: ["src/a.ts"] });
      stopWorker(first, "NODE n1: done");
      startBackground(first);
      allowed({ id: "n2", writes: ["src/a.ts"] });
    });

    it("records a stop only for workers", () => {
      run({ session_id: "s1", hook_event_name: "SubagentStop", agent_id: "r1", agent_type: "reviewer" });
      run({ session_id: "s1", hook_event_name: "SubagentStop", agent_type: "worker" });
      const records = readJsonl(sessionStatePath({ session_id: "s1" }, "delegation.jsonl", stateDir));
      assert.equal(records.filter((record) => record.kind === "stop").length, 0);
      const first = launch({ id: "n1", writes: ["src/a.ts"] });
      stopWorker(first);
      assert.deepEqual(
        readJsonl(sessionStatePath({ session_id: "s1" }, "delegation.jsonl", stateDir)).filter((record) => record.kind === "stop").map((record) => record.agentId),
        [first.agentId],
      );
    });

    describe("resume, interruption and failure", () => {
      const T0 = Date.now();
      let tick;
      const at = () => T0 + (tick += 10);
      beforeEach(() => {
        tick = 0;
      });
      // Feed one recording event with an explicit clock. Returns the hook result (always null for these).
      const feed = (input, ts) => guardAgents({ session_id: "s1", ...input }, { stateDir, now: ts });
      const bindAt = ({ toolUseId, agentId }, status, ts) =>
        feed(
          {
            hook_event_name: "PostToolUse",
            tool_name: "Agent",
            tool_use_id: toolUseId,
            tool_input: { subagent_type: "worker", prompt: "x" },
            tool_response: { status, agentId },
          },
          ts,
        );
      const subagentEvent = (name) => ({ agentId }, ts) =>
        feed({ hook_event_name: name, agent_id: agentId, agent_type: "worker" }, ts);
      const startAt = subagentEvent("SubagentStart");
      const stopAt = subagentEvent("SubagentStop");
      const failAt = ({ toolUseId }, ts) =>
        feed({ hook_event_name: "PostToolUseFailure", tool_name: "Agent", tool_use_id: toolUseId, error: "boom" }, ts);
      const launchAt = (node, ts) => {
        const worker = attempt(node, { now: ts });
        assert.equal(worker.result, null, worker.result === null ? "" : reasonOf(worker.result));
        return worker;
      };
      const deniedAt = (node, ts) => {
        const { result } = attempt(node, { now: ts });
        assert.equal(verdictOf(result), "deny");
        return reasonOf(result);
      };
      const allowedAt = (node, ts) => assert.equal(attempt(node, { now: ts }).result, null);

      it("treats a background worker resumed after its stop as running again until the next stop", () => {
        const first = launchAt({ id: "n1", writes: ["src/a.ts"] }, at());
        bindAt(first, "async_launched", at());
        startAt(first, at());
        stopAt(first, at());
        startAt(first, at());
        assert.ok(deniedAt({ id: "n2", writes: ["src/a.ts"] }, at()).includes("p1/n1"));
        stopAt(first, at());
        allowedAt({ id: "n2", writes: ["src/a.ts"] }, at());
      });

      it("treats a worker resumed after a completed bind (defence) as running again", () => {
        const first = launchAt({ id: "n1", writes: ["src/a.ts"] }, at());
        startAt(first, at());
        bindAt(first, "completed", at());
        startAt(first, at());
        deniedAt({ id: "n2", writes: ["src/a.ts"] }, at());
        stopAt(first, at());
        allowedAt({ id: "n2", writes: ["src/a.ts"] }, at());
      });

      it("treats a start and a stop with the same timestamp as completed", () => {
        const first = launchAt({ id: "n1", writes: ["src/a.ts"] }, at());
        bindAt(first, "async_launched", at());
        const ts = at();
        startAt(first, ts);
        stopAt(first, ts);
        allowedAt({ id: "n2", writes: ["src/a.ts"] }, at());
      });

      it("keeps a worker whose first start has the same timestamp as its async bind running", () => {
        const first = launchAt({ id: "n1", writes: ["src/a.ts"] }, at());
        const ts = at();
        startAt(first, ts);
        bindAt(first, "async_launched", ts);
        deniedAt({ id: "n2", writes: ["src/a.ts"] }, at());
      });

      it("records starts only for workers", () => {
        feed({ hook_event_name: "SubagentStart", agent_id: "r1", agent_type: "reviewer" }, at());
        feed({ hook_event_name: "SubagentStart", agent_type: "worker" }, at());
        const records = readJsonl(sessionStatePath({ session_id: "s1" }, "delegation.jsonl", stateDir));
        assert.equal(records.filter((record) => record.kind === "start").length, 0);
      });

      it("keeps a launch running when nothing but a user prompt happens, until the TTL", () => {
        launchAt({ id: "n1", writes: ["src/a.ts"] }, T0);
        feed({ hook_event_name: "UserPromptSubmit", prompt: "다음 요청" }, T0 + 1);
        deniedAt({ id: "n2", writes: ["src/a.ts"] }, T0 + 2);
        deniedAt({ id: "n2", writes: ["src/a.ts"] }, T0 + 2.9 * HOUR);
        allowedAt({ id: "n2", writes: ["src/a.ts"] }, T0 + 3.1 * HOUR);
        assert.ok(!readJsonl(sessionStatePath({ session_id: "s1" }, "delegation.jsonl", stateDir)).some((record) => record.kind === "prompt"));
      });

      it("treats a failed Agent call as completed", () => {
        const first = launchAt({ id: "n1", writes: ["src/a.ts"] }, at());
        deniedAt({ id: "n2", writes: ["src/a.ts"] }, at());
        failAt(first, at());
        allowedAt({ id: "n2", writes: ["src/a.ts"] }, at());
      });

      it("ignores a failure that names another launch, and one without a tool_use_id", () => {
        const first = launchAt({ id: "n1", writes: ["src/a.ts"] }, at());
        failAt({ toolUseId: "other" }, at());
        feed({ hook_event_name: "PostToolUseFailure", tool_name: "Agent", error: "boom" }, at());
        feed({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_use_id: first.toolUseId, error: "boom" }, at());
        deniedAt({ id: "n2", writes: ["src/a.ts"] }, at());
      });

      it("counts the TTL from the latest start of a resumed worker", () => {
        const first = launchAt({ id: "n1", writes: ["src/a.ts"] }, T0);
        bindAt(first, "async_launched", T0 + 1);
        startAt(first, T0 + 1);
        stopAt(first, T0 + 2);
        startAt(first, T0 + 2.9 * HOUR);
        deniedAt({ id: "n2", writes: ["src/a.ts"] }, T0 + 3.5 * HOUR);
        allowedAt({ id: "n2", writes: ["src/a.ts"] }, T0 + 6 * HOUR);
      });

      it("records start and failure without any output", () => {
        const first = launchAt({ id: "n1", writes: ["src/a.ts"] }, at());
        assert.equal(startAt(first, at()), null);
        assert.equal(failAt(first, at()), null);
      });
    });

    it("allows two parallel workers with disjoint writes and denies the one that overlaps", () => {
      const a = launch({ id: "n1", writes: ["src/a.ts"] });
      startBackground(a);
      const b = launch({ id: "n2", writes: ["src/b.ts"] });
      startBackground(b);
      blocked({ id: "n3", writes: ["src/b.ts", "docs/x.md"] });
      allowed({ id: "n4", writes: ["docs/x.md"] });
    });

    it("lets a worker through when the overlapping one is complete but another is still running elsewhere", () => {
      const a = launch({ id: "n1", writes: ["src/a.ts"] });
      launch({ id: "n2", writes: ["src/b.ts"] });
      finish(a);
      allowed({ id: "n3", writes: ["src/a.ts"] });
    });

    it("reports every running node that overlaps", () => {
      launch({ id: "n1", writes: ["src/a.ts"] });
      launch({ id: "n2", writes: ["src/b.ts"] });
      const reason = blocked({ id: "n3", writes: ["src/a.ts", "src/b.ts"] });
      assert.ok(reason.includes("p1/n1") && reason.includes("p1/n2"), reason);
    });

    it("denies any worker while an exclusive worker runs, and an exclusive worker while any worker runs", () => {
      const exclusive = launch({ id: "x1", writes: [], exclusive: true });
      const reason = blocked({ id: "n2", writes: ["src/b.ts"] });
      assert.ok(reason.includes("p1/x1") && reason.includes("exclusive"), reason);
      finish(exclusive);
      const plain = launch({ id: "n2", writes: ["src/b.ts"] });
      assert.ok(blocked({ id: "x2", writes: [], exclusive: true }).includes("p1/n2"));
      assert.ok(blocked({ id: "x3", writes: ["other.txt"], exclusive: true }).includes("exclusive"));
      finish(plain);
      allowed({ id: "x2", writes: [], exclusive: true });
    });

    it("lets a running worker be replaced after the TTL, and not just before it", () => {
      const start = Date.now();
      launch({ id: "n1", writes: ["src/a.ts"] }, { now: start });
      assert.equal(verdictOf(attempt({ id: "n2", writes: ["src/a.ts"] }, { now: start + 3 * HOUR - 1000 }).result), "deny");
      assert.equal(attempt({ id: "n2", writes: ["src/a.ts"] }, { now: start + 3 * HOUR + 1000 }).result, null);
    });

    it("treats the same plan and node launched again while it runs as a conflict", () => {
      launch({ id: "n1", writes: ["src/a.ts"] });
      const reason = blocked({ id: "n1", writes: ["docs/other.md"] });
      assert.ok(reason.includes("p1/n1") && reason.includes("이미 실행 중"), reason);
    });

    it("allows the same node again after it completed, and the same id under another plan", () => {
      const first = launch({ id: "n1", writes: ["src/a.ts"] });
      allowed({ plan: "p2", id: "n1", writes: ["docs/other.md"] });
      finish(first);
      allowed({ id: "n1", writes: ["src/a.ts"] });
    });

    it("does not look at reviewers or researchers", () => {
      launch({ id: "n1", writes: ["src/a.ts"] });
      assert.equal(run(launchInput("reviewer", withBlock(reviewerNode({ verifies: "other" })), { tool_use_id: "rv", cwd })), null);
      assert.equal(run(launchInput("researcher", withBlock(researcherNode()), { tool_use_id: "rs", cwd })), null);
    });

    const overlaps = [
      ["identical relative paths", ["src/a.ts"], ["src/a.ts"], true],
      ["a relative and an absolute path to the same file", ["src/a.ts"], [() => join(repo, "src/a.ts")], true],
      ["a directory and a file below it", ["src/**"], ["src/deep/a.ts"], true],
      ["a file and the directory above it", ["src/deep/a.ts"], ["src/**"], true],
      ["a directory and a directory below it", ["src/**"], ["src/deep/**"], true],
      ["a directory below and the directory above", ["src/deep/**"], ["src/**"], true],
      ["two identical directories", ["src/**"], ["src/**"], true],
      ["a directory and the file named like it", ["src/**"], ["src"], true],
      ["sibling files", ["src/a.ts"], ["src/b.ts"], false],
      ["a directory and a sibling with the same prefix", ["src/a/**"], ["src/ab/x.ts"], false],
      ["a directory and a file that starts with its name", ["src/a/**"], ["src/a.ts"], false],
      ["two different directories", ["src/**"], ["docs/**"], false],
      ["a file and a directory elsewhere", ["src/a.ts"], ["docs/**"], false],
    ];
    for (const [name, first, second, conflict] of overlaps) {
      it(`${conflict ? "denies" : "allows"} ${name}`, () => {
        const resolveWrites = (writes) => writes.map((entry) => (typeof entry === "function" ? entry() : entry));
        launch({ id: "n1", writes: resolveWrites(first) });
        const { result } = attempt({ id: "n2", writes: resolveWrites(second) });
        assert.equal(verdictOf(result), conflict ? "deny" : "allow");
      });
    }

    it("resolves relative writes against the repository root, not the launch cwd", () => {
      launch({ id: "n1", writes: ["src/a.ts"] }, { launchCwd: cwd });
      assert.equal(verdictOf(attempt({ id: "n2", writes: [join(repo, "src/a.ts")] }, { launchCwd: repo }).result), "deny");
      assert.equal(verdictOf(attempt({ id: "n3", writes: ["src/a.ts"] }, { launchCwd: join(repo, "sub") }).result), "deny");
      assert.equal(attempt({ id: "n4", writes: [join(repo, "sub/src/a.ts")] }, { launchCwd: repo }).result, null);
    });

    it("uses the recorded root of each running node", () => {
      const other = realpathSync(mkdtempSync(join(tmpdir(), "hooks-repo-")));
      mkdirSync(join(other, ".git"));
      try {
        launch({ id: "n1", writes: ["src/a.ts"] }, { launchCwd: other });
        allowed({ id: "n2", writes: ["src/a.ts"] }, { launchCwd: repo });
        assert.equal(verdictOf(attempt({ id: "n3", writes: ["src/a.ts"] }, { launchCwd: other }).result), "deny");
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });

    it("falls back to the cwd when there is no repository", () => {
      const plain = realpathSync(mkdtempSync(join(tmpdir(), "hooks-plain-")));
      try {
        launch({ id: "n1", writes: ["a.ts"] }, { launchCwd: plain });
        assert.equal(verdictOf(attempt({ id: "n2", writes: [join(plain, "a.ts")] }, { launchCwd: plain }).result), "deny");
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    });

    it("sees through a symlinked directory", () => {
      mkdirSync(join(repo, "real"));
      symlinkSync(join(repo, "real"), join(repo, "alias"));
      launch({ id: "n1", writes: ["real/a.ts"] });
      assert.equal(verdictOf(attempt({ id: "n2", writes: ["alias/a.ts"] }).result), "deny");
    });

    it("does not record a denied launch", () => {
      launch({ id: "n1", writes: ["src/a.ts"] });
      blocked({ id: "n2", writes: ["src/a.ts"] });
      const launches = readJsonl(sessionStatePath({ session_id: "s1" }, "delegation.jsonl", stateDir)).filter((record) => record.kind === "launch");
      assert.deepEqual(launches.map((record) => record.id), ["n1"]);
      assert.equal(launches[0].root, repo);
    });

    it("keeps running workers per session", () => {
      launch({ id: "n1", writes: ["src/a.ts"] });
      const input = launchInput("worker", withBlock(workerNode({ id: "n2", writes: ["src/a.ts"] })), { session_id: "s2", cwd });
      assert.equal(run(input), null);
    });
  });

  describe("worker edits outside writes", () => {
    let repo;
    let cwd;
    let projectDir;
    let scratch;
    let counter;

    beforeEach(() => {
      repo = realpathSync(mkdtempSync(join(tmpdir(), "hooks-repo-")));
      mkdirSync(join(repo, ".git"));
      mkdirSync(join(repo, "sub"));
      cwd = join(repo, "sub");
      projectDir = join(repo, "projects", "p");
      scratch = join(repo, "scratch");
      mkdirSync(projectDir, { recursive: true });
      counter = 0;
    });

    afterEach(() => {
      rmSync(repo, { recursive: true, force: true });
    });

    const transcriptFile = (agentId) => join(projectDir, "s1", "subagents", `agent-${agentId}.jsonl`);
    function writeTranscript(agentId, firstLine, extraLines = []) {
      mkdirSync(dirname(transcriptFile(agentId)), { recursive: true });
      writeFileSync(transcriptFile(agentId), [firstLine, ...extraLines].map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
    }
    const userLine = (content) => ({ type: "user", message: { role: "user", content } });
    const editInput = (tool, agentId, path, extra = {}) => ({
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: tool,
      agent_id: agentId,
      agent_type: "worker",
      cwd,
      transcript_path: join(projectDir, "s1.jsonl"),
      scratchpad_dir: scratch,
      tool_input: tool === "NotebookEdit" ? { notebook_path: path, new_source: "x" } : { file_path: path, content: "x" },
      ...extra,
    });
    const edit = (tool, agentId, path, extra) => run(editInput(tool, agentId, path, extra));
    const inRepo = (path) => join(repo, path);

    // Launch a background worker for `node` and deliver its bind, so the bind path finds it.
    function bindWorker(node, agentId) {
      counter += 1;
      const toolUseId = `t${counter}`;
      assert.equal(run(launchInput("worker", withBlock(workerNode(node)), { tool_use_id: toolUseId, cwd })), null);
      run({
        session_id: "s1",
        hook_event_name: "PostToolUse",
        tool_name: "Agent",
        tool_use_id: toolUseId,
        tool_input: { subagent_type: "worker", prompt: "x" },
        tool_response: { status: "async_launched", agentId },
      });
    }

    describe("node from the bind", () => {
      it("allows an edit inside writes and denies one outside, naming the node and its writes", () => {
        bindWorker({ id: "n7", writes: ["src/a.ts", "docs/**"] }, "wb1");
        assert.equal(edit("Write", "wb1", inRepo("src/a.ts")), null);
        assert.equal(edit("Edit", "wb1", inRepo("docs/deep/x.md")), null);
        const result = edit("Edit", "wb1", inRepo("src/b.ts"));
        assert.equal(verdictOf(result), "deny");
        const reason = reasonOf(result);
        assert.ok(reason.includes("n7") && reason.includes("writes 밖"), reason);
        assert.ok(reason.includes(inRepo("src/b.ts")), reason);
        assert.ok(reason.includes("보고에 적어 메인이 판단"), reason);
        assert.ok(reason.includes('"src/a.ts"') && reason.includes('"docs/**"'), reason);
      });

      it("matches relative file paths against the cwd and relative writes against the repository root", () => {
        bindWorker({ id: "n7", writes: ["sub/a.ts"] }, "wb1");
        assert.equal(edit("Write", "wb1", "a.ts"), null);
        assert.equal(verdictOf(edit("Write", "wb1", "../a.ts")), "deny");
      });

      it("prefers the bind over a different node in the transcript", () => {
        bindWorker({ id: "n7", writes: ["src/a.ts"] }, "wb1");
        writeTranscript("wb1", userLine(withBlock(workerNode({ id: "n8", writes: ["src/b.ts"] }))));
        assert.equal(edit("Write", "wb1", inRepo("src/a.ts")), null);
        assert.equal(verdictOf(edit("Write", "wb1", inRepo("src/b.ts"))), "deny");
      });

      it("takes the launch of the worker the agent was bound to, not the latest launch", () => {
        bindWorker({ id: "n7", writes: ["src/a.ts"] }, "wb1");
        bindWorker({ id: "n8", writes: ["src/b.ts"] }, "wb2");
        assert.equal(verdictOf(edit("Write", "wb1", inRepo("src/b.ts"))), "deny");
        assert.equal(edit("Write", "wb2", inRepo("src/b.ts")), null);
      });
    });

    describe("node from the transcript", () => {
      it("reads the node from the first line when the worker is not bound yet (foreground)", () => {
        writeTranscript("wf1", userLine(withBlock(workerNode({ id: "n5", writes: ["src/**"] }), "본문")));
        assert.equal(edit("Write", "wf1", inRepo("src/deep/a.ts")), null);
        const result = edit("Write", "wf1", inRepo("docs/a.md"));
        assert.equal(verdictOf(result), "deny");
        assert.ok(reasonOf(result).includes("n5"));
      });

      it("reads content given as text parts", () => {
        writeTranscript("wf1", userLine([{ type: "text", text: withBlock(workerNode({ writes: ["src/a.ts"] })) }]));
        assert.equal(verdictOf(edit("Write", "wf1", inRepo("src/b.ts"))), "deny");
      });

      it("uses the first block only", () => {
        const prompt = `${withBlock(workerNode({ writes: ["src/a.ts"] }))}\n\n${withBlock(workerNode({ id: "example", writes: ["src/b.ts"] }))}`;
        writeTranscript("wf1", userLine(prompt));
        assert.equal(verdictOf(edit("Write", "wf1", inRepo("src/b.ts"))), "deny");
      });

      it("prefers agent_transcript_path when the input has one", () => {
        const elsewhere = join(repo, "elsewhere.jsonl");
        writeFileSync(elsewhere, `${JSON.stringify(userLine(withBlock(workerNode({ writes: ["src/z.ts"] }))))}\n`);
        assert.equal(edit("Write", "wf1", inRepo("src/z.ts"), { agent_transcript_path: elsewhere }), null);
        assert.equal(verdictOf(edit("Write", "wf1", inRepo("src/a.ts"), { agent_transcript_path: elsewhere })), "deny");
      });

      it("reads a first line longer than one read chunk", () => {
        const body = "x".repeat(200 * 1024);
        writeTranscript("wf1", userLine(withBlock(workerNode({ writes: ["src/a.ts"] }), body)), [userLine("second")]);
        assert.equal(edit("Write", "wf1", inRepo("src/a.ts")), null);
        assert.equal(verdictOf(edit("Write", "wf1", inRepo("src/b.ts"))), "deny");
      });
    });

    describe("fail-open", () => {
      it("passes when neither a bind nor a transcript exists", () => {
        assert.equal(edit("Write", "nobody", inRepo("anything.txt")), null);
      });

      it("passes when the transcript starts without a node block", () => {
        writeTranscript("wf1", userLine("파일을 고쳐라"));
        assert.equal(edit("Write", "wf1", inRepo("anything.txt")), null);
      });

      it("passes when the first transcript line is not JSON or has no message", () => {
        writeTranscript("wf1", "{not json");
        assert.equal(edit("Write", "wf1", inRepo("a.txt")), null);
        writeTranscript("wf2", { type: "summary" });
        assert.equal(edit("Write", "wf2", inRepo("a.txt")), null);
      });

      it("passes when the node block has no usable writes", () => {
        writeTranscript("wf1", userLine(withBlock({ plan: "p1", id: "n1" })));
        assert.equal(edit("Write", "wf1", inRepo("a.txt")), null);
      });

      it("passes when there is no transcript_path to compute from", () => {
        assert.equal(edit("Write", "wf1", inRepo("a.txt"), { transcript_path: undefined }), null);
      });
    });

    describe("exclusive node without writes", () => {
      it("denies every edit, from the transcript", () => {
        writeTranscript("wx1", userLine(withBlock(workerNode({ id: "x1", writes: [], exclusive: true }))));
        const result = edit("Write", "wx1", inRepo("src/a.ts"));
        assert.equal(verdictOf(result), "deny");
        assert.ok(reasonOf(result).includes("x1") && reasonOf(result).includes("exclusive"), reasonOf(result));
        assert.equal(verdictOf(edit("Edit", "wx1", inRepo("any/other.txt"))), "deny");
      });

      it("denies every edit, from the bind", () => {
        bindWorker({ id: "x1", writes: [], exclusive: true }, "wx2");
        assert.equal(verdictOf(edit("Write", "wx2", inRepo("src/a.ts"))), "deny");
      });

      it("still restricts an exclusive node that has writes to them", () => {
        bindWorker({ id: "x2", writes: ["src/a.ts"], exclusive: true }, "wx3");
        assert.equal(edit("Write", "wx3", inRepo("src/a.ts")), null);
        assert.equal(verdictOf(edit("Write", "wx3", inRepo("src/b.ts"))), "deny");
      });
    });

    describe("tools", () => {
      it("checks MultiEdit by file_path", () => {
        bindWorker({ id: "n7", writes: ["src/a.ts"] }, "wb1");
        assert.equal(edit("MultiEdit", "wb1", inRepo("src/a.ts")), null);
        assert.equal(verdictOf(edit("MultiEdit", "wb1", inRepo("src/b.ts"))), "deny");
      });

      it("checks NotebookEdit by notebook_path", () => {
        bindWorker({ id: "n7", writes: ["nb/a.ipynb"] }, "wb1");
        assert.equal(edit("NotebookEdit", "wb1", inRepo("nb/a.ipynb")), null);
        assert.equal(verdictOf(edit("NotebookEdit", "wb1", inRepo("nb/b.ipynb"))), "deny");
      });

      it("passes an edit without a target path", () => {
        bindWorker({ id: "n7", writes: ["src/a.ts"] }, "wb1");
        assert.equal(run({ ...editInput("Write", "wb1", inRepo("x")), tool_input: {} }), null);
      });

      it("ignores other tools", () => {
        bindWorker({ id: "n7", writes: ["src/a.ts"] }, "wb1");
        assert.equal(run({ ...editInput("Write", "wb1", inRepo("src/b.ts")), tool_name: "Read" }), null);
      });
    });

    describe("who is checked", () => {
      beforeEach(() => {
        bindWorker({ id: "n7", writes: ["src/a.ts"] }, "wb1");
      });

      it("passes calls whose agent_type is not worker", () => {
        for (const agentType of ["reviewer", "researcher", "general-purpose", undefined]) {
          assert.equal(edit("Write", "wb1", inRepo("src/b.ts"), { agent_type: agentType }), null, String(agentType));
        }
      });

      it("passes the main conversation (no agent_id)", () => {
        assert.equal(edit("Write", undefined, inRepo("src/b.ts"), { agent_type: undefined }), null);
        assert.equal(edit("Write", undefined, inRepo("src/b.ts")), null);
      });

      it("checks only PreToolUse events", () => {
        assert.equal(run({ ...editInput("Write", "wb1", inRepo("src/b.ts")), hook_event_name: "PostToolUse" }), null);
      });
    });

    describe("paths", () => {
      it("allows the scratchpad for any worker node", () => {
        bindWorker({ id: "n7", writes: ["src/a.ts"] }, "wb1");
        assert.equal(edit("Write", "wb1", join(scratch, "tmp", "note.txt")), null);
        assert.equal(verdictOf(edit("Write", "wb1", `${scratch}-other/x`)), "deny");
        writeTranscript("wx1", userLine(withBlock(workerNode({ id: "x1", writes: [], exclusive: true }))));
        assert.equal(edit("Write", "wx1", join(scratch, "note.txt")), null);
      });

      it("treats a path through a symlink as the file it points to", () => {
        mkdirSync(join(repo, "real"));
        symlinkSync(join(repo, "real"), join(repo, "alias"));
        bindWorker({ id: "n7", writes: ["real/**"] }, "wb1");
        assert.equal(edit("Write", "wb1", join(repo, "alias", "new.ts")), null);
        assert.equal(verdictOf(edit("Write", "wb1", join(repo, "alias2", "new.ts"))), "deny");
      });

      it("does not let .. leave the allowed directory", () => {
        bindWorker({ id: "n7", writes: ["src/**"] }, "wb1");
        assert.equal(verdictOf(edit("Write", "wb1", inRepo("src/../docs/a.md"))), "deny");
      });

      it("allows absolute writes", () => {
        bindWorker({ id: "n7", writes: [inRepo("src/a.ts")] }, "wb1");
        assert.equal(edit("Write", "wb1", inRepo("src/a.ts")), null);
      });
    });
  });
});

describe("project-tools session state", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hooks-state-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends and reads JSONL records, skipping malformed lines", () => {
    const path = sessionStatePath({ session_id: "../s 1" }, "x.jsonl", dir);
    assert.ok(path.startsWith(dir));
    appendJsonl(path, { a: 1 });
    appendFileSync(path, "{broken\n");
    appendJsonl(path, { a: 2 });
    assert.deepEqual(readJsonl(path), [{ a: 1 }, { a: 2 }]);
    assert.deepEqual(readJsonl(join(dir, "missing")), []);
  });

  it("finds the repository root from cwd, or falls back to cwd", () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "a", "b"), { recursive: true });
    assert.equal(findRepoRoot(join(repo, "a", "b")), repo);
    mkdirSync(join(dir, "plain"), { recursive: true });
    assert.equal(findRepoRoot(join(dir, "plain")), join(dir, "plain"));
  });
});

describe("readonly-bash", () => {
  const run = (command, agentType = "researcher") =>
    decisionOf(readonly({ tool_name: "Bash", agent_type: agentType, tool_input: { command } }));
  const tmp = tmpdir();

  const allowed = [
    "ls -la",
    "git log --oneline -5",
    "git -C /repo diff HEAD~1 -- src",
    "git --no-pager show HEAD:README.md",
    "git blame -L 1,5 file.txt",
    "git status --short",
    "git grep -n foo -- '*.mjs'",
    "git ls-files",
    "git rev-parse --show-toplevel",
    "git cat-file -p HEAD",
    "git branch",
    "git branch -a",
    "git branch -vv --contains abc123",
    "git branch --list 'feature/*'",
    "git remote -v",
    "gh issue view 12 --repo a/b",
    "gh issue list --label bug",
    "gh pr view 3 --json title",
    "gh pr diff 3",
    "gh pr checks 3",
    "gh pr list --state open",
    "gh search issues foo",
    "gh repo view a/b",
    "gh release list",
    "gh run list -w ci.yml",
    "gh run view 123 --log",
    "gh api repos/a/b/issues --jq '.[].title'",
    "gh api repos/a/b/issues -H 'Accept: application/json'",
    "gh api repos/a/b/issues --paginate",
    `git clone https://github.com/a/b.git ${join(tmp, "clone-x")}`,
    "git clone --depth 1 https://github.com/a/b.git /private/tmp/b",
    "git clone --depth=1 -b main https://github.com/a/b.git /tmp/b",
    "git clone https://github.com/a/b.git $TMPDIR/b",
    'git clone https://github.com/a/b.git "${TMPDIR}/b"',
    "gh repo clone a/b /tmp/b",
    "rg -n --glob '*.mjs' foo src",
    "grep -rn 'a;b' .",
    "jq '.a | .b' file.json",
    "cat file | head -20 | wc -l",
    "tail -n 5 log.txt",
    "find . -name '*.mjs' -type f",
    "find . -name '*.md' | sort | uniq -c",
    "tree -L 2",
    "stat file",
    "file x",
    "which node",
    "pwd",
    "echo hello",
    "echo hi 2>&1",
    "ls missing 2>/dev/null",
    "ls missing >/dev/null 2>&1",
    "ls &> /dev/null",
    "cat < file.txt",
    "sort file | uniq",
    "uniq -f 1 file",
    "cut -d, -f1 data.csv",
    "tr a-z A-Z",
    "diff a b",
    "realpath .",
    "dirname /a/b",
    "basename /a/b",
    "date +%s",
    "date -u",
    "sed -n '10,20p' file",
    "sed 's/a/b/g' file",
    "sed -e 's/a/b/' -e '/x/d' file",
    "sed -n '/start/,/end/p' file",
    "sed '$d' file",
    "sed --expression='1!G;h;$!d' file",
    "ls; pwd && git status || echo no",
    "ls\npwd",
    "node --version",
    "git --version",
    "gh --help",
    "rg -h",
    "mise version",
    "help ls",
    "cd /repo && git status",
    "nl -ba file",
    "du -sh dir",
    "printf '%s\\n' x",
    "test -f x && echo yes",
    "[ -d src ] && ls src",
    "readlink -f link",
    "uname -a",
    "type rg",
    "command -v rg",
    "command -V rg",
    "ps aux",
    "shasum -a 256 file",
    "sha256sum file",
    "md5 file",
    "mise which node",
    "mise ls",
    "mise current",
    "mise where node",
    "awk '{print $1}' file",
    "awk -F, '{print $2}' file",
    "awk -v n=1 '$1 == n' file",
    "nix --version",
    "nix eval --help",
    "nix eval --read-only --no-write-lock-file .#packages.aarch64-darwin.x.name",
    "nix --extra-experimental-features 'nix-command flakes' eval --read-only --no-update-lock-file --raw .#x",
    "nix flake show --no-write-lock-file",
    "nix flake metadata --no-update-lock-file",
    "nix path-info --no-write-lock-file nixpkgs#hello",
    "nix search --no-write-lock-file nixpkgs hello",
    "gh api graphql -f query='{ viewer { login } }'",
    "gh api graphql -F query='query { viewer { login } }' --jq .data",
    "sed -n '/x/{p}' file",
    "sed '2{s/a/b/;p}' file",
    "sed '/x/{n;d}' file",
    "gh version",
    "git version",
    "nix eval --help",
    "make --help",
  ];
  for (const command of allowed) {
    it(`allows: ${JSON.stringify(command)}`, () => {
      assert.equal(run(command), "allow");
    });
  }

  const denied = [
    ["git log --output=/tmp/x", "git --output"],
    ["git log --output /tmp/x", "git --output without ="],
    ["git diff --ext-diff", "git --ext-diff"],
    ["git -c core.pager=sh log", "git -c"],
    ["git --exec-path=/x log", "git --exec-path"],
    ["git grep -Osh foo", "git grep -O"],
    ["git commit -m x", "git commit"],
    ["git push", "git push"],
    ["git checkout main", "git checkout"],
    ["git branch newbranch", "branch create"],
    ["git branch -D old", "branch delete"],
    ["git branch -m a b", "branch rename"],
    ["git remote add x url", "remote add"],
    ["git clone https://github.com/a/b.git", "clone without a path"],
    ["git clone https://github.com/a/b.git ~/x", "clone into home"],
    ["git clone https://github.com/a/b.git /Users/someone/x", "clone into a user folder"],
    ["git clone https://github.com/a/b.git relative/dir", "clone to a relative path"],
    ["git clone https://github.com/a/b.git /tmp/../etc/x", "clone path escaping with .."],
    ["git clone https://github.com/a/b.git /tmp", "clone onto the tmp root itself"],
    ["git clone https://github.com/a/b.git /tmpfoo/x", "clone into a sibling prefix"],
    ["git clone -c core.sshCommand=x https://github.com/a/b.git /tmp/b", "clone -c"],
    ["git clone --upload-pack=x https://github.com/a/b.git /tmp/b", "clone --upload-pack"],
    ["git clone ext::sh /tmp/b", "ext transport"],
    ["gh repo clone a/b", "gh clone without a path"],
    ["gh repo clone a/b ~/b", "gh clone into home"],
    ["gh repo clone a/b /tmp/b -- -c x=y", "gh clone with git flags"],
    ["gh api -X POST repos/a/b/issues", "gh api -X"],
    ["gh api -XPOST repos/a/b/issues", "gh api -XPOST"],
    ["gh api --method DELETE repos/a/b", "gh api --method"],
    ["gh api --method=GET repos/a/b", "gh api --method="],
    ["gh api repos/a/b/issues -f title=x", "gh api -f"],
    ["gh api repos/a/b/issues -F n=1", "gh api -F"],
    ["gh api repos/a/b/issues --field n=1", "gh api --field"],
    ["gh api repos/a/b/issues --raw-field a=b", "gh api --raw-field"],
    ["gh api repos/a/b/issues --input body.json", "gh api --input"],
    ["gh pr merge 1", "gh pr merge"],
    ["gh pr create", "gh pr create"],
    ["gh pr view 1 --web", "gh --web"],
    ["gh issue view 1 -w", "gh -w on issue"],
    ["gh issue comment 1 -b x", "gh issue comment"],
    ["gh repo delete a/b", "gh repo delete"],
    ["gh auth status", "gh auth"],
    ["rg --pre sh x", "rg --pre"],
    ["rg --pre=sh x", "rg --pre="],
    ["rg --pre-glob '*.gz' x", "rg --pre-glob"],
    ["rg -z x", "rg -z"],
    ["echo x > f", "write redirect"],
    ["echo x >> f", "append redirect"],
    ["echo x >f", "attached redirect"],
    ["echo x 1> f", "fd redirect"],
    ["echo x &> f", "&> redirect"],
    ["echo x >| f", "clobber redirect"],
    ["echo x >&f", "dup to a file"],
    ["cat a > /dev/tty", "redirect to a device other than null"],
    ["cat <<EOF", "heredoc"],
    ["cat <<< hi", "here-string"],
    ["cat $(echo f)", "command substitution"],
    ['cat "$(echo f)"', "substitution in double quotes"],
    ["`id`", "backticks"],
    ['echo "`id`"', "backticks in double quotes"],
    ["cat <(echo f)", "process substitution"],
    ["echo $'a'", "ANSI-C quote"],
    ["(ls)", "subshell"],
    ["eval ls", "eval"],
    ["exec ls", "exec"],
    ["source x.sh", "source"],
    [". x.sh", "dot"],
    ["bash -c ls", "bash -c"],
    ["sh -c 'ls'", "sh -c"],
    ["zsh -c ls", "zsh -c"],
    ["env ls", "env wrapper"],
    ["env FOO=1 ls", "env with assignment"],
    ["FOO=1 ls", "assignment prefix"],
    ["FOO=$(id) ls", "assignment with substitution"],
    ["xargs rm", "xargs"],
    ["ls | xargs rm", "piped xargs"],
    ["ls | tee out.txt", "tee"],
    ["find . -delete", "find -delete"],
    ["find . -exec rm {} ;", "find -exec"],
    ["find . -execdir rm {} +", "find -execdir"],
    ["find . -ok rm {} ;", "find -ok"],
    ["find . -fprint out.txt", "find -fprint"],
    ["find . -fls out.txt", "find -fls"],
    ["sed -i s/a/b/ f", "sed -i"],
    ["sed -i'' s/a/b/ f", "sed -i attached"],
    ["sed -ni 's/a/b/p' f", "sed -ni"],
    ["sed --in-place s/a/b/ f", "sed --in-place"],
    ["sed -f script.sed f", "sed -f"],
    ["sed 's/a/b/w out.txt' f", "sed s///w"],
    ["sed 's/a/b/e' f", "sed s///e"],
    ["sed -n '1p;w out.txt' f", "sed w command"],
    ["sed '1e echo hi' f", "sed e command"],
    ["sed '/x/w out' f", "sed address w"],
    ["sort -o f f", "sort -o"],
    ["sort --output=f f", "sort --output"],
    ["sort -uo f f", "sort cluster with o"],
    ["tree -o out.txt", "tree -o"],
    ["file -C -m x", "file -C"],
    ["uniq in out", "uniq output file"],
    ["date -s 12:00", "date -s"],
    ["date 110812002026", "date set form"],
    ["rm -rf x", "rm"],
    ["mv a b", "mv"],
    ["cp a b", "cp"],
    ["touch f", "touch"],
    ["mkdir d", "mkdir"],
    ["curl https://example.com", "curl"],
    ["node script.js", "node script"],
    ["npm install", "npm"],
    ["nix build .#x", "nix"],
    ["mise run x", "mise"],
    ["python3 -c 1", "python"],
    ["/bin/ls", "path to a command"],
    ["./run.sh", "relative command"],
    ["ls && rm x", "second command denied"],
    ["ls | rm x", "piped rm"],
    ["ls; rm x", "semicolon rm"],
    ["ls\nrm x", "newline rm"],
    ["ls & rm x", "background rm"],
    ["ls # ; rm x", "rm after a comment marker"],
    ['ls "unterminated', "unbalanced double quote"],
    ["ls 'unterminated", "unbalanced single quote"],
    ["echo x >", "redirect without a target"],
    ["gh api graphql -f query='mutation { addStar }'", "graphql mutation"],
    ["gh api graphql -f query='MUTATION { x }'", "graphql mutation in other case"],
    ["gh api graphql -f query='{ a }' -f owner=x", "graphql with a second field"],
    ["gh api graphql -f owner=x", "graphql without query"],
    ["gh api graphql -f query=@q.graphql", "graphql query from a file"],
    ["gh api graphql --input q.json", "graphql --input"],
    ["gh api repos/a/b/issues -f query='{ a }'", "query field on a REST endpoint"],
    ["gh api repos/a/b -H 'X-HTTP-Method-Override: DELETE'", "method override header"],
    ["gh api repos/a/b/issues -Ftitle=x", "gh api attached -F"],
    ["gh api repos/a/b/issues -fx=1", "gh api attached -f"],
    ["gh api repos/a/b/issues --raw-f title=x", "gh api abbreviated --raw-field"],
    ["gh api repos/a/b/issues --fiel title=x", "gh api abbreviated --field"],
    ["gh api repos/a/b --meth DELETE", "gh api abbreviated --method"],
    ["sort --compress-prog=sh f", "sort abbreviated --compress-program"],
    ["sort --outp=f f", "sort abbreviated --output"],
    ["git diff --ou=/tmp/x", "git abbreviated --output"],
    ["git cat-file --filters HEAD:x", "git --filters"],
    ["tree -Rao out", "tree -o in a cluster"],
    ["gh pr diff 1 -w", "gh -w on pr"],
    ["printf -v x '%s' y", "printf -v"],
    ["cd a b", "cd with two arguments"],
    ["command rm x", "command running something"],
    ["command", "bare command"],
    ["mise run build", "mise run"],
    ["mise install", "mise install"],
    ["awk 'BEGIN{system(\"rm x\")}'", "awk system"],
    ["awk '{print > \"out\"}' f", "awk output redirect"],
    ["awk '{print | \"sh\"}' f", "awk pipe"],
    ["awk 'BEGIN{\"date\" | getline x}'", "awk getline"],
    ["awk -f prog.awk f", "awk -f"],
    ["awk -i inplace '{print}' f", "awk -i"],
    ["awk", "awk without a program"],
    ["nix build .#x", "nix build"],
    ["nix run nixpkgs#hello", "nix run"],
    ["nix develop", "nix develop"],
    ["nix flake update", "nix flake update"],
    ["nix flake lock", "nix flake lock"],
    ["nix eval --read-only .#x", "nix eval without a lock guard"],
    ["nix eval --no-write-lock-file .#x", "nix eval without --read-only"],
    ["nix flake show .", "nix flake show without a lock guard"],
    ["nix eval --read-only --no-write-lock-file --write-to out .#x", "nix eval --write-to"],
    ["nix eval --read-only --no-write-lock-file --option sandbox false .#x", "nix --option"],
    ["nix-shell", "nix-shell"],
    ["sed '/x/{w out}' f", "sed w inside a group"],
    ["sed -n '/x/{p;w out\n}' f", "sed w inside a multi-line group"],
  ];
  for (const [command, label] of denied) {
    it(`denies ${label}: ${JSON.stringify(command)}`, () => {
      assert.equal(run(command), "deny");
    });
  }

  // Cases from review rounds n3r1/n3r2: [command, expected, reason].
  const regressions = [
    // Exact legitimate long options are not abbreviations of a forbidden one.
    ["git grep --text foo", "allow", "git --text is not --textconv"],
    ["git log -p --text", "allow", "git --text"],
    ["git log --filter=blob:none", "allow", "git --filter is not --filters"],
    ["git diff --textc", "deny", "abbreviation of --textconv"],
    ["git cat-file --filters HEAD:x", "deny", "git --filters"],
    // The value of a short option is not a cluster of options.
    ["date -Iseconds", "allow", "date -I with an attached format"],
    ["date -Iminutes", "allow", "date -I"],
    ["date -d 'yesterday' +%s", "allow", "date -d with a separate value"],
    ["date +%Y-%m-%dT%H:%M:%S", "allow", "date format"],
    ["date -s 12:00", "deny", "date -s"],
    ["date -us 12:00", "deny", "date -s in a cluster"],
    ["rg -g'*.zsh' foo", "allow", "rg -g glob with a z"],
    ["rg -ezsh .", "allow", "rg -e pattern with a z"],
    ["rg -e -z foo", "allow", "rg -e whose value looks like -z"],
    ["rg -nz foo", "deny", "rg -z in a cluster"],
    ["tree -L 2 -Inode_modules", "allow", "tree -I pattern with an o"],
    ["tree -Inode_modules", "allow", "tree -I"],
    ["tree -Ro out", "deny", "tree -o in a cluster"],
    ["gh api repos/o/r/pulls/1/files -q'.[].filename'", "allow", "gh api -q with an f"],
    ["gh api repos/o/r -H'Accept: application/vnd.github.diff'", "allow", "gh api -H with an f"],
    ["gh api repos/o/r -q .name", "allow", "gh api -q separate value"],
    ["gh api repos/o/r/issues -Ftitle=x", "deny", "gh api attached -F"],
    ["gh api repos/o/r/issues -fx=1", "deny", "gh api attached -f"],
    ["gh api repos/o/r -XPOST", "deny", "gh api attached -X"],
    ["gh api graphql -fquery='{viewer{login}}'", "allow", "graphql query by -f"],
    ["gh api graphql -f query='mutation{x}'", "deny", "graphql mutation"],
    ["gh api graphql -f 'query={a}' -XGET", "deny", "-X after a field"],
    ["gh issue list -lweb", "allow", "gh -l label whose value has a w"],
    ["gh issue view 1 -w", "deny", "gh -w"],
    // `version` is a subcommand only for the listed commands.
    ["make version", "deny", "make is not allowed"],
    ["touch version", "deny", "touch"],
    ["rm version", "deny", "rm"],
    ["npx version", "deny", "npx"],
    ["node version", "deny", "node"],
    ["mise version", "allow", "mise version"],
    ["command version", "deny", "command is checked"],
    ["node --version", "allow", "--version for any tool"],
    // awk: > and | only matter in print/printf.
    ["awk '$1 > 5' f", "allow", "comparison"],
    ["awk '/foo|bar/' f", "allow", "regex alternation"],
    ["awk 'NR==1 || NR==3' f", "allow", "logical or"],
    ["awk '{ if ($1 > 5) print $1 }' f", "allow", "comparison before print"],
    ["awk '{print $1, $2 || $3}' f", "allow", "|| inside print"],
    ["awk '{print \"a>b\"}' f", "allow", "> inside a string"],
    ["awk '{print $1} $2 > 3' f", "allow", "comparison after print"],
    ["awk '{print $1 > \"f\"}' f", "deny", "print redirect"],
    ["awk '{print $1 >> \"f\"}' f", "deny", "print append"],
    ["awk '{print | \"sh\"}' f", "deny", "print pipe"],
    ["awk '{printf \"%s\", $1 | \"sh\"}' f", "deny", "printf pipe"],
    ["awk 'BEGIN{print \"x\" > \"/tmp/f\"}'", "deny", "print redirect in BEGIN"],
    ["awk '{ \"date\" | getline d }'", "deny", "getline"],
    ["awk 'BEGIN{system(\"id\")}'", "deny", "system"],
    ["awk '{print $1 |& \"cmd\"}'", "deny", "coprocess"],
    ["awk '@include \"x\"'", "deny", "@include"],
    ["awk '{print \"unterminated}' f", "deny", "unreadable program"],
    // nix: flags are an allowlist.
    ["nix eval --read-only --no-write-lock-file --allow-unsafe-native-code-during-evaluation --expr 'builtins.exec [\"touch\" \"/tmp/p\"]'", "deny", "unsafe native code"],
    ["nix eval --read-only --no-write-lock-file --store /tmp/s nixpkgs#hello.name", "deny", "--store"],
    ["nix eval --read-only --no-write-lock-file --accept-flake-config github:o/r#x", "deny", "--accept-flake-config"],
    ["nix eval --read-only --no-write-lock-file --option sandbox false .#x", "deny", "--option"],
    ["nix eval --read-only --no-write-lock-file --expr '1'", "allow", "--expr"],
    ["nix eval --read-only --no-write-lock-file --impure --expr '1'", "allow", "--impure"],
    ["nix eval --read-only --no-write-lock-file --expr --store", "allow", "a flag-like expression is a value"],
    ["nix eval --read-only --no-write-lock-file --json --apply builtins.attrNames .#x", "allow", "--json --apply"],
    ["nix eval --read-only --no-write-lock-file -f default.nix hello", "allow", "-f file"],
    ["nix eval --read-only --no-write-lock-file --file default.nix hello", "allow", "--file"],
    ["nix eval --read-only --no-write-lock-file --arg x 1 --argstr y z .#x", "allow", "--arg --argstr"],
    ["nix eval --read-only --no-write-lock-file -I nixpkgs=/x .#x", "deny", "-I"],
    ["nix flake show --no-write-lock-file github:o/r", "allow", "flake show"],
    ["nix flake show --no-write-lock-file --all-systems --legacy .", "allow", "flake show options"],
    ["nix flake show .", "deny", "flake show without a lock guard"],
    ["nix flake info --no-write-lock-file", "allow", "flake info"],
    ["nix flake info", "deny", "flake info without a lock guard"],
    ["nix flake metadata --no-update-lock-file --json", "allow", "flake metadata"],
    ["nix path-info --no-write-lock-file nixpkgs#hello", "allow", "path-info"],
    ["nix path-info --no-write-lock-file -S --json-format 1 nixpkgs#hello", "allow", "path-info options"],
    ["nix search --no-write-lock-file nixpkgs hello", "allow", "search"],
    ["nix search --no-write-lock-file --json nixpkgs hello -e x", "allow", "search options"],
    ["nix build --no-write-lock-file .#x", "deny", "build"],
    ["nix --extra-experimental-features 'nix-command flakes' eval --read-only --no-write-lock-file .#x", "allow", "experimental features"],
    ["nix eval --no-write-lock-file .#x", "deny", "eval without --read-only"],
    ["nix --version", "allow", "version"],
    ["nix eval --help", "allow", "help"],
    ["nix eval --store /tmp/s --help", "deny", "a forbidden flag next to --help"],
    // Other cases from the review.
    ["sed -n '/x/{p;q}' f", "allow", "sed group with q"],
    ["sed -n '1{p}' f", "allow", "sed group"],
    ["gh api graphql -f query='query{viewer{login}}' -f owner=o", "deny", "graphql with a second field"],
    ["gh api graphql -F query=@q.graphql", "deny", "graphql query from a file"],
    ["gh api graphql --raw-field query='{a}' --method POST", "deny", "graphql --method"],
    ["mise ls", "allow", "mise ls"],
    ["mise use node@20", "deny", "mise use"],
    ["mise exec -- ls", "deny", "mise exec"],
    ["cd /tmp", "allow", "cd"],
    ["cd a b", "deny", "cd with two arguments"],
    ["printf -v x '%s' y", "deny", "printf -v"],
    ["test -f x -a -w x", "allow", "test"],
    ["ps -ef", "allow", "ps"],
    ["command -v rm; rm x", "deny", "rm after command -v"],
    ["awk -f prog.awk f", "deny", "awk -f"],
    ["awk -e 'BEGIN{}' f", "deny", "awk -e"],
  ];
  for (const [command, expected, label] of regressions) {
    it(`${expected}s ${label}: ${JSON.stringify(command)}`, () => {
      assert.equal(run(command), expected);
    });
  }

  it("names flake info in the nix refusal", () => {
    const result = readonly({ tool_name: "Bash", agent_type: "researcher", tool_input: { command: "nix build .#x" } });
    assert.ok(result.reason.includes("flake show|metadata|info"), result.reason);
  });

  it("gives the blocked command, the reason, and the delegation hint", () => {
    const result = readonly({ tool_name: "Bash", agent_type: "researcher", tool_input: { command: "git status && rm -rf x" } });
    assert.ok(result.reason.includes("`rm -rf x`"));
    assert.ok(result.reason.includes("허용 목록"));
    assert.ok(result.reason.includes("worker에 넘기게"));
  });

  it("names the actual agent type in the guidance", () => {
    const planner = readonly({ tool_name: "Bash", agent_type: "planner", tool_input: { command: "rm x" } });
    const researcher = readonly({ tool_name: "Bash", agent_type: "researcher", tool_input: { command: "rm x" } });
    assert.ok(planner.reason.startsWith("planner는 읽기 전용 명령만 쓴다"), planner.reason);
    assert.ok(researcher.reason.startsWith("researcher는 읽기 전용 명령만 쓴다"), researcher.reason);
    const lexer = readonly({ tool_name: "Bash", agent_type: "planner", tool_input: { command: "echo $(id)" } });
    assert.ok(lexer.reason.startsWith("planner는"), lexer.reason);
  });

  it("reports every blocked command", () => {
    const result = readonly({ tool_name: "Bash", agent_type: "planner", tool_input: { command: "rm a; mv b c" } });
    assert.equal(result.decision, "deny");
    assert.ok(result.reason.includes("`rm a`") && result.reason.includes("`mv b c`"));
  });

  it("restricts planner like researcher", () => {
    assert.equal(run("rm x", "planner"), "deny");
    assert.equal(run("ls", "planner"), "allow");
  });

  it("does not restrict other agents or the main conversation", () => {
    for (const agentType of ["worker", "reviewer", "general-purpose", undefined]) {
      const input = { tool_name: "Bash", agent_type: agentType, tool_input: { command: "rm -rf x > y" } };
      assert.equal(decisionOf(readonly(input)), "allow");
    }
  });

  it("ignores tools other than Bash", () => {
    assert.equal(decisionOf(readonly({ tool_name: "Read", agent_type: "researcher", tool_input: {} })), "allow");
  });
});

describe("hook invoked through a symlinked directory", () => {
  const hooksDir = fileURLToPath(new URL(".", import.meta.url));
  let tempDir;
  let linkDir;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hooks-symlink-"));
    linkDir = join(tempDir, "link");
    symlinkSync(hooksDir, linkDir, "dir");
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function runRawThroughLink(script, input, env = {}) {
    const { stdout } = spawnSync(process.execPath, [join(linkDir, script)], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return stdout === "" ? null : JSON.parse(stdout);
  }

  function runThroughLink(script, input) {
    const output = runRawThroughLink(script, input);
    return output === null ? null : output.hookSpecificOutput.permissionDecision;
  }

  it("guard-dangerous still asks before git push", () => {
    const input = { tool_name: "Bash", tool_input: { command: "git push origin main" } };
    assert.equal(runThroughLink("guard-dangerous.mjs", input), "ask");
  });

  it("delegate-to-subagent still denies work tools in the main conversation", () => {
    assert.equal(runThroughLink("delegate-to-subagent.mjs", { tool_name: "Read", tool_input: {} }), "deny");
  });

  it("readonly-bash denies a write command for a researcher", () => {
    const input = { tool_name: "Bash", agent_type: "researcher", tool_input: { command: "rm -rf x" } };
    assert.equal(runThroughLink("readonly-bash.mjs", input), "deny");
  });

  it("readonly-bash prints nothing for an allowed command", () => {
    const input = { tool_name: "Bash", agent_type: "researcher", tool_input: { command: "git status" } };
    assert.equal(runRawThroughLink("readonly-bash.mjs", input), null);
  });

  it("delegation-guard denies a worker launch without a plan-node block", () => {
    const input = {
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "worker", prompt: "no block", run_in_background: true },
    };
    assert.equal(runThroughLink("delegation-guard.mjs", input), "deny");
  });

  it("delegation-guard records a verdict silently and then denies the node after three fails", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "hooks-state-"));
    const env = { CLAUDE_HOOKS_STATE_DIR: stateDir };
    const block = (node) => `\`\`\`plan-node\n${JSON.stringify(node)}\n\`\`\`\nbody`;
    const reviewer = { plan: null, id: "r", agent: "reviewer", dependsOn: [], writes: [], verifies: "n1", acceptanceCriteria: ["x"] };
    const worker = { plan: null, id: "n1", agent: "worker", dependsOn: [], writes: ["a.txt"], acceptanceCriteria: ["x"] };
    try {
      for (let i = 0; i < 3; i++) {
        const launch = { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "reviewer", prompt: block(reviewer) } };
        assert.equal(runRawThroughLink("delegation-guard.mjs", launch, env), null);
        const done = {
          session_id: "s1",
          hook_event_name: "PostToolUse",
          tool_name: "SubagentHandback",
          agent_id: `r${i}`,
          agent_type: "reviewer",
          tool_input: { message: "VERDICT n1: fail" },
        };
        assert.equal(runRawThroughLink("delegation-guard.mjs", done, env), null);
      }
      const retry = { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "worker", prompt: block(worker), run_in_background: true } };
      assert.equal(runRawThroughLink("delegation-guard.mjs", retry, env).hookSpecificOutput.permissionDecision, "deny");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  describe("record-edit and check-on-stop", () => {
    let root;
    let stateDir;

    beforeEach(() => {
      root = makeProject();
      stateDir = mkdtempSync(join(tmpdir(), "hooks-state-"));
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    });

    const handbackInput = (extra = {}) => ({
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "SubagentHandback",
      cwd: root,
      ...extra,
    });

    it("record-edit prints nothing even when a linter would fail, and check-on-stop blocks on the lint", () => {
      writeProjectFile(root, "eslint.config.js");
      declare(root, ["eslint"]);
      fakeBin(root, "eslint", { exit: 1, output: "linked boom" });
      const file = writeProjectFile(root, "a.ts", "x");
      const env = { CLAUDE_HOOKS_STATE_DIR: stateDir };

      assert.equal(runRawThroughLink("record-edit.mjs", editInput(file), env), null);
      const output = runRawThroughLink("check-on-stop.mjs", stopInput({ cwd: root }), env);

      assert.equal(output.decision, "block");
      assert.ok(output.reason.startsWith("[린트]"));
      assert.ok(output.reason.includes("linked boom"));
    });

    it("check-on-stop reads state written by record-edit and blocks", () => {
      writeProjectFile(root, "tsconfig.json", "{}");
      declare(root, ["typescript"]);
      fakeBin(root, "tsc", { exit: 2, output: "a.ts(1,2): error TS2304: Cannot find name 'x'." });
      const file = writeProjectFile(root, "a.ts", "x");
      const env = { CLAUDE_HOOKS_STATE_DIR: stateDir };

      assert.equal(runRawThroughLink("record-edit.mjs", editInput(file), env), null);
      const output = runRawThroughLink("check-on-stop.mjs", stopInput({ cwd: root }), env);

      assert.equal(output.decision, "block");
      assert.ok(output.reason.includes("TS2304"));
    });

    it("check-on-stop denies SubagentHandback with the PreToolUse output", () => {
      writeProjectFile(root, "tsconfig.json", "{}");
      declare(root, ["typescript"]);
      fakeBin(root, "tsc", { exit: 2, output: "a.ts(1,2): error TS2304: Cannot find name 'x'." });
      const file = writeProjectFile(root, "a.ts", "x");
      const env = { CLAUDE_HOOKS_STATE_DIR: stateDir };
      const agent = { agent_id: "agent-abc" };

      assert.equal(runRawThroughLink("record-edit.mjs", editInput(file, agent), env), null);
      const output = runRawThroughLink("check-on-stop.mjs", handbackInput(agent), env);

      assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
      assert.ok(output.hookSpecificOutput.permissionDecisionReason.includes("TS2304"));
    });

    it("check-on-stop prints the asynchronous result of format, lint, tsc and tests through the link", () => {
      writeProjectFile(root, "tsconfig.json", "{}");
      writeProjectFile(root, "eslint.config.js");
      declare(root, ["vitest", "prettier", "typescript", "eslint"]);
      fakeBin(root, "tsc", { exit: 2, output: "a.ts(1,2): error TS2304: Cannot find name 'x'." });
      fakeBin(root, "vitest", { exit: 1, output: "FAIL  a.test.ts > adds" });
      fakeBin(root, "eslint", { exit: 1, output: "linked boom" });
      fakeShell(root, "prettier", `printf formatted > "$4"`);
      const file = writeProjectFile(root, "a.ts", "x");
      const env = { CLAUDE_HOOKS_STATE_DIR: stateDir, CLAUDE_HOOKS_SKIP_TESTS: "" };

      assert.equal(runRawThroughLink("record-edit.mjs", editInput(file), env), null);
      const output = runRawThroughLink("check-on-stop.mjs", stopInput({ cwd: root }), env);

      assert.equal(output.decision, "block");
      const titles = ["[포맷]", "[린트]", "[타입 검사]", "[테스트]"].map((title) => output.reason.indexOf(title));
      assert.ok(titles.every((index) => index >= 0));
      assert.deepEqual(titles, [...titles].sort((a, b) => a - b));
      assert.ok(output.reason.includes("TS2304"));
      assert.ok(output.reason.includes("FAIL  a.test.ts > adds"));
      assert.equal(readFileSync(file, "utf8"), "formatted");
    });
  });
});
