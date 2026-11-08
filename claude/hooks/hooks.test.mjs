// Run with: node --test claude/hooks/hooks.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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
import { evaluate as guard } from "./guard-dangerous.mjs";
import { evaluate as lint } from "./lint-on-edit.mjs";
import { agentKeyOf, searchDirs, statePaths } from "./project-tools.mjs";
import { evaluate as typecheck, parseDiagnostics, parseJsonc } from "./typecheck-on-stop.mjs";

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

    it("normalizes the agent key", () => {
      assert.equal(agentKeyOf({ agent_id: "agent-abc" }), "abc");
      assert.equal(agentKeyOf({ agent_id: "abc" }), "abc");
      assert.equal(agentKeyOf({ agent_id: "../x/y" }), "___x_y");
      assert.equal(agentKeyOf({}), "main");
    });
  });

  describe("lint-on-edit", () => {
    it("passes files with a non-target extension", () => {
      writeProjectFile(root, "eslint.config.js");
      fakeBin(root, "eslint", { exit: 1, output: "boom" });
      const file = writeProjectFile(root, "README.md", "x");
      assert.equal(lint(editInput(file), { stateDir }), null);
    });

    it("passes when the file does not exist", () => {
      writeProjectFile(root, "eslint.config.js");
      fakeBin(root, "eslint", { exit: 1, output: "boom" });
      assert.equal(lint(editInput(join(root, "gone.js")), { stateDir }), null);
    });

    it("passes when the project has no linter", () => {
      const file = writeProjectFile(root, "src/a.ts", "x");
      assert.equal(lint(editInput(file), { stateDir }), null);
    });

    it("does not use linters installed above the .git boundary", () => {
      const outer = realpathSync(mkdtempSync(join(tmpdir(), "hooks-outer-")));
      try {
        writeProjectFile(outer, "eslint.config.js");
        fakeBin(outer, "eslint", { exit: 1, output: "boom" });
        const inner = join(outer, "project");
        mkdirSync(join(inner, ".git"), { recursive: true });
        const file = writeProjectFile(inner, "a.js", "x");
        assert.equal(lint(editInput(file), { stateDir }), null);
      } finally {
        rmSync(outer, { recursive: true, force: true });
      }
    });

    it("blocks with the linter output when it exits non-zero", () => {
      writeProjectFile(root, "eslint.config.js");
      fakeBin(root, "eslint", { exit: 1, output: "\u001b[31m3:1  error  no-undef\u001b[0m" });
      const file = writeProjectFile(root, "src/a.js", "x");

      const result = lint(editInput(file), { stateDir });

      assert.equal(result.decision, "block");
      assert.match(result.reason, /\[ESLint\] exit 1/);
      assert.ok(result.reason.includes(file));
      assert.ok(result.reason.includes("3:1  error  no-undef"));
      assert.ok(!result.reason.includes("\u001b"));
      assert.ok(result.reason.includes(`CWD: ${root}`));
    });

    it("passes when the linter exits 0, even with output", () => {
      writeProjectFile(root, "eslint.config.js");
      fakeBin(root, "eslint", { exit: 0, output: "1:1 warning something" });
      const file = writeProjectFile(root, "a.js", "x");
      assert.equal(lint(editInput(file), { stateDir }), null);
    });

    it("skips ESLint when there is a bin but no config", () => {
      fakeBin(root, "eslint", { exit: 1, output: "boom" });
      const file = writeProjectFile(root, "a.js", "x");
      assert.equal(lint(editInput(file), { stateDir }), null);
    });

    it("runs ESLint from the config directory for legacy configs and .vue files", () => {
      writeProjectFile(root, "pkg/.eslintrc.json", "{}");
      fakeBin(root, "eslint", { exit: 1, output: "vue problem" });
      const file = writeProjectFile(root, "pkg/src/App.vue", "x");

      const result = lint(editInput(file), { stateDir });

      assert.equal(result.decision, "block");
      assert.ok(result.reason.includes(`CWD: ${join(root, "pkg")}`));
    });

    it("runs Biome in lint-only mode from the biome.json directory", () => {
      writeProjectFile(root, "pkg/biome.json", "{}");
      fakeBin(root, "biome", { exit: 1, output: "lint/suspicious" });
      const file = writeProjectFile(root, "pkg/a.ts", "x");

      const result = lint(editInput(file), { stateDir });

      assert.ok(result.reason.includes("[Biome] exit 1"));
      assert.ok(result.reason.includes(`CWD: ${join(root, "pkg")}`));
      assert.ok(
        result.reason.includes(`ARGS: lint --no-errors-on-unmatched --files-ignore-unknown=true ${file}`),
      );
    });

    it("passes ESLint exit 2 (configuration or internal error) but still blocks exit 1", () => {
      writeProjectFile(root, "eslint.config.js");
      fakeBin(root, "eslint", { exit: 2, output: "Oops! Something went wrong!" });
      const file = writeProjectFile(root, "a.js", "x");
      assert.equal(lint(editInput(file), { stateDir }), null);

      fakeBin(root, "eslint", { exit: 1, output: "1:1 error" });
      assert.equal(lint(editInput(file), { stateDir }).decision, "block");
    });

    it("keeps blocking on Biome and oxlint exit 2", () => {
      fakeBin(root, "biome", { exit: 2, output: "b" });
      fakeBin(root, "oxlint", { exit: 2, output: "o" });
      const file = writeProjectFile(root, "a.js", "x");

      const result = lint(editInput(file), { stateDir });

      assert.ok(result.reason.includes("[Biome] exit 2"));
      assert.ok(result.reason.includes("[oxlint] exit 2"));
    });

    it("runs oxlint with --no-error-on-unmatched-pattern so ignored files pass", () => {
      fakeBin(root, "oxlint", { exit: 1, output: "o" });
      const file = writeProjectFile(root, "a.js", "x");

      const result = lint(editInput(file), { stateDir });

      assert.ok(result.reason.includes(`ARGS: --no-error-on-unmatched-pattern ${file}`));
    });

    it("tells Claude to leave pre-existing errors out of scope", () => {
      writeProjectFile(root, "eslint.config.js");
      fakeBin(root, "eslint", { exit: 1, output: "x" });
      const file = writeProjectFile(root, "a.js", "x");

      const { reason } = lint(editInput(file), { stateDir });

      assert.ok(reason.includes("이번 변경으로 생긴 오류는 고친다."));
      assert.ok(reason.includes("원래 있던 오류는 작업 범위 밖이면 고치지 말고 보고에 남긴다."));
    });

    it("runs Biome and oxlint from the bin project when no config exists", () => {
      fakeBin(root, "biome", { exit: 1, output: "b" });
      fakeBin(root, "oxlint", { exit: 1, output: "o" });
      const file = writeProjectFile(root, "src/a.js", "x");

      const result = lint(editInput(file), { stateDir });

      assert.ok(result.reason.includes("[Biome]"));
      assert.ok(result.reason.includes("[oxlint]"));
      assert.equal(result.reason.split(`CWD: ${root}`).length, 3);
    });

    it("runs every detected linter and reports only the failing ones", () => {
      writeProjectFile(root, "eslint.config.mjs");
      writeProjectFile(root, ".oxlintrc.json", "{}");
      fakeBin(root, "eslint", { exit: 1, output: "eslint says no" });
      fakeBin(root, "oxlint", { exit: 1, output: "oxlint says no" });
      fakeBin(root, "biome", { exit: 0, output: "fine" });
      const file = writeProjectFile(root, "a.mjs", "x");

      const result = lint(editInput(file), { stateDir });

      assert.ok(result.reason.includes("eslint says no"));
      assert.ok(result.reason.includes("oxlint says no"));
      assert.ok(!result.reason.includes("Biome"));
    });

    it("truncates long linter output", () => {
      writeProjectFile(root, "eslint.config.js");
      fakeBin(root, "eslint", { exit: 1, output: "x".repeat(20_000) });
      const file = writeProjectFile(root, "a.js", "x");
      assert.ok(lint(editInput(file), { stateDir }).reason.length < 6000);
    });

    it("records edited TS files under the normalized agent key, even without linters", () => {
      const file = writeProjectFile(root, "src/a.ts", "x");
      lint(editInput(file, { agent_id: "agent-abc", agent_type: "worker" }), { stateDir });
      lint(editInput(file), { stateDir });

      const subagent = statePaths({ session_id: "s1", agent_id: "agent-abc" }, stateDir);
      const main = statePaths({ session_id: "s1" }, stateDir);
      assert.equal(subagent.filesPath, join(stateDir, "s1", "abc.files"));
      assert.equal(readFileSync(subagent.filesPath, "utf8"), `${file}\n`);
      assert.equal(readFileSync(main.filesPath, "utf8"), `${file}\n`);
    });

    it("does not record non-TS files", () => {
      const file = writeProjectFile(root, "src/a.js", "x");
      lint(editInput(file), { stateDir });
      assert.equal(existsSync(statePaths({ session_id: "s1" }, stateDir).filesPath), false);
    });
  });

  describe("typecheck-on-stop", () => {
    const TSC_OUTPUT = [
      "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  Detail line for a.",
      "src/other.ts(1,1): error TS1005: ';' expected.",
    ].join("\n");

    function setup({ tscOutput = TSC_OUTPUT, tscExit = 2 } = {}) {
      writeProjectFile(root, "tsconfig.json", "{}");
      fakeBin(root, "tsc", { exit: tscExit, output: tscOutput });
      const edited = writeProjectFile(root, "src/a.ts", "x");
      writeProjectFile(root, "src/other.ts", "x");
      lint(editInput(edited), { stateDir });
      return edited;
    }

    it("parses diagnostics and folds continuation lines", () => {
      const parsed = parseDiagnostics(TSC_OUTPUT, root);
      assert.equal(parsed.length, 2);
      assert.equal(parsed[0].file, join(root, "src", "a.ts"));
      assert.equal(parsed[0].code, "TS2322");
      assert.match(parsed[0].message, /Detail line for a\./);
    });

    it("blocks with only the diagnostics of edited files", () => {
      setup();

      const result = typecheck(stopInput({ cwd: root }), { stateDir });

      assert.equal(result.decision, "block");
      assert.ok(result.reason.includes("src/a.ts"));
      assert.ok(result.reason.includes("TS2322"));
      assert.ok(result.reason.includes("Detail line for a."));
      assert.ok(!result.reason.includes("TS1005"));
      assert.ok(existsSync(statePaths(stopInput(), stateDir).filesPath));
    });

    it("uses the nearest tsconfig and resolves diagnostic paths against its directory", () => {
      writeProjectFile(root, "packages/app/tsconfig.json", "{}");
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(2,2): error TS2304: nested" });
      const file = writeProjectFile(root, "packages/app/src/a.ts", "x");
      lint(editInput(file), { stateDir });

      const result = typecheck(stopInput({ cwd: root }), { stateDir });

      assert.equal(result.decision, "block");
      assert.ok(result.reason.includes("packages/app/src/a.ts"));
    });

    it("passes and clears state when edited files have no diagnostics", () => {
      setup({ tscOutput: "src/other.ts(1,1): error TS1005: ';' expected." });

      assert.equal(typecheck(stopInput({ cwd: root }), { stateDir }), null);
      assert.equal(existsSync(statePaths(stopInput(), stateDir).filesPath), false);
    });

    it("passes when tsc fails without parseable diagnostics", () => {
      setup({ tscOutput: "error TS5083: Cannot read file tsconfig.json." });
      assert.equal(typecheck(stopInput({ cwd: root }), { stateDir }), null);
    });

    it("passes when nothing was edited", () => {
      assert.equal(typecheck(stopInput(), { stateDir }), null);
    });

    it("passes when the project has no tsc", () => {
      writeProjectFile(root, "tsconfig.json", "{}");
      const file = writeProjectFile(root, "src/a.ts", "x");
      lint(editInput(file), { stateDir });
      assert.equal(typecheck(stopInput({ cwd: root }), { stateDir }), null);
    });

    it("passes when there is no tsconfig", () => {
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(1,1): error TS1005: x" });
      const file = writeProjectFile(root, "src/a.ts", "x");
      lint(editInput(file), { stateDir });
      assert.equal(typecheck(stopInput({ cwd: root }), { stateDir }), null);
    });

    it("keeps state per agent: a subagent stop ignores main's files", () => {
      setup();
      assert.equal(typecheck(stopInput({ hook_event_name: "SubagentStop", agent_id: "agent-zzz" }), { stateDir }), null);
      assert.equal(typecheck(stopInput({ cwd: root }), { stateDir }).decision, "block");
    });

    it("matches subagent edits and stops through the normalized agent id", () => {
      writeProjectFile(root, "tsconfig.json", "{}");
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });
      const file = writeProjectFile(root, "src/a.ts", "x");
      lint(editInput(file, { agent_id: "agent-abc" }), { stateDir });

      const result = typecheck(stopInput({ hook_event_name: "SubagentStop", agent_id: "abc", cwd: root }), { stateDir });
      assert.equal(result.decision, "block");
    });

    it("gives up after three blocks and clears state", () => {
      setup();
      const input = stopInput({ stop_hook_active: true, cwd: root });

      // Different diagnostics each time, so only the block limit can end it.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        fakeBin(root, "tsc", { exit: 2, output: `src/a.ts(${attempt + 1},1): error TS2322: attempt ${attempt}` });
        assert.equal(typecheck(input, { stateDir }).decision, "block");
      }
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(9,1): error TS2322: attempt 3" });
      assert.equal(typecheck(input, { stateDir }), null);
      assert.equal(existsSync(statePaths(input, stateDir).filesPath), false);
      assert.equal(existsSync(statePaths(input, stateDir).blocksPath), false);
      assert.equal(existsSync(statePaths(input, stateDir).lastPath), false);
    });

    it("tells Claude to leave pre-existing errors out of scope", () => {
      setup();

      const { reason } = typecheck(stopInput({ cwd: root }), { stateDir });

      assert.ok(reason.includes("이번 변경으로 생긴 오류는 고친다."));
      assert.ok(reason.includes("원래 있던 오류는 작업 범위 밖이면 고치지 말고 보고에 남긴다."));
    });

    it("passes and clears state when the same diagnostics repeat after a block", () => {
      setup();
      const input = stopInput({ stop_hook_active: true, cwd: root });
      const paths = statePaths(input, stateDir);

      assert.equal(typecheck(input, { stateDir }).decision, "block");
      assert.ok(existsSync(paths.lastPath));

      assert.equal(typecheck(input, { stateDir }), null);
      assert.equal(existsSync(paths.filesPath), false);
      assert.equal(existsSync(paths.blocksPath), false);
      assert.equal(existsSync(paths.lastPath), false);
    });

    it("blocks again when the diagnostics change between stops", () => {
      setup();
      const input = stopInput({ stop_hook_active: true, cwd: root });

      assert.equal(typecheck(input, { stateDir }).decision, "block");
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: a different message" });
      assert.equal(typecheck(input, { stateDir }).decision, "block");
      fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(4,5): error TS2322: a different message" });
      assert.equal(typecheck(input, { stateDir }).decision, "block");
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
        fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(3,5): error TS2322: bad" });
        lint(editInput(writeProjectFile(root, "src/a.ts", "x"), AGENT), { stateDir });
      }

      it("denies with the PreToolUse output format and a before-report reason", () => {
        setupSubagent();

        const result = typecheck(handbackInput(), { stateDir });

        assert.deepEqual(Object.keys(result), ["hookSpecificOutput"]);
        assert.equal(result.hookSpecificOutput.hookEventName, "PreToolUse");
        assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
        const reason = result.hookSpecificOutput.permissionDecisionReason;
        assert.ok(reason.includes("TS2322"));
        assert.ok(reason.includes("보고 전에 이번 변경으로 생긴 오류는 고친다."));
        assert.ok(reason.includes("원래 있던 오류는 작업 범위 밖이면 고치지 말고 보고에 남긴다."));
      });

      it("keeps the Stop and SubagentStop output as decision block", () => {
        setupSubagent();

        const result = typecheck(subagentStop(), { stateDir });

        assert.equal(result.decision, "block");
        assert.equal(result.hookSpecificOutput, undefined);
      });

      it("does nothing for other tools", () => {
        setupSubagent();
        assert.equal(typecheck(handbackInput({ tool_name: "Bash" }), { stateDir }), null);
        assert.equal(typecheck(handbackInput({ tool_name: "Read" }), { stateDir }), null);
        // and does not consume the block count
        assert.equal(existsSync(statePaths(handbackInput(), stateDir).blocksPath), false);
      });

      it("passes the report and the later SubagentStop when there are no diagnostics", () => {
        writeProjectFile(root, "tsconfig.json", "{}");
        fakeBin(root, "tsc", { exit: 0 });
        lint(editInput(writeProjectFile(root, "src/a.ts", "x"), AGENT), { stateDir });

        assert.equal(typecheck(handbackInput(), { stateDir }), null);
        assert.equal(existsSync(statePaths(handbackInput(), stateDir).filesPath), false);
        assert.equal(typecheck(subagentStop(), { stateDir }), null);
      });

      it("allows the report after the errors are fixed, and the SubagentStop after it", () => {
        setupSubagent();
        assert.equal(typecheck(handbackInput(), { stateDir }).hookSpecificOutput.permissionDecision, "deny");

        fakeBin(root, "tsc", { exit: 0 });
        assert.equal(typecheck(handbackInput(), { stateDir }), null);
        assert.equal(typecheck(subagentStop(), { stateDir }), null);
      });

      it("allows the report when the same diagnostics repeat, and the SubagentStop after it", () => {
        setupSubagent();

        assert.equal(typecheck(handbackInput(), { stateDir }).hookSpecificOutput.permissionDecision, "deny");
        assert.equal(typecheck(handbackInput(), { stateDir }), null);
        assert.equal(typecheck(subagentStop(), { stateDir }), null);
      });

      it("shares the three-block limit with Stop and SubagentStop", () => {
        setupSubagent();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          fakeBin(root, "tsc", { exit: 2, output: `src/a.ts(${attempt + 1},1): error TS2322: attempt ${attempt}` });
          assert.ok(typecheck(attempt % 2 === 0 ? handbackInput() : subagentStop(), { stateDir }) !== null);
        }
        fakeBin(root, "tsc", { exit: 2, output: "src/a.ts(9,1): error TS2322: attempt 3" });
        assert.equal(typecheck(handbackInput(), { stateDir }), null);
      });
    });

    describe("solution-style tsconfig", () => {
      const solution = (references) => JSON.stringify({ files: [], references });

      it("also checks referenced projects, given as directories or files", () => {
        writeProjectFile(root, "tsconfig.json", solution([{ path: "./app" }, { path: "./tsconfig.node.json" }]));
        writeProjectFile(root, "app/tsconfig.json", "{}");
        writeProjectFile(root, "tsconfig.node.json", "{}");
        // Reports an error only when run for the app project.
        const script = `#!/bin/sh\ncase "$*" in *app/tsconfig.json*) echo "src/a.ts(2,3): error TS2304: in app";; esac\nexit 2\n`;
        const bin = writeProjectFile(root, "node_modules/.bin/tsc", script);
        chmodSync(bin, 0o755);
        const file = writeProjectFile(root, "app/src/a.ts", "x");
        lint(editInput(file), { stateDir });

        const result = typecheck(stopInput({ cwd: root }), { stateDir });

        assert.equal(result.decision, "block");
        assert.ok(result.reason.includes("TS2304: in app"));
      });

      it("runs tsc for the root and every referenced project, once each", () => {
        writeProjectFile(root, "tsconfig.json", solution([{ path: "./a" }, { path: "./b/tsconfig.json" }]));
        writeProjectFile(root, "a/tsconfig.json", solution([{ path: "../b" }]));
        writeProjectFile(root, "b/tsconfig.json", "{}");
        const log = join(stateDir, "tsc.log");
        const script = `#!/bin/sh\necho "$*" >> "${log}"\nexit 0\n`;
        chmodSync(writeProjectFile(root, "node_modules/.bin/tsc", script), 0o755);
        lint(editInput(writeProjectFile(root, "a/src/x.ts", "x")), { stateDir });
        writeProjectFile(root, "src/y.ts", "x");
        lint(editInput(join(root, "src/y.ts")), { stateDir });

        typecheck(stopInput({ cwd: root }), { stateDir });

        const runs = readFileSync(log, "utf8").trim().split("\n");
        const projects = runs.map((line) => line.split("-p ")[1]).sort();
        assert.deepEqual(projects, [
          join(root, "a/tsconfig.json"),
          join(root, "b/tsconfig.json"),
          join(root, "tsconfig.json"),
        ]);
      });

      it("deduplicates a diagnostic reported by several projects", () => {
        writeProjectFile(root, "tsconfig.json", solution([{ path: "./a" }, { path: "./b" }]));
        writeProjectFile(root, "a/tsconfig.json", "{}");
        writeProjectFile(root, "b/tsconfig.json", "{}");
        fakeBin(root, "tsc", { exit: 2, output: "src/x.ts(1,1): error TS2304: shared" });
        const file = writeProjectFile(root, "src/x.ts", "x");
        lint(editInput(file), { stateDir });

        const { reason } = typecheck(stopInput({ cwd: root }), { stateDir });

        assert.equal(reason.split("TS2304: shared").length, 2);
      });

      it("ignores TS6305 (referenced project not built)", () => {
        writeProjectFile(root, "tsconfig.json", "{}");
        fakeBin(root, "tsc", { exit: 2, output: "src/x.ts(1,1): error TS6305: Output file has not been built" });
        lint(editInput(writeProjectFile(root, "src/x.ts", "x")), { stateDir });

        assert.equal(typecheck(stopInput({ cwd: root }), { stateDir }), null);
      });

      it("terminates on reference cycles", () => {
        writeProjectFile(root, "tsconfig.json", solution([{ path: "./a" }]));
        writeProjectFile(root, "a/tsconfig.json", solution([{ path: ".." }, { path: "." }]));
        fakeBin(root, "tsc", { exit: 2, output: "src/x.ts(1,1): error TS2304: x" });
        lint(editInput(writeProjectFile(root, "src/x.ts", "x")), { stateDir });

        assert.equal(typecheck(stopInput({ cwd: root }), { stateDir }).decision, "block");
      });

      it("limits the reference depth", () => {
        for (let level = 0; level < 12; level += 1) {
          writeProjectFile(root, `${"d/".repeat(level)}tsconfig.json`, solution([{ path: "d" }]));
        }
        const log = join(stateDir, "tsc.log");
        chmodSync(
          writeProjectFile(root, "node_modules/.bin/tsc", `#!/bin/sh\necho run >> "${log}"\nexit 0\n`),
          0o755,
        );
        lint(editInput(writeProjectFile(root, "x.ts", "x")), { stateDir });

        typecheck(stopInput({ cwd: root }), { stateDir });

        const runs = readFileSync(log, "utf8").trim().split("\n").length;
        assert.ok(runs >= 2 && runs < 12);
      });

      it("treats unparseable tsconfig and missing references as having none", () => {
        writeProjectFile(root, "tsconfig.json", "{ not json");
        fakeBin(root, "tsc", { exit: 2, output: "src/x.ts(1,1): error TS2304: x" });
        lint(editInput(writeProjectFile(root, "src/x.ts", "x")), { stateDir });
        assert.equal(typecheck(stopInput({ cwd: root }), { stateDir }).decision, "block");

        // Entries that point nowhere are skipped; the root project still runs.
        writeProjectFile(root, "tsconfig.json", solution([{ path: "./missing" }, {}, "x"]));
        const other = { session_id: "s2" };
        lint(editInput(join(root, "src/x.ts"), other), { stateDir });
        assert.equal(typecheck(stopInput({ ...other, cwd: root }), { stateDir }).decision, "block");
      });

      it("reads tsconfig with comments and trailing commas", () => {
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

  describe("lint-on-edit and typecheck-on-stop", () => {
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

    it("lint-on-edit prints a block decision", () => {
      writeProjectFile(root, "eslint.config.js");
      fakeBin(root, "eslint", { exit: 1, output: "linked boom" });
      const file = writeProjectFile(root, "a.ts", "x");

      const output = runRawThroughLink("lint-on-edit.mjs", editInput(file), { CLAUDE_HOOKS_STATE_DIR: stateDir });

      assert.equal(output.decision, "block");
      assert.ok(output.reason.includes("linked boom"));
    });

    it("typecheck-on-stop reads state written by lint-on-edit and blocks", () => {
      writeProjectFile(root, "tsconfig.json", "{}");
      fakeBin(root, "tsc", { exit: 2, output: "a.ts(1,2): error TS2304: Cannot find name 'x'." });
      const file = writeProjectFile(root, "a.ts", "x");
      const env = { CLAUDE_HOOKS_STATE_DIR: stateDir };

      assert.equal(runRawThroughLink("lint-on-edit.mjs", editInput(file), env), null);
      const output = runRawThroughLink("typecheck-on-stop.mjs", stopInput({ cwd: root }), env);

      assert.equal(output.decision, "block");
      assert.ok(output.reason.includes("TS2304"));
    });

    it("typecheck-on-stop denies SubagentHandback with the PreToolUse output", () => {
      writeProjectFile(root, "tsconfig.json", "{}");
      fakeBin(root, "tsc", { exit: 2, output: "a.ts(1,2): error TS2304: Cannot find name 'x'." });
      const file = writeProjectFile(root, "a.ts", "x");
      const env = { CLAUDE_HOOKS_STATE_DIR: stateDir };
      const agent = { agent_id: "agent-abc" };

      assert.equal(runRawThroughLink("lint-on-edit.mjs", editInput(file, agent), env), null);
      const output = runRawThroughLink(
        "typecheck-on-stop.mjs",
        { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "SubagentHandback", cwd: root, ...agent },
        env,
      );

      assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
      assert.ok(output.hookSpecificOutput.permissionDecisionReason.includes("TS2304"));
    });
  });
});
