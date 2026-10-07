import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";

const MAX_REQUEST_BYTES = 1_000_000;
const SOCKET_DIR = `/tmp/pi-nvim-${process.getuid?.()}`;

function firstPromptTitle(manager: Pick<SessionManager, "getEntries">): string | undefined {
  for (const entry of manager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
    const request = text.match(/(?:^|\n)요청:\s*\n([\s\S]*)$/)?.[1] ?? text;
    const firstLine = request
      .split("\n")
      .find((line) => line.trim())
      ?.trim()
      .replace(/[\x00-\x1f\x7f]/g, " ");
    if (firstLine) return Array.from(firstLine).slice(0, 40).join("");
  }
  return undefined;
}

function ensureSocketDirectory(): void {
  fs.mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(SOCKET_DIR);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Pi 소켓 디렉터리가 안전하지 않습니다: ${SOCKET_DIR}`);
  }
}

export default function nvim(pi: ExtensionAPI): void {
  let server: net.Server | undefined;
  const clients = new Set<net.Socket>();
  let socketPath: string | undefined;
  let manifestPath: string | undefined;
  let cwd: string | undefined;
  let sessionId: string | undefined;
  let name: string | undefined;

  const cleanup = () => {
    process.off("exit", cleanup);
    for (const client of clients) client.destroy();
    clients.clear();
    server?.close();
    server = undefined;
    if (manifestPath) fs.rmSync(manifestPath, { force: true });
    if (socketPath) fs.rmSync(socketPath, { force: true });
    manifestPath = undefined;
    socketPath = undefined;
  };

  const publish = () => {
    if (!manifestPath || !cwd || !sessionId) return;
    const temporary = `${manifestPath}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ cwd, sessionId, pid: process.pid, name }), {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temporary, manifestPath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    cleanup();
    if (ctx.mode !== "tui") return;
    try {
      ensureSocketDirectory();
      cwd = fs.realpathSync(ctx.cwd);
      sessionId = ctx.sessionManager.getSessionId();
      name = ctx.sessionManager.getSessionName() ?? firstPromptTitle(ctx.sessionManager);
      const base = `${process.pid}-${randomBytes(6).toString("hex")}`;
      socketPath = path.join(SOCKET_DIR, `${base}.sock`);
      manifestPath = path.join(SOCKET_DIR, `${base}.json`);

      const listener = net.createServer((client) => {
        clients.add(client);
        client.on("close", () => clients.delete(client));
        client.on("error", () => client.destroy());
        client.setTimeout(5000, () => client.destroy());
        client.setEncoding("utf8");
        let input = "";
        const reply = (response: Record<string, unknown>) =>
          client.end(`${JSON.stringify(response)}\n`);
        client.on("data", (data: string) => {
          input += data;
          if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
            client.pause();
            reply({ ok: false, error: "요청이 너무 큽니다" });
            return;
          }
          const newline = input.indexOf("\n");
          if (newline < 0) return;
          const line = input.slice(0, newline);
          client.pause();
          try {
            const request: unknown = JSON.parse(line);
            if (typeof request !== "object" || request === null || !("type" in request)) {
              reply({ ok: false, error: "잘못된 요청입니다" });
              return;
            }
            if (request.type === "ping") {
              reply({ ok: true, cwd, sessionId, pid: process.pid, name });
            } else if (
              request.type === "prompt" &&
              "text" in request &&
              typeof request.text === "string" &&
              request.text.trim()
            ) {
              if (
                !("cwd" in request) ||
                request.cwd !== cwd ||
                !("sessionId" in request) ||
                request.sessionId !== sessionId
              ) {
                reply({ ok: false, error: "대상 Pi 세션이 변경됐습니다" });
                return;
              }
              pi.sendUserMessage(request.text, {
                deliverAs: "followUp",
                expandPromptTemplates: true,
              });
              reply({ ok: true });
            } else {
              reply({ ok: false, error: "잘못된 요청입니다" });
            }
          } catch (error) {
            reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        });
      });
      server = listener;
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(socketPath, () => {
          listener.off("error", reject);
          resolve();
        });
      });
      listener.on("error", (error) => ctx.ui.notify(`Pi 소켓 실패: ${error.message}`, "error"));
      fs.chmodSync(socketPath, 0o600);
      publish();
      process.on("exit", cleanup);
    } catch (error) {
      cleanup();
      ctx.ui.notify(`Pi 세션 연결 실패: ${String(error)}`, "error");
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    const next = ctx.sessionManager.getSessionName() ?? firstPromptTitle(ctx.sessionManager);
    if (next && next !== name) {
      name = next;
      publish();
    }
  });
  pi.on("session_info_changed", (event, ctx) => {
    name = event.name ?? firstPromptTitle(ctx.sessionManager);
    publish();
  });
  pi.on("session_shutdown", cleanup);
}
