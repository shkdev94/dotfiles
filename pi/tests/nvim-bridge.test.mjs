// 실행: node --test pi/tests/nvim-bridge.test.mjs (Node 22.18+)
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import nvim from "../extensions/nvim.ts";

const directory = `/tmp/pi-nvim-${process.getuid()}`;

function findOwnManifest(sessionId, before = new Set()) {
  if (!fs.existsSync(directory)) return undefined;
  return fs.readdirSync(directory).find((name) => {
    if (!name.endsWith(".json") || before.has(name)) return false;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(directory, name)));
      return (
        info.pid === process.pid &&
        info.sessionId === sessionId &&
        info.cwd === fs.realpathSync(process.cwd())
      );
    } catch {
      return false;
    }
  });
}

async function startBridge(t, mode = "tui") {
  const handlers = new Map();
  const sent = [];
  const cwd = fs.realpathSync(process.cwd());
  const ctx = {
    mode,
    cwd,
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionName: () => "테스트 Pi",
      getEntries: () => [],
    },
    ui: { notify: (message) => assert.fail(message) },
  };
  nvim({
    on: (name, handler) => handlers.set(name, handler),
    sendUserMessage: (message, options) => sent.push({ message, options }),
  });
  const before = new Set(fs.existsSync(directory) ? fs.readdirSync(directory) : []);
  await handlers.get("session_start")({}, ctx);
  t.after(() => handlers.get("session_shutdown")());
  const filename = findOwnManifest("test-session", before);
  return {
    cwd,
    sent,
    filename,
    handlers,
    ctx,
    socket: filename && path.join(directory, filename.replace(/\.json$/, ".sock")),
  };
}

function request(socket, command) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let input = "";
    client.setTimeout(3000, () => client.destroy(new Error("응답 시간 초과")));
    client.on("error", reject);
    client.on("data", (data) => {
      input += data.toString();
    });
    client.on("end", () => {
      try {
        resolve(JSON.parse(input));
      } catch (error) {
        reject(error);
      }
    });
    client.on("connect", () => client.write(JSON.stringify(command) + "\n"));
  });
}

function prompt(bridge, overrides = {}) {
  return {
    type: "prompt",
    text: "선택 코드 질문",
    cwd: bridge.cwd,
    sessionId: "test-session",
    ...overrides,
  };
}

test("등록된 Pi 세션에 질문을 보내면 같은 실행 프로세스의 후속 요청으로 전달한다", async (t) => {
  // 실행 중인 TUI 세션이 소켓을 공개한다.
  const bridge = await startBridge(t);
  const info = JSON.parse(fs.readFileSync(path.join(directory, bridge.filename)));

  const response = await request(bridge.socket, prompt(bridge));

  // 별도 Pi 실행 없이 현재 세션으로 컨텍스트를 전달한다.
  assert.equal(response.ok, true);
  assert.equal(info.cwd, bridge.cwd);
  assert.equal(fs.statSync(bridge.socket).mode & 0o777, 0o600);
  assert.deepEqual(bridge.sent, [
    {
      message: "선택 코드 질문",
      options: { deliverAs: "followUp", expandPromptTemplates: true },
    },
  ]);
});

for (const [name, fields] of [
  ["다른 디렉터리", { cwd: "/some-other-project" }],
  ["다른 세션", { sessionId: "other-session" }],
  ["빈 질문", { text: " " }],
]) {
  test(`${name} 요청은 전달하지 않는다`, async (t) => {
    // 탐색 이후 바뀐 대상이나 유효하지 않은 질문을 준비한다.
    const bridge = await startBridge(t);

    const response = await request(bridge.socket, prompt(bridge, fields));

    // 잘못된 대상에 부수효과가 생기지 않는다.
    assert.equal(response.ok, false);
    assert.deepEqual(bridge.sent, []);
  });
}

test("이름 변경은 탐색에 반영되고 세션 종료는 자신의 소켓만 정리한다", async (t) => {
  // 이름을 바꿀 수 있는 실행 중 세션을 준비한다.
  const bridge = await startBridge(t);
  await bridge.handlers.get("session_info_changed")({ name: "변경한 이름" }, bridge.ctx);

  const response = await request(bridge.socket, { type: "ping" });
  await bridge.handlers.get("session_shutdown")();

  // 조회 시 최신 이름을 반환하고 종료한 세션은 다시 발견되지 않는다.
  assert.equal(response.name, "변경한 이름");
  assert.equal(fs.existsSync(bridge.socket), false);
  assert.equal(fs.existsSync(path.join(directory, bridge.filename)), false);
});

test("세션을 바꾸면 이전 소켓을 없애고 종료 핸들러를 중복 등록하지 않는다", async (t) => {
  // 하나의 Pi 프로세스에서 세션을 전환한다.
  const bridge = await startBridge(t);
  const listeners = process.listenerCount("exit");
  bridge.ctx.sessionManager.getSessionId = () => "new-session";

  await bridge.handlers.get("session_start")({}, bridge.ctx);
  const filename = findOwnManifest("new-session");
  const response = await request(path.join(directory, filename.replace(/\.json$/, ".sock")), {
    type: "ping",
  });

  // 선택 전의 소켓은 무효화되고 새로운 세션만 탐색할 수 있다.
  assert.equal(response.sessionId, "new-session");
  assert.equal(fs.existsSync(bridge.socket), false);
  assert.equal(process.listenerCount("exit"), listeners);
});

test("RPC 하위 에이전트는 TUI 전송 대상으로 등록하지 않는다", async (t) => {
  // 자동 생성된 RPC 하위 에이전트는 사용자가 연 tmux TUI가 아니다.
  const bridge = await startBridge(t, "rpc");

  // 세션 시작 후 탐색 결과를 확인한다.
  assert.equal(bridge.filename, undefined);
  assert.deepEqual(bridge.sent, []);
});
