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
  let lastError = false;

  const emit = (message: Record<string, unknown>) => {
    if (socket?.writable) socket.write(`${JSON.stringify(message)}\n`);
  };

  pi.on("session_start", (_event, ctx) => {
    socket?.destroy();
    lastError = false;
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
    lastError = false;
    emit({ type: "working" });
    const name = ctx.sessionManager.getSessionName() ?? firstPromptTitle(ctx.sessionManager);
    if (name) emit({ type: "name", name });
  });
  pi.on("message_end", event => {
    if (event.message.role === "assistant") lastError = event.message.stopReason === "error";
  });
  pi.on("agent_settled", () => emit({ type: "settled", error: lastError }));
  pi.on("session_info_changed", (event, ctx) => {
    emit({ type: "name", name: event.name ?? firstPromptTitle(ctx.sessionManager) ?? null });
  });
  pi.on("session_shutdown", () => {
    socket?.destroy();
    socket = undefined;
  });
}
