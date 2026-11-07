// PreToolUse: block or ask before dangerous actions that permission rules cannot express.
// Simple prefix commands (sudo, git reset --hard, ...) live in settings.json permissions.ask.
import { homedir } from "node:os";
import { runHook } from "./run-hook.mjs";

const HOME = homedir();

// rm targets that wipe the root, the home folder, or a whole user folder.
const BROAD_RM_TARGETS = [
  /^\/\*?$/,
  /^~\/?\*?$/,
  /^\$\{?HOME\}?\/?\*?$/,
  /^\/Users\/?\*?$/,
  /^\/Users\/[^/]+\/?\*?$/,
];

const SYSTEM_PATH = /^\/(etc|System|usr|bin|sbin|Library)\//;

const GLOBAL_CONFIG_FILES = new Set(
  [".zshrc", ".zprofile", ".bashrc", ".gitconfig", ".claude.json"].map((name) => `${HOME}/${name}`),
);

// Split a shell command into simple commands at &&, ||, ;, | and newlines.
function splitCommands(command) {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((part) => part.trim().split(/\s+/).filter((word) => word !== ""))
    .filter((words) => words.length > 0);
}

function unquote(word) {
  return word.replace(/^["']|["']$/g, "");
}

function isBroadRecursiveRm(words) {
  const rmIndex = words.findIndex((word) => word === "rm" || word.endsWith("/rm"));
  if (rmIndex === -1) {
    return false;
  }

  const args = words.slice(rmIndex + 1);
  const isRecursive = args.some((arg) => /^-[a-zA-Z]*[rR]/.test(arg) || arg === "--recursive");
  const targets = args.filter((arg) => !arg.startsWith("-")).map(unquote);
  return isRecursive && targets.some((target) => BROAD_RM_TARGETS.some((pattern) => pattern.test(target)));
}

// Force pushes, +refspecs, and pushes to main/master, including `git -C <dir> push`.
function isRiskyPush(words) {
  const gitIndex = words.indexOf("git");
  if (gitIndex === -1) {
    return false;
  }

  let index = gitIndex + 1;
  while (index < words.length && words[index].startsWith("-")) {
    index += words[index] === "-C" || words[index] === "-c" ? 2 : 1;
  }
  if (words[index] !== "push") {
    return false;
  }

  return words
    .slice(index + 1)
    .some(
      (arg) =>
        /^--force(-with-lease|-if-includes)?(=|$)/.test(arg) ||
        /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg) ||
        arg.startsWith("+") ||
        /(^|:)(main|master)$/.test(arg),
    );
}

// Deny rules come first so they win over ask rules.
const BASH_RULES = [
  {
    decision: "deny",
    matches: (command, commands) => commands.some(isBroadRecursiveRm),
    reason: "루트·홈 폴더 전체를 지우는 rm은 실행하지 않는다. 지울 경로를 구체적으로 좁히거나 사용자에게 직접 실행을 요청한다.",
  },
  {
    decision: "deny",
    matches: (command) =>
      /(^|[\s;&|])(mkfs(\.\w+)?|diskutil\s+(erase|zero|partition)\w*)(\s|$)|\bdd\s.*\bof=\/dev\//.test(command),
    reason: "디스크를 지우거나 포맷하는 명령은 실행하지 않는다.",
  },
  {
    decision: "deny",
    matches: (command) => /\bsecurity\s+find-(generic|internet)-password\b.*\s-[a-zA-Z]*[wg](\s|$)/.test(command),
    reason: "Keychain의 비밀 값은 읽지 않는다.",
  },
  {
    decision: "ask",
    matches: (command) => /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh(\s|$)/.test(command),
    reason: "원격 스크립트를 바로 셸로 실행한다. 출처를 확인한 뒤 승인한다.",
  },
  {
    decision: "ask",
    matches: (command, commands) => commands.some(isRiskyPush),
    reason: "강제 push 또는 main·master로 직접 push한다. 대상 브랜치와 덮어쓸 커밋을 확인한 뒤 승인한다.",
  },
];

export function evaluate(input) {
  const toolInput = input.tool_input ?? {};

  if (input.tool_name === "Bash") {
    const command = toolInput.command ?? "";
    const commands = splitCommands(command);
    const rule = BASH_RULES.find((candidate) => candidate.matches(command, commands));
    return rule === undefined ? null : { decision: rule.decision, reason: rule.reason };
  }

  if (["Write", "Edit", "NotebookEdit"].includes(input.tool_name)) {
    const path = toolInput.file_path ?? toolInput.notebook_path ?? "";
    if (SYSTEM_PATH.test(path)) {
      return { decision: "deny", reason: "시스템 경로는 수정하지 않는다." };
    }
    if (GLOBAL_CONFIG_FILES.has(path)) {
      return {
        decision: "ask",
        reason: "셸·git·Claude 전역 설정 파일을 직접 수정한다. 이 저장소의 원본(home.nix 등)을 고쳐야 하는지 확인한 뒤 승인한다.",
      };
    }
  }

  return null;
}

runHook(evaluate, import.meta.url);
