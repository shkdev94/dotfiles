import { createConnection, type Socket } from "node:net";
import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";

type PromptCommand = { type: "prompt"; text: string };

function firstPromptTitle(manager: SessionManager): string | undefined {
  for (const entry of manager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    const text = typeof content === "string"
      ? content
      : content.filter(block => block.type === "text").map(block => block.text).join("\n");
    const request = text.match(/(?:^|\n)요청:\s*\n([\s\S]*)$/)?.[1] ?? text;
    const firstLine = request.split("\n").find(line => line.trim())?.trim().replace(/[\x00-\x1f\x7f]/g, " ");
    if (firstLine) return Array.from(firstLine).slice(0, 40).join("");
  }
  return undefined;
}

export default function nvim(pi: ExtensionAPI): void {
  const socketPath = process.env.PI_NVIM_SOCKET;
  if (!socketPath) return;

  let socket: Socket | undefined;
  let running = false;
  let ranSinceSettled = false;
  let compacting = false;
  let awaitingPrompt = false;
  let activeTools = 0;
  let finalOutcome: "completed" | "aborted" | "error" | undefined;
  let lastStopReason: string | undefined;

  const emit = (message: Record<string, unknown>) => {
    if (socket?.writable) socket.write(`${JSON.stringify(message)}\n`);
  };

  const emitActivity = () => {
    if (awaitingPrompt) emit({ type: "blocked" });
    else if (compacting) emit({ type: "working", phase: "compaction" });
    else if (activeTools > 0) emit({ type: "working", phase: "tool" });
    else if (running) emit({ type: "working" });
    else emit({ type: "idle" });
  };

  pi.on("session_start", (_event, ctx) => {
    socket?.destroy();
    running = false;
    ranSinceSettled = false;
    compacting = false;
    awaitingPrompt = false;
    activeTools = 0;
    finalOutcome = undefined;
    lastStopReason = undefined;
    let incoming = "";
    const connection = createConnection(socketPath);
    socket = connection;
    connection.on("connect", () => {
      emit({
        type: "hello",
        pid: process.pid,
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        name: ctx.sessionManager.getSessionName() ?? firstPromptTitle(ctx.sessionManager),
      });
    });
    connection.on("data", chunk => {
      incoming += chunk.toString("utf8");
      if (incoming.length > 1_000_000) {
        connection.destroy();
        return;
      }
      let newline = incoming.indexOf("\n");
      while (newline !== -1) {
        const line = incoming.slice(0, newline);
        incoming = incoming.slice(newline + 1);
        try {
          const command = JSON.parse(line) as PromptCommand;
          if (command.type === "prompt" && typeof command.text === "string" && command.text.trim()) {
            pi.sendUserMessage(command.text, { deliverAs: "followUp", expandPromptTemplates: true });
          }
        } catch (error) {
          emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
        newline = incoming.indexOf("\n");
      }
    });
    connection.on("error", () => {
      connection.destroy();
    });
  });

  pi.on("agent_start", (_event, ctx) => {
    running = true;
    ranSinceSettled = true;
    finalOutcome = undefined;
    lastStopReason = undefined;
    emitActivity();
    const name = ctx.sessionManager.getSessionName() ?? firstPromptTitle(ctx.sessionManager);
    if (name) emit({ type: "name", name });
  });
  pi.on("tool_execution_start", () => {
    activeTools += 1;
    emitActivity();
  });
  pi.on("tool_execution_end", () => {
    activeTools = Math.max(0, activeTools - 1);
    emitActivity();
  });
  pi.on("session_before_compact", () => {
    compacting = true;
    emitActivity();
  });
  pi.on("session_compact", () => {
    compacting = false;
    emitActivity();
  });
  pi.on("session_compact_failed", () => {
    compacting = false;
    emitActivity();
  });
  pi.on("ui_prompt_start", () => {
    awaitingPrompt = true;
    emitActivity();
  });
  pi.on("ui_prompt_end", () => {
    awaitingPrompt = false;
    emitActivity();
  });
  pi.on("input", () => emit({ type: "read" }));
  pi.on("message_end", event => {
    if (event.message.role === "assistant") lastStopReason = event.message.stopReason;
  });
  pi.on("agent_before_settle", event => {
    finalOutcome = event.outcome;
  });
  pi.on("agent_settled", () => {
    const outcome = !ranSinceSettled ? "aborted"
      : finalOutcome ?? (lastStopReason === "aborted" ? "aborted" : lastStopReason === "error" ? "error" : "completed");
    emit({ type: "settled", outcome });
    running = false;
    ranSinceSettled = false;
    compacting = false;
    awaitingPrompt = false;
    activeTools = 0;
    finalOutcome = undefined;
    lastStopReason = undefined;
  });
  pi.on("session_info_changed", (event, ctx) => {
    emit({ type: "name", name: event.name ?? firstPromptTitle(ctx.sessionManager) ?? null });
  });
  pi.on("session_shutdown", () => {
    socket?.destroy();
    socket = undefined;
    running = false;
    activeTools = 0;
  });
}
