local M = {}

function M.open(sessions, callback)
  if #sessions == 1 then
    vim.ui.input({ prompt = "Pi: " }, function(question)
      if question and question:match("%S") then
        callback(sessions[1], question)
      end
    end)
    return
  end

  local items = {}
  for _, session in ipairs(sessions) do
    items[#items + 1] = {
      session = session,
      text = string.format(
        "%s · PID %d · %s",
        (session.name or "새 세션"):gsub("%c", " "),
        session.pid,
        session.id:sub(1, 8)
      ),
    }
  end

  local closed = false
  return require("snacks").picker({
    source = "pi_prompt",
    title = "Pi 질문 · ↑↓ 세션 선택 · Enter 전송 · Esc 취소",
    prompt = "질문: ",
    items = items,
    format = "text",
    focus = "input",
    live = false,
    auto_confirm = false,
    matcher = { sort_empty = false },
    layout = { preset = "vscode", layout = { height = math.min(#items + 4, 14) } },
    filter = {
      transform = function(_, filter)
        -- 입력값은 질문이며, 세션 목록의 검색·정렬 조건이 아니다.
        filter.pattern = ""
        filter.search = ""
      end,
    },
    config = function(opts)
      local keys = {
        ["<CR>"] = { "confirm", mode = { "n", "i" } },
        ["<Esc>"] = { "close", mode = { "n", "i" } },
        ["<C-c>"] = { "close", mode = { "n", "i" } },
        ["<Down>"] = { "list_down", mode = { "n", "i" } },
        ["<Up>"] = { "list_up", mode = { "n", "i" } },
        ["<Tab>"] = { "list_down", mode = { "n", "i" } },
        ["<S-Tab>"] = { "list_up", mode = { "n", "i" } },
        ["<C-n>"] = { "list_down", mode = { "n", "i" } },
        ["<C-p>"] = { "list_up", mode = { "n", "i" } },
      }
      opts.win.input.keys = keys
      opts.win.list.keys = vim.tbl_extend("force", keys, {
        i = "focus_input",
        j = "list_down",
        k = "list_up",
        q = "close",
      })
      return opts
    end,
    on_show = function(picker)
      vim.api.nvim_win_call(picker.input.win.win, vim.fn.clearmatches)
    end,
    on_close = function()
      closed = true
    end,
    confirm = function(picker, item)
      -- 다른 picker처럼 재개하더라도 이전 요청의 컨텍스트를 다시 보내지 않는다.
      if closed then
        picker:close()
        return
      end
      local question = picker.input:get()
      if not question:match("%S") then
        vim.notify("Pi: 질문을 입력해 주세요", vim.log.levels.WARN)
        return
      end
      if not item then
        return
      end
      picker:close()
      callback(item.session, question)
    end,
  })
end

return M
