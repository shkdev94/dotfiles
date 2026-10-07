// 실행: node --test nvim/tests/pi_bridge.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const runtime = path.resolve("nvim");
const directory = `/tmp/pi-nvim-${process.getuid()}`;
const { stdout: dataDirectory } = await run("nvim", [
  "--headless",
  "-u",
  "NONE",
  "+lua io.stdout:write(vim.fn.stdpath('data'))",
  "+qa",
]);
const snacks = path.join(dataDirectory, "site/pack/core/opt/snacks.nvim");
assert.ok(fs.existsSync(snacks), "Neovim에 설정된 snacks.nvim 설치가 필요합니다");

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/pi-client-test-"));
  const endpoints = [];
  const file = path.join(root, "sample.lua");
  fs.writeFileSync(file, "saved line\n");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  t.after(async () => {
    for (const endpoint of endpoints) {
      await new Promise((resolve) => endpoint.server.close(resolve));
      fs.rmSync(endpoint.manifest, { force: true });
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function addSession({ cwd = root, name = "테스트 세션", valid = true } = {}) {
    const pid = process.pid + endpoints.length;
    const id = randomBytes(6).toString("hex");
    const base = path.join(directory, `${pid}-${id}`);
    const prompts = [];
    const requests = [];
    const server = net.createServer((client) => {
      let input = "";
      client.on("error", () => client.destroy());
      client.on("data", (data) => {
        input += data;
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        client.pause();
        const message = JSON.parse(input.slice(0, newline));
        requests.push(message);
        if (message.type === "prompt") prompts.push(message);
        client.end(
          JSON.stringify(
            message.type === "ping"
              ? { ok: true, cwd, sessionId: valid ? id : "changed-session", pid, name }
              : { ok: true },
          ) + "\n",
          () => client.destroy(),
        );
      });
    });
    await new Promise((resolve) => server.listen(base + ".sock", resolve));
    const manifest = base + ".json";
    fs.writeFileSync(manifest, JSON.stringify({ cwd, sessionId: id, pid, name }), { mode: 0o600 });
    const endpoint = { server, manifest, prompts, requests, pid, id };
    endpoints.push(endpoint);
    return endpoint;
  }

  async function nvim(script) {
    const filename = path.join(root, "check.lua");
    fs.writeFileSync(
      filename,
      `
vim.opt.runtimepath:prepend(${JSON.stringify(runtime)})
vim.opt.runtimepath:append(${JSON.stringify(snacks)})
require('snacks')
vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(file)}))
vim.api.nvim_buf_set_lines(0, 0, -1, false, {'unsaved first', 'unsaved second'})
local pi = require('pi')
${script}
`,
    );
    await run("nvim", ["--headless", "-u", "NONE", "-l", filename], {
      cwd: root,
      timeout: 10000,
      env: {
        ...process.env,
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
      },
    });
  }
  return { root, addSession, nvim };
}

const waitForPicker = `
local function wait_for_picker()
  local picker
  assert(vim.wait(5000, function()
    picker = Snacks.picker.get({ source = 'pi_prompt' })[1]
    return picker and picker.list.win:valid() and picker.input.win:valid() and picker.list:count() == 2
  end, 10), '질문 입력칸과 세션 목록이 나타나지 않았다')
  return picker
end
`;

const awaitDelivery = `
local delivered = 0
vim.notify = function(message, level)
  assert(level ~= vim.log.levels.ERROR, message)
  if message:find('세션으로 요청을') then delivered = delivered + 1 end
end
vim.ui.input = function(_, callback) callback('코드 질문') end
`;

test("같은 디렉터리의 여러 Pi는 전송할 때마다 선택하고 선택한 세션만 받는다", async (t) => {
  // 같은 프로젝트에 Pi 두 개가 실행 중이다.
  const env = await fixture(t);
  const first = await env.addSession({ name: "첫 번째 Pi" });
  const second = await env.addSession({ name: "두 번째 Pi" });

  // 질문을 입력하면서 목록에서 둘째 세션을 고르고, 다음 질문은 첫째 세션으로 보낸다.
  await env.nvim(
    awaitDelivery +
      waitForPicker +
      `
vim.ui.select = function() error('별도 세션 선택창을 열면 안 된다') end
vim.ui.input = function() error('별도 질문 입력창을 열면 안 된다') end
pi.ask()
local picker = wait_for_picker()
local input_row = vim.api.nvim_win_get_position(picker.input.win.win)[1]
local list_row = vim.api.nvim_win_get_position(picker.list.win.win)[1]
assert(input_row < list_row, '질문 입력칸은 목록 위에 있어야 한다')
picker.input:set('세션 이름과 전혀 다른 질문 ^ | ! : 테스트')
picker:find({ refresh = false })
assert(picker.list:count() == 2, '질문으로 세션 목록을 검색하면 안 된다')
picker:action('list_down')
assert(picker.input:get() == '세션 이름과 전혀 다른 질문 ^ | ! : 테스트')
picker:action('confirm')
assert(vim.wait(5000, function() return delivered == 1 end, 10))
pi.ask()
picker = wait_for_picker()
assert(picker.input:get() == '', '새 질문은 빈 입력칸으로 시작한다')
picker.input:set('다음 코드 질문')
picker:action('confirm')
assert(vim.wait(5000, function() return delivered == 2 end, 10))
`,
  );

  // 선택을 임의로 고정하지 않으며 저장 전 전체 파일이 각각 전달된다.
  assert.equal(first.prompts.length, 1);
  assert.equal(second.prompts.length, 1);
  assert.match(first.prompts[0].text, /unsaved first\nunsaved second/);
  assert.equal(first.prompts[0].cwd, env.root);
  assert.equal(second.prompts[0].sessionId, second.id);
});

test("대상 디렉터리에 유효한 Pi 하나만 있으면 다른 프로젝트·바뀐 세션은 제외한다", async (t) => {
  // 다른 디렉터리와 이미 세션이 바뀐 소켓도 함께 등록돼 있다.
  const env = await fixture(t);
  const live = await env.addSession();
  const changed = await env.addSession({ valid: false });
  const foreign = await env.addSession({ cwd: env.root + "/other-project" });

  await env.nvim(
    awaitDelivery +
      `
vim.ui.select = function() error('유효한 세션은 하나뿐이다') end
pi.ask()
assert(vim.wait(5000, function() return delivered == 1 end, 10))
`,
  );

  // 한 개의 유효한 대상에만 자동 전송한다.
  assert.equal(live.prompts.length, 1);
  assert.equal(changed.prompts.length, 0);
  assert.equal(foreign.requests.length, 0);
});

test("현재 디렉터리에 Pi가 없으면 다른 프로젝트로 전송하지 않는다", async (t) => {
  // 다른 프로젝트의 Pi만 실행 중이다.
  const env = await fixture(t);
  const foreign = await env.addSession({ cwd: env.root + "/other-project" });

  await env.nvim(`
local warned = false
vim.notify = function(message, level)
  assert(level == vim.log.levels.WARN)
  warned = message:find('현재 디렉터리') ~= nil
end
vim.ui.input = function() error('입력창을 열면 안 된다') end
pi.ask()
assert(warned)
`);

  // 대상 부재를 알리고 다른 프로젝트는 조회·전송하지 않는다.
  assert.equal(foreign.requests.length, 0);
});

test("질문 작성 중 취소하면 어느 세션에도 전송하지 않는다", async (t) => {
  // 선택이 필요한 세션 두 개를 준비한다.
  const env = await fixture(t);
  const first = await env.addSession();
  const second = await env.addSession();

  await env.nvim(
    waitForPicker +
      `
pi.ask()
local picker = wait_for_picker()
picker.input:set('작성하다 취소한 질문')
picker:action('list_down')
picker:action('close')
assert(picker.closed)
`,
  );

  // 선택 취소는 어느 Pi에도 요청을 남기지 않는다.
  assert.equal(first.prompts.length, 0);
  assert.equal(second.prompts.length, 0);
});

test("빈 질문은 전송하지 않고 입력창에서 계속 작성할 수 있다", async (t) => {
  // 입력 오류를 고친 뒤 같은 창에서 전송할 수 있어야 한다.
  const env = await fixture(t);
  const first = await env.addSession();
  const second = await env.addSession();

  await env.nvim(
    awaitDelivery +
      waitForPicker +
      `
local warning = false
local notify = vim.notify
vim.notify = function(message, level)
  if message:find('질문을 입력해 주세요') then warning = true else notify(message, level) end
end
pi.ask()
local picker = wait_for_picker()
picker.input:set('   ')
picker:action('confirm')
assert(warning and not picker.closed)
picker.input:set('빈 질문을 고친 요청')
picker:action('confirm')
assert(vim.wait(5000, function() return delivered == 1 end, 10))
`,
  );

  // 빈 질문은 요청을 만들지 않으며 수정한 질문만 한 번 전달한다.
  assert.equal(first.prompts.length, 1);
  assert.match(first.prompts[0].text, /^빈 질문을 고친 요청/);
  assert.equal(second.prompts.length, 0);
});

test("Visual 진단 질문은 입력창이 아닌 원래 선택 코드와 진단을 보낸다", async (t) => {
  // 선택 영역 안팎의 진단이 있는 파일과 Pi 두 개를 준비한다.
  const env = await fixture(t);
  const first = await env.addSession();
  const second = await env.addSession();

  await env.nvim(
    awaitDelivery +
      waitForPicker +
      `
local ns = vim.api.nvim_create_namespace('pi-prompt-diagnostics')
vim.diagnostic.set(ns, 0, {
  { lnum = 1, col = 0, end_col = 10, severity = vim.diagnostic.severity.WARN, message = 'selected-warning' },
  { lnum = 0, col = 0, end_col = 10, severity = vim.diagnostic.severity.ERROR, message = 'outside-error' },
})
vim.cmd('normal! 2GV')
pi.ask(nil, true)
local picker = wait_for_picker()
picker.input:set('이 경고를 고쳐줘')
picker:action('list_down')
picker:action('confirm')
assert(vim.wait(5000, function() return delivered == 1 end, 10))
`,
  );

  // 질문 창을 연 뒤에도 원본 선택 범위와 해당 경고만 전달한다.
  assert.equal(first.prompts.length, 0);
  assert.equal(second.prompts.length, 1);
  assert.match(second.prompts[0].text, /unsaved second/);
  assert.match(second.prompts[0].text, /selected-warning/);
  assert.doesNotMatch(second.prompts[0].text, /unsaved first|outside-error/);
});

test("닫힌 질문 창을 picker 재개로 다시 열어도 이전 요청을 재전송하지 않는다", async (t) => {
  // 질문 창의 전송 콜백으로 실행 횟수를 관찰한다.
  const env = await fixture(t);

  await env.nvim(
    waitForPicker +
      `
local sent = 0
require('pi.prompt').open({
  { id = 'first-session', pid = 1, name = '첫째' },
  { id = 'second-session', pid = 2, name = '둘째' },
}, function() sent = sent + 1 end)
local picker = wait_for_picker()
picker.input:set('한 번만 보낼 요청')
picker:action('confirm')
assert(sent == 1)
Snacks.picker.resume({ source = 'pi_prompt' })
picker = wait_for_picker()
picker:action('confirm')

-- 종료한 입력 화면은 이전 프로젝트의 요청을 다시 전송할 수 없다.
assert(picker.closed and sent == 1)
`,
  );
});
