-- 실행: nvim --headless -u NONE -l nvim/tests/pi_context.lua
vim.opt.runtimepath:prepend(vim.fn.getcwd() .. "/nvim")
local context = require("pi.context")
local passed = 0

local function test(name, body)
  vim.cmd("normal! \27")
  vim.api.nvim_buf_set_lines(0, 0, -1, false, { "first", "second", "third", "fourth" })
  vim.api.nvim_win_set_cursor(0, { 2, 0 })
  vim.diagnostic.reset()
  body()
  passed = passed + 1
  print("OK: " .. name)
end

local function contains(text, expected)
  assert(text:find(expected, 1, true), expected .. "가 없습니다: " .. text)
end

local function excludes(text, unexpected)
  assert(not text:find(unexpected, 1, true), unexpected .. "가 포함됐습니다: " .. text)
end

vim.api.nvim_buf_set_name(0, "/tmp/pi-context-test.lua")
local buffer_path = vim.api.nvim_buf_get_name(0)

test("일반 모드 질문은 저장 전 파일 전체를 포함한다", function()
  -- 저장하지 않은 버퍼의 모든 줄이 질문 대상이다.
  local result = context.capture(nil, false, true)

  -- 커서 주변 일부가 아닌 파일 전체를 보낸다.
  contains(result, "Neovim 현재 파일: " .. buffer_path)
  contains(result, "first\nsecond\nthird\nfourth")
end)

test("Visual 모드 질문은 선택 영역만 포함한다", function()
  -- 둘째 줄부터 셋째 줄까지 선택한다.
  vim.cmd("normal! 2GVj")

  local result = context.capture(nil, false, true)

  -- 선택하지 않은 파일 내용은 질문에 섞이지 않는다.
  contains(result, "second\nthird")
  excludes(result, "first")
  excludes(result, "fourth")
end)

test("일반 모드 진단 질문은 커서와 겹친 오류·경고만 포함한다", function()
  -- 커서 줄의 오류와 다른 줄의 경고를 준비한다.
  local namespace = vim.api.nvim_create_namespace("pi-context-tests")
  vim.diagnostic.set(namespace, 0, {
    {
      lnum = 1,
      col = 0,
      end_col = 3,
      severity = vim.diagnostic.severity.ERROR,
      message = "cursor-error",
    },
    {
      lnum = 3,
      col = 0,
      end_col = 3,
      severity = vim.diagnostic.severity.WARN,
      message = "other-warning",
    },
    {
      lnum = 1,
      col = 0,
      end_col = 3,
      severity = vim.diagnostic.severity.INFO,
      message = "info-only",
    },
  })

  local result = context.capture(nil, true, false)

  -- 기존 pd 동작대로 현재 위치와 관련 오류·경고만 보낸다.
  contains(result, "Neovim 현재 위치: " .. buffer_path .. ":2:1")
  contains(result, "cursor-error")
  excludes(result, "other-warning")
  excludes(result, "info-only")
  excludes(result, "first\nsecond")
end)

test("Visual 진단 질문은 선택 범위와 겹친 진단만 포함한다", function()
  -- 둘째 줄을 선택하고 그 안팎에 진단을 준비한다.
  local namespace = vim.api.nvim_create_namespace("pi-context-tests")
  vim.diagnostic.set(namespace, 0, {
    {
      lnum = 1,
      col = 0,
      end_col = 3,
      severity = vim.diagnostic.severity.WARN,
      message = "selected-warning",
    },
    {
      lnum = 3,
      col = 0,
      end_col = 3,
      severity = vim.diagnostic.severity.ERROR,
      message = "outside-error",
    },
  })
  vim.cmd("normal! 2GV")

  local result = context.capture(nil, true, false)

  -- 선택한 코드와 선택 범위의 진단을 함께 보낸다.
  contains(result, "second")
  contains(result, "selected-warning")
  excludes(result, "outside-error")
end)

print(string.format("Pi context: %d tests passed", passed))
