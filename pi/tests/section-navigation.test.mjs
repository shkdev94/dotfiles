// 실행: node --test pi/tests/section-navigation.test.mjs (Node 22.18+, 설치된 Pi 사용)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { SectionNavigation } from "../extensions/section-navigation/navigation.ts";

const binary = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const packageDir = process.env.PI_TEST_PACKAGE_DIR
  ?? path.resolve(path.dirname(realpathSync(binary)), "../lib/node_modules/pi-monorepo");
const load = relative => import(pathToFileURL(path.join(packageDir, relative)));
const kit = await load("node_modules/@earendil-works/pi-tui/dist/index.js");
const { renderLayoutFrame } = await load("node_modules/@earendil-works/pi-tui/dist/layout.js");
const { AssistantMessageComponent } = await load("dist/modes/interactive/components/assistant-message.js");
const { ToolExecutionComponent } = await load("dist/modes/interactive/components/tool-execution.js");
const { CustomEditor } = await load("dist/modes/interactive/components/custom-editor.js");
const { getEditorTheme, initTheme } = await load("dist/modes/interactive/theme/theme.js");
const { KeybindingsManager } = await load("dist/core/keybindings.js");
const { withBuiltInRenderers } = await load("dist/core/tools/renderers/index.js");
const { createChatViewport } = await load("dist/modes/interactive/chat-viewport.js");
const { createJiti } = await load("node_modules/jiti/lib/jiti.mjs");
const extension = await createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-tui": path.join(packageDir, "node_modules/@earendil-works/pi-tui/dist/index.js") },
}).import(fileURLToPath(new URL("../extensions/section-navigation/index.ts", import.meta.url)), { default: true });

class Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  output = [];
  start(input, resize) { this.input = input; this.resize = resize; }
  stop() {}
  async drainInput() {}
  write(data) { this.output.push(data); }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}

function assistant(content) {
  return { role: "assistant", content, api: "openai-responses", provider: "openai", model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    stopReason: "stop", timestamp: 1 };
}

function fixture(t, { install = false, regular = false } = {}) {
  initTheme("dark", false);
  kit.setKeybindings(KeybindingsManager.create());
  const terminal = new Terminal();
  const tui = regular ? new kit.TuiMainScreen(terminal) : new kit.TuiAltScreen(terminal);
  const header = new kit.Container();
  header.addChild(new kit.Text("Native Pi header", 0, 0));
  const resources = new kit.Container();
  const chat = new kit.Container();
  const document = new kit.Container();
  for (const child of [header, resources, chat]) document.addChild(child);
  const pending = new kit.Container();
  const status = new kit.Container();
  const above = new kit.Container();
  const editorRoot = new kit.Container();
  const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create());
  editor.setText("작성 중인 질문");
  const submitted = [];
  editor.onSubmit = text => submitted.push(text);
  editorRoot.addChild(editor);
  const below = new kit.Container();
  const footer = new kit.Container();
  const viewport = createChatViewport({ document, pendingMessages: pending, status, widgetsAbove: above,
    editor: editorRoot, widgetsBelow: below, footer, scrollbar: "always" });
  for (const child of [document, pending, status, above, editorRoot, below, footer]) tui.addChild(child);
  if (!regular) tui.setLayoutRoot(viewport.root);
  tui.setFocus(editor);
  const messages = [];
  const owners = [];
  const tools = [];
  for (const group of ["old", "new"]) {
    const message = assistant([
      { type: "thinking", thinking: Array.from({ length: 12 }, (_, i) => `THINK_${group}_${i}`).join("\n") },
      { type: "text", text: `ANSWER_${group}` },
    ]);
    messages.push(message);
    const owner = new AssistantMessageComponent(message, true);
    owners.push(owner);
    chat.addChild(owner);
    const tool = new ToolExecutionComponent("bash", `call_${group}`, { command: "synthetic only" }, {},
      withBuiltInRenderers("bash", {}), tui, "/tmp");
    tool.updateResult({ content: [{ type: "text", text: Array.from({ length: 40 }, (_, i) => `TOOL_${group}_${i}`).join("\n") }],
      details: { exitCode: 0 }, isError: false }, false);
    tools.push(tool);
    chat.addChild(tool);
    chat.addChild(new AssistantMessageComponent(assistant([{ type: "text", text: `FINAL_${group}` }])));
  }
  const notices = [];
  const handlers = new Map();
  let navigation;
  if (install) {
    extension({ on: (name, handler) => handlers.set(name, handler) });
    handlers.get("session_start")({}, { mode: "tui", ui: {
      setWidget: (_key, factory) => above.addChild(factory(tui, { fg: (_color, text) => text })),
      onTerminalInput: handler => tui.addInputListener(handler),
      notify: message => notices.push(message),
    } });
  } else navigation = new SectionNavigation(tui, message => notices.push(message));
  tui.start();
  t.after(() => {
    navigation?.dispose();
    handlers.get("session_shutdown")?.();
    tui.stop({ preserveScreen: true });
  });
  const flush = async () => {
    tui.renderNow();
    await Promise.resolve();
    tui.renderNow();
    await Promise.resolve();
  };
  const send = async command => { navigation.handle(command); await flush(); };
  const key = async data => { terminal.input(data); await flush(); };
  const text = () => stripVTControlCharacters(document.render(terminal.columns - 1).join("\n"));
  const highlighted = () => document.render(terminal.columns - 1).filter(line => line.includes("\x1b[7m"))
    .map(stripVTControlCharacters).join("\n");
  return { tui, terminal, viewport, document, chat, editor, header, messages, owners, tools, notices,
    navigation, handlers, submitted, flush, send, key, text, highlighted, above };
}

async function oldest(f) {
  await f.send("toggle");
  for (let i = 0; i < 7; i++) await f.send("previous");
}

test("최신 섹션부터 화면 순서대로 이동하고 양끝에서는 멈춘다", async t => {
  // 생각·답변·도구 결과가 두 번 반복되는 기존 Pi 화면을 준비한다.
  const f = fixture(t);
  await f.flush();

  await oldest(f);
  await f.send("previous");

  // 첫 생각 블록을 선택하며 질문 입력이나 제출에는 영향을 주지 않는다.
  assert.match(f.navigation.hint, /섹션 1\/8.*생각 블록/);
  assert.match(f.highlighted(), /Thinking/);
  assert.equal(f.editor.getText(), "작성 중인 질문");
  assert.deepEqual(f.submitted, []);
  const kinds = ["답변", "도구 결과", "답변", "생각 블록", "답변", "도구 결과", "답변"];
  for (const kind of kinds) {
    await f.send("next");
    assert.ok(f.navigation.hint.includes(kind));
  }
  await f.send("next");
  assert.match(f.navigation.hint, /섹션 8\/8/);
});

test("과거 생각 블록만 펼치고 접으며 다른 생각 블록과 기록은 보존한다", async t => {
  // 접힌 과거 생각 블록과 이후 생각 블록을 준비한다.
  const f = fixture(t);
  const messages = JSON.stringify(f.messages);
  await oldest(f);

  await f.send("activate");

  // 선택한 과거 내용만 나타나며 다른 생각과 원본 메시지는 변경되지 않는다.
  assert.ok(f.text().includes("THINK_old_11"));
  assert.ok(!f.text().includes("THINK_new_11"));
  assert.equal(JSON.stringify(f.messages), messages);
  await f.send("activate");
  assert.ok(!f.text().includes("THINK_old_11"));
  assert.match(f.navigation.hint, /섹션 1\/8/);
});

test("과거 도구 결과만 펼치고 접으며 도구를 실행하지 않는다", async t => {
  // 같은 종류의 도구 결과가 여러 개 있을 때 과거 결과를 선택한다.
  const f = fixture(t);
  await oldest(f);
  await f.send("next");
  await f.send("next");
  const newer = f.tools[1].render(79);

  await f.send("activate");

  // 선택한 로그만 확장하고 다른 도구 표시와 입력창은 그대로 둔다.
  assert.ok(f.text().includes("TOOL_old_10"));
  assert.deepEqual(f.tools[1].render(79), newer);
  assert.deepEqual(f.submitted, []);
  await f.send("activate");
  assert.ok(!f.text().includes("TOOL_old_10"));
});

test("일반 답변의 Enter는 제출하거나 별도 UI를 열지 않는다", async t => {
  // 펼치기 기능이 없는 일반 답변을 선택한다.
  const f = fixture(t);
  await f.send("toggle");
  const before = f.text();

  await f.send("activate");

  // 사용 가능한 펼치기 키를 표시하지 않고 답변 내용과 입력을 보존한다.
  assert.equal(f.text(), before);
  assert.ok(!f.navigation.hint.includes("Enter"));
  assert.deepEqual(f.submitted, []);
});

test("탐색 종료 후 선택 강조가 Markdown 캐시에 남지 않는다", async t => {
  // Pi Markdown은 렌더 결과를 캐시하므로 탐색 전 원본 출력을 보관한다.
  const f = fixture(t);
  const before = f.document.render(79);
  await f.send("toggle");
  assert.match(f.highlighted(), /FINAL_new/);

  await f.send("exit");

  // 캐시를 다시 사용해도 강조나 안내가 남지 않는다.
  assert.deepEqual(f.document.render(79), before);
  assert.equal(f.navigation.hint, undefined);
  assert.equal(f.navigation.active, false);
});

test("다른 확장이 선택 렌더러를 감싸도 종료 후 그 변경을 보존하고 강조는 해제한다", async t => {
  // 탐색 시작 후 다른 확장이 같은 답변의 렌더 함수를 감싸는 상황을 준비한다.
  const f = fixture(t);
  await f.send("toggle");
  const answer = f.chat.children.at(-1).children[0].children.find(child => child.constructor.name === "Markdown");
  const original = answer.render;
  const external = function (width) { return original.call(this, width); };
  answer.render = external;

  await f.send("exit");

  // 다른 확장의 함수는 되돌리지 않으며 내부에 남은 탐색 어댑터도 강조하지 않는다.
  assert.equal(answer.render, external);
  assert.equal(f.highlighted(), "");
});

test("생각 블록이 스트리밍으로 재생성돼도 선택과 개별 상호작용을 유지한다", async t => {
  // 생각 블록을 선택한 상태에서 Pi가 메시지 컴포넌트를 갱신한다.
  const f = fixture(t);
  await oldest(f);
  const updated = assistant([{ type: "thinking", thinking: "STREAMED_THINKING" }, { type: "text", text: "STREAMED_ANSWER" }]);

  f.owners[0].updateContent(updated, true);
  await f.flush();
  await f.send("activate");

  // 이전 컴포넌트 참조가 아니라 재생성된 같은 섹션을 펼친다.
  assert.match(f.navigation.hint, /섹션 1\/8.*생각 블록/);
  assert.match(f.highlighted(), /STREAMED_THINKING/);
  assert.equal(f.document.render(79).filter(line => line.includes("\x1b[7m")).length, 1);
});

test("새 출력이 추가돼도 선택한 최신 답변에서 자동으로 벗어나지 않는다", async t => {
  // 탐색 시작 위치가 화면 끝인 상황에서 후속 출력이 추가된다.
  const f = fixture(t);
  await f.send("toggle");
  const top = f.viewport.transcript.scrollTop;

  f.chat.addChild(new AssistantMessageComponent(assistant([{ type: "text", text: "NEXT_OUTPUT\n".repeat(30) }])));
  await f.flush();

  // 결과 목록은 늘어나지만 기존 선택과 스크롤 위치는 유지한다.
  assert.match(f.navigation.hint, /섹션 8\/9/);
  assert.match(f.highlighted(), /FINAL_new/);
  assert.equal(f.viewport.transcript.scrollTop, top);
  assert.equal(f.viewport.transcript.isFollowingEnd, false);
});

test("터미널 크기가 바뀌면 실제 줄바꿈 기준으로 선택 위치를 다시 계산한다", async t => {
  // 긴 헤더 때문에 폭 변화가 과거 섹션의 위치를 바꾸도록 준비한다.
  const f = fixture(t);
  f.header.addChild(new kit.Text("긴 헤더와 한글 문자가 여러 줄로 감기는 환경 ".repeat(6), 0, 0));
  await oldest(f);

  f.terminal.columns = 24;
  f.terminal.rows = 16;
  await f.flush();

  // 좁은 화면에서도 첫 생각 섹션이 선택되고 렌더 행이 폭을 넘지 않는다.
  assert.match(f.navigation.hint, /섹션 1\/8/);
  const frame = renderLayoutFrame(f.viewport.root, 24, 16, () => {});
  assert.ok(frame.lines.every(line => kit.visibleWidth(line) <= 24));
  assert.ok(frame.lines.some(line => line.includes("\x1b[7m")));
  assert.deepEqual(f.notices, []);
});

test("다른 UI가 포커스를 받으면 탐색을 끝내고 키를 가로채지 않는다", async t => {
  // 기존 입력창 대신 선택 팝업이 키보드를 소유하게 한다.
  const f = fixture(t);
  await f.send("toggle");
  const popup = { render: () => ["POPUP"], invalidate() {}, handleInput() {} };

  const overlay = f.tui.showOverlay(popup);
  await f.flush();

  // 선택 UI를 방해하거나 과거 도구 결과를 조작하지 않는다.
  assert.equal(f.navigation.active, false);
  assert.equal(f.navigation.handle("previous"), false);
  assert.equal(f.highlighted(), "");
  overlay.hide();
});

test("결과 영역이 비면 탐색을 해제하고 빈 목록에서 키를 가로채지 않는다", async t => {
  // 새 세션이나 대화 재구성으로 탐색 대상이 사라지는 상황을 준비한다.
  const f = fixture(t);
  await f.send("toggle");

  f.chat.clear();
  await f.flush();

  // 사라진 컴포넌트를 조작하지 않고 입력 모드로 안전하게 돌아간다.
  assert.equal(f.navigation.active, false);
  assert.equal(f.navigation.handle("activate"), false);
  assert.equal(f.navigation.hint, undefined);
});

test("종료·재로드 시 렌더러를 복구하고 예약된 스크롤을 취소한다", async t => {
  // 렌더 직후 아직 실행되지 않은 스크롤 예약이 있는 상태를 준비한다.
  const f = fixture(t);
  f.navigation.handle("toggle");
  f.tui.renderNow();
  const top = f.viewport.transcript.scrollTop;

  f.navigation.dispose();
  f.navigation.dispose();
  await Promise.resolve();

  // 종료를 반복해도 이전 UI를 갱신하거나 선택 스타일을 남기지 않는다.
  assert.equal(f.viewport.transcript.scrollTop, top);
  assert.equal(f.highlighted(), "");
  assert.equal(f.navigation.handle("toggle"), false);
});

test("실제 확장의 F6·화살표·Enter·Esc는 작성 중인 입력을 보존한다", async t => {
  // 실제 확장 등록과 Pi의 터미널 입력 경로를 함께 사용한다.
  const f = fixture(t, { install: true });
  await f.flush();

  await f.key("\x1b[17~");
  for (let i = 0; i < 7; i++) await f.key("\x1b[A");
  await f.key("\r");

  // 키보드로 선택한 과거 생각을 펼치되 입력 제출은 발생하지 않는다.
  assert.ok(f.text().includes("THINK_old_11"));
  assert.ok(f.above.render(80).join("").includes("섹션 1/8"));
  assert.deepEqual(f.submitted, []);
  await f.key("\x1b");
  assert.equal(f.above.render(80).length, 0);
  assert.equal(f.editor.getText(), "작성 중인 질문");
  assert.equal(f.highlighted(), "");
});

test("마우스로 개별 생각 블록을 클릭하는 기존 동작도 탐색 중에 유지한다", async t => {
  // 탐색이 기존 마우스 핸들러를 교체하지 않는지 실제 입력 경로로 확인한다.
  const f = fixture(t, { install: true });
  await f.flush();
  await f.key("\x1b[17~");
  for (let i = 0; i < 7; i++) await f.key("\x1b[A");

  await f.key("\x1b[<0;3;1M");
  await f.key("\x1b[<0;3;1m");

  // 선택한 생각을 마우스로 펼치며 키보드 선택과 작성 중인 입력은 보존한다.
  assert.ok(f.text().includes("THINK_old_11"));
  assert.ok(f.above.render(80).join("").includes("섹션 1/8"));
  assert.equal(f.editor.getText(), "작성 중인 질문");
});

test("키를 놓는 Kitty 이벤트는 펼치기를 중복 실행하지 않는다", async t => {
  // 실제 확장에 키 누름과 해제 이벤트가 별도로 전달되는 터미널을 준비한다.
  const f = fixture(t, { install: true });
  await f.flush();
  await f.key("\x1b[17~");
  for (let i = 0; i < 7; i++) await f.key("\x1b[A");
  await f.key("\r");

  await f.key("\x1b[13;1:3u");

  // Enter 해제는 열린 생각을 다시 접거나 입력 모드로 전환하지 않는다.
  assert.ok(f.text().includes("THINK_old_11"));
  assert.ok(f.above.render(80).join("").includes("섹션 1/8"));
  assert.deepEqual(f.submitted, []);
});

test("regular 모드에서는 결과 화면을 변경하지 않고 fullscreen 안내만 표시한다", async t => {
  // 터미널이 scrollback을 소유하는 기존 모드를 준비한다.
  const f = fixture(t, { regular: true });
  await f.flush();

  await f.send("toggle");

  // 지원하지 않는 화면에서는 입력이나 터미널 기록을 조작하지 않는다.
  assert.equal(f.navigation.active, false);
  assert.match(f.notices[0], /fullscreen/);
  assert.equal(f.highlighted(), "");
});

test("Pi 결과 트리가 변경되면 경고하고 탐색을 중지한다", async t => {
  // Pi 업데이트로 결과 컨테이너 계약이 바뀌는 상황을 준비한다.
  const f = fixture(t);
  await f.send("toggle");

  f.document.children[2] = new kit.Text("변경된 결과 화면", 0, 0);
  await f.flush();

  // 전체 TUI를 실패시키거나 알 수 없는 컴포넌트를 조작하지 않는다.
  assert.equal(f.navigation.active, false);
  assert.match(f.notices[0], /구조가 변경/);
  assert.equal(f.navigation.handle("activate"), false);
});

test("탐색 중 일반 입력·붙여넣기는 탐색을 끝내고 기존 입력창에 전달한다", async t => {
  // 탐색 모드에서 텍스트를 입력하는 흐름을 준비한다.
  const f = fixture(t, { install: true });
  await f.flush();
  await f.key("\x1b[17~");

  await f.key("!");
  await f.key("\x1b[200~ 붙여넣기\x1b[201~");

  // 텍스트를 잃지 않으며 이후 Enter는 기존 입력 제출로 동작한다.
  assert.equal(f.editor.getText(), "작성 중인 질문! 붙여넣기");
  assert.equal(f.above.render(80).length, 0);
  await f.key("\r");
  assert.deepEqual(f.submitted, ["작성 중인 질문! 붙여넣기"]);
});
