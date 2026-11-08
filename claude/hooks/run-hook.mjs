// Shared stdin/stdout handling for hooks.
// `handler` receives the parsed stdin JSON and returns null (no output)
// or the object to print as the hook's JSON output.
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function runJsonHook(handler, moduleUrl) {
  // Node resolves `import.meta.url` to the real path but leaves `argv[1]` as
  // invoked, so resolve symlinks before comparing (~/.claude/hooks is a symlink).
  if (moduleUrl !== pathToFileURL(realpathSync(process.argv[1])).href) {
    return;
  }

  const output = handler(JSON.parse(readFileSync(0, "utf8")));
  if (output === null) {
    return;
  }

  process.stdout.write(JSON.stringify(output));
}

// PreToolUse output for { decision: "deny" | "ask", reason }.
export function preToolUseOutput({ decision, reason }) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

// PreToolUse: `evaluate` returns null to defer to the normal permission flow,
// or { decision: "deny" | "ask", reason } to override it.
export function runHook(evaluate, moduleUrl) {
  runJsonHook((input) => {
    const result = evaluate(input);
    return result === null ? null : preToolUseOutput(result);
  }, moduleUrl);
}
