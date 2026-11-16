// PostToolUse(Edit|Write|MultiEdit): record the edited JS/TS/Vue/Svelte file for check-on-stop.mjs, which
// formats, lints, typechecks and tests the recorded files when the agent stops. Nothing runs here and the
// hook never prints anything.
import { extname, resolve } from "node:path";
import { FRAMEWORK_EXTENSIONS, SCRIPT_EXTENSIONS, isFile, recordEditedFile, statePaths } from "./project-tools.mjs";
import { runJsonHook } from "./run-hook.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

export function evaluate(input, { stateDir } = {}) {
  const filePath = input.tool_input?.file_path;
  if (!EDIT_TOOLS.has(input.tool_name) || typeof filePath !== "string") {
    return null;
  }

  const file = resolve(input.cwd ?? process.cwd(), filePath);
  const extension = extname(file).toLowerCase();
  if (!(SCRIPT_EXTENSIONS.has(extension) || FRAMEWORK_EXTENSIONS.has(extension)) || !isFile(file)) {
    return null;
  }

  recordEditedFile(statePaths(input, stateDir), file);
  return null;
}

runJsonHook((input) => evaluate(input), import.meta.url);
