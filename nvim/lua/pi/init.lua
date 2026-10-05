local uv = vim.uv
local context = require("pi.context")

local M = {}
local projects = {}
local command = "pi"
local socket_number = 0
local spinner_frames = { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" }

local function notify(message, level)
  vim.notify("Pi: " .. message, level or vim.log.levels.WARN)
end

local function current_directory()
  local cwd = vim.fn.getcwd()
  return uv.fs_realpath(cwd) or cwd
end

local function state_directory()
  local path = vim.fn.stdpath("state") .. "/pi"
  vim.fn.mkdir(path, "p", "0700")
  return path
end

local function state_path(cwd)
  return state_directory() .. "/" .. vim.fn.sha256(cwd) .. ".json"
end

local function active_tab(project)
  for _, tab in ipairs(project.tabs) do
    if tab.id == project.selected_id then
      return tab
    end
  end
end

local function save(project)
  local tabs = {}
  for _, tab in ipairs(project.tabs) do
    tabs[#tabs + 1] =
      { id = tab.id, title = tab.title, session_file = tab.session_file, unread = tab.unread }
  end
  local path = state_path(project.cwd)
  local temporary = path .. "." .. uv.os_getpid() .. ".tmp"
  local ok, err = pcall(function()
    vim.fn.writefile({
      vim.json.encode({
        version = 1,
        cwd = project.cwd,
        selected_id = project.selected_id,
        tabs = tabs,
      }),
    }, temporary)
    assert(vim.fn.rename(temporary, path) == 0, "상태 파일을 교체할 수 없습니다")
  end)
  if not ok then
    notify("세션 목록 저장 실패: " .. tostring(err), vim.log.levels.ERROR)
  end
end

local function load(cwd)
  local project = {
    cwd = cwd,
    tabs = {},
    selected_id = nil,
    frame_index = 1,
  }
  local path = state_path(cwd)
  if vim.fn.filereadable(path) == 0 then
    return project
  end
  local ok, record = pcall(function()
    return vim.json.decode(table.concat(vim.fn.readfile(path), "\n"))
  end)
  if
    not ok
    or type(record) ~= "table"
    or record.version ~= 1
    or record.cwd ~= cwd
    or type(record.tabs) ~= "table"
  then
    notify("저장된 세션 목록을 읽을 수 없습니다: " .. path)
    return project
  end
  local seen = {}
  for _, item in ipairs(record.tabs) do
    if
      type(item) == "table"
      and type(item.id) == "string"
      and item.id:match("^[%w._-]+$")
      and not seen[item.id]
    then
      seen[item.id] = true
      project.tabs[#project.tabs + 1] = {
        id = item.id,
        title = type(item.title) == "string" and item.title or "새 세션",
        session_file = type(item.session_file) == "string" and item.session_file or nil,
        status = "대기",
        unread = item.unread == true,
        pending = {},
      }
    end
  end
  local selected = record.selected_id
  project.selected_id = seen[selected] and selected or project.tabs[1] and project.tabs[1].id
  return project
end

local function new_id()
  return (
    uv.random(16):gsub(".", function(char)
      return string.format("%02x", char:byte())
    end)
  )
end

local function add_tab(project)
  local tab = {
    id = new_id(),
    title = "새 세션 " .. (#project.tabs + 1),
    status = "대기",
    unread = false,
    pending = {},
  }
  project.tabs[#project.tabs + 1] = tab
  project.selected_id = tab.id
  save(project)
  return tab
end

local function is_window(win)
  return win and vim.api.nvim_win_is_valid(win)
end

local function truncate(value, width)
  if vim.fn.strdisplaywidth(value) <= width then
    return value
  end
  if width <= 1 then
    return "…"
  end
  local result = ""
  for index = 0, vim.fn.strchars(value) - 1 do
    local char = vim.fn.strcharpart(value, index, 1)
    if vim.fn.strdisplaywidth(result .. char .. "…") > width then
      break
    end
    result = result .. char
  end
  return result .. "…"
end

local function session_status(tab, frame)
  if tab.status == "작업 중" then
    local phase = tab.phase == "retry" and "↻"
      or tab.phase == "tool" and "⚙"
      or tab.phase == "compaction" and "◌"
      or ""
    return phase .. frame, "DiagnosticInfo"
  end
  if tab.status == "입력 필요" then
    return "◉", "DiagnosticWarn"
  end
  if tab.status == "오류" then
    return "!", "DiagnosticError"
  end
  if tab.status == "시작 중" then
    return "…", "Comment"
  end
  if tab.status == "종료" then
    return "□", "Comment"
  end
  if tab.unread then
    return "✓", "DiagnosticOk"
  end
  return "○", "Comment"
end

local title_status_groups = {
  DiagnosticInfo = "PiStatusInfo",
  DiagnosticWarn = "PiStatusWarn",
  DiagnosticError = "PiStatusError",
  DiagnosticOk = "PiStatusOk",
  Comment = "PiSectionBorder",
}

local function session_title(project, width)
  local prefix_width = vim.fn.strdisplaywidth("[1]─Session  ")
  local available = math.max(1, width - prefix_width - 2)
  local selected_index = 1
  local items = {}
  for index, tab in ipairs(project.tabs) do
    if tab.id == project.selected_id then
      selected_index = index
    end
    local status, highlight = session_status(tab, spinner_frames[project.frame_index])
    local number = string.format("%d. ", index)
    local title_width =
      math.max(1, math.min(22, available - vim.fn.strdisplaywidth(number .. " " .. status) - 4))
    local label = number .. truncate(tab.title, title_width)
    items[index] = {
      label = label,
      status = " " .. status,
      status_group = title_status_groups[highlight],
      width = vim.fn.strdisplaywidth(label .. " " .. status),
    }
  end

  local function range_width(first, last)
    local used = (first > 1 and 2 or 0) + (last < #items and 2 or 0)
    for index = first, last do
      used = used + items[index].width + (index > first and 3 or 0)
    end
    return used
  end

  local first = 1
  while first < selected_index and range_width(first, selected_index) > available do
    first = first + 1
  end
  local last = selected_index
  while last < #items and range_width(first, last + 1) <= available do
    last = last + 1
  end
  while first > 1 and range_width(first - 1, last) <= available do
    first = first - 1
  end

  local title = {
    { "[1]─", "PiSectionBorder" },
    { "Session", "PiSectionTitle" },
    { "  ", "PiSectionBorder" },
  }
  if first > 1 then
    title[#title + 1] = { "‹ ", "PiSectionBorder" }
  end
  for index = first, last do
    if index > first then
      title[#title + 1] = { " · ", "PiSectionBorder" }
    end
    local item = items[index]
    title[#title + 1] = {
      item.label,
      index == selected_index and "PiSectionTitle" or "PiSectionBorder",
    }
    title[#title + 1] = { item.status, item.status_group }
  end
  if last < #items then
    title[#title + 1] = { " ›", "PiSectionBorder" }
  end
  return title
end

local function render(project)
  if not is_window(project.terminal_win) then
    return
  end
  local width = vim.api.nvim_win_get_width(project.terminal_win)
  vim.api.nvim_win_set_config(project.terminal_win, {
    title = session_title(project, width),
    title_pos = "left",
  })
end

local function socket_path()
  socket_number = socket_number + 1
  return string.format("%s/s-%d-%d.sock", state_directory(), uv.os_getpid(), socket_number)
end

local function stop_socket(tab)
  tab.connected = false
  if tab.client then
    tab.client:read_stop()
    tab.client:close()
    tab.client = nil
  end
  if tab.server then
    tab.server:close()
    tab.server = nil
  end
  if tab.socket_path then
    uv.fs_unlink(tab.socket_path)
    tab.socket_path = nil
  end
end

local function handle_message(project, tab, client, message)
  if type(message) ~= "table" then
    return
  end
  if message.type == "hello" then
    if type(message.pid) ~= "number" or (tab.job and message.pid ~= vim.fn.jobpid(tab.job)) then
      client:close()
      return
    end
    for _, other in ipairs(project.tabs) do
      if other ~= tab and other.id == message.sessionId then
        client:close()
        tab.status = "오류"
        notify(
          "같은 Pi 대화를 두 세션에서 동시에 열 수 없습니다",
          vim.log.levels.ERROR
        )
        if tab.job then
          vim.fn.jobstop(tab.job)
        end
        render(project)
        return
      end
    end
    if tab.client and tab.client ~= client then
      tab.client:close()
    end
    tab.client = client
    tab.connected = true
    tab.status = "대기"
    tab.phase = nil
    if type(message.sessionId) == "string" and message.sessionId ~= tab.id then
      local previous_id = tab.id
      tab.id = message.sessionId
      if project.selected_id == previous_id then
        project.selected_id = tab.id
      end
      if tab.session_file and tab.session_file ~= message.sessionFile then
        tab.title = "새 세션"
      end
    end
    if type(message.sessionFile) == "string" then
      tab.session_file = message.sessionFile
    end
    if type(message.name) == "string" and message.name ~= "" then
      tab.title = message.name
    end
    save(project)
    for _, payload in ipairs(tab.pending) do
      tab.client:write(payload .. "\n")
    end
    tab.pending = {}
  elseif tab.client ~= client then
    return
  elseif message.type == "working" then
    tab.status = "작업 중"
    tab.phase = message.phase
  elseif message.type == "blocked" then
    tab.status = "입력 필요"
    tab.phase = nil
  elseif message.type == "idle" then
    tab.status = "대기"
    tab.phase = nil
  elseif message.type == "settled" then
    local failed = message.outcome == "error" or message.error == true
    tab.status = failed and "오류" or "대기"
    tab.phase = nil
    if message.outcome ~= "aborted" then
      tab.unread = true
    end
    save(project)
  elseif message.type == "read" then
    if tab.unread then
      tab.unread = false
      save(project)
    end
  elseif message.type == "name" then
    tab.title = type(message.name) == "string" and message.name or "세션 " .. tab.id:sub(1, 8)
    save(project)
  elseif message.type == "error" then
    tab.status = "오류"
    tab.phase = nil
    tab.unread = true
    save(project)
    notify(tostring(message.message), vim.log.levels.ERROR)
  end
  render(project)
end

local function start_socket(project, tab)
  local path = socket_path()
  local server = assert(uv.new_pipe(false))
  local ok, err = server:bind(path)
  if not ok then
    server:close()
    error("Pi 통신 소켓 생성 실패: " .. tostring(err))
  end
  tab.server = server
  tab.socket_path = path
  local chmod_ok, chmod_error = uv.fs_chmod(path, 384)
  if not chmod_ok then
    stop_socket(tab)
    error("Pi 통신 소켓 권한 설정 실패: " .. tostring(chmod_error))
  end
  local listening, listen_failure = server:listen(1, function(listen_error)
    if listen_error then
      vim.schedule(function()
        notify("Pi 통신 실패: " .. listen_error, vim.log.levels.ERROR)
      end)
      return
    end
    local client = assert(uv.new_pipe(false))
    local accepted, accept_error = server:accept(client)
    if not accepted then
      client:close()
      vim.schedule(function()
        notify("Pi 연결 실패: " .. tostring(accept_error), vim.log.levels.ERROR)
      end)
      return
    end
    vim.schedule(function()
      local incoming = ""
      client:read_start(function(read_error, data)
        if read_error or not data then
          vim.schedule(function()
            if tab.client == client then
              tab.connected = false
              tab.client = nil
              client:close()
              render(project)
            end
          end)
          return
        end
        incoming = incoming .. data
        if #incoming > 1_000_000 then
          vim.schedule(function()
            if tab.client == client then
              tab.client = nil
              tab.connected = false
            end
            client:close()
          end)
          return
        end
        local newline = incoming:find("\n", 1, true)
        while newline do
          local line = incoming:sub(1, newline - 1)
          incoming = incoming:sub(newline + 1)
          local parsed, message = pcall(vim.json.decode, line)
          if parsed then
            vim.schedule(function()
              handle_message(project, tab, client, message)
            end)
          end
          newline = incoming:find("\n", 1, true)
        end
      end)
    end)
  end)
  if not listening then
    stop_socket(tab)
    error("Pi 통신 소켓 대기 실패: " .. tostring(listen_failure))
  end
  return path
end

local function focus_terminal(project)
  if not is_window(project.terminal_win) then
    return
  end
  vim.api.nvim_set_current_win(project.terminal_win)
  if active_tab(project).job then
    vim.cmd("startinsert")
  end
end

local function extension_arguments()
  if vim.fn.filereadable(vim.fn.expand("~/.pi/agent/extensions/nvim.ts")) == 1 then
    return {}
  end
  local config = uv.fs_realpath(vim.fn.stdpath("config")) or vim.fn.stdpath("config")
  local source = vim.fn.fnamemodify(config .. "/../pi/extensions/nvim.ts", ":p")
  if vim.fn.filereadable(source) == 1 then
    return { "--extension", source }
  end
  error("Pi의 nvim.ts 확장을 찾을 수 없습니다")
end

local function spawn(project, tab)
  if vim.fn.executable(command) ~= 1 then
    error("pi 실행 파일을 찾을 수 없습니다")
  end
  local extension_argv = extension_arguments()
  local old_buf = tab.buf
  tab.buf = vim.api.nvim_create_buf(false, false)
  vim.bo[tab.buf].bufhidden = "hide"
  if is_window(project.terminal_win) then
    vim.api.nvim_win_set_buf(project.terminal_win, tab.buf)
  end
  local socket = start_socket(project, tab)
  local argv = { command, "--tui-mode", "fullscreen" }
  if tab.session_file and vim.fn.filereadable(tab.session_file) == 1 then
    vim.list_extend(argv, { "--session", tab.session_file })
  else
    vim.list_extend(argv, { "--session-id", tab.id })
  end
  vim.list_extend(argv, extension_argv)
  local job = vim.api.nvim_buf_call(tab.buf, function()
    return vim.fn.termopen(argv, {
      cwd = project.cwd,
      env = { PI_NVIM_SOCKET = socket },
      on_exit = function(exited_job, exit_code)
        vim.schedule(function()
          if tab.job ~= exited_job then
            return
          end
          stop_socket(tab)
          tab.job = nil
          tab.status = exit_code == 0 and "종료" or "오류"
          render(project)
        end)
      end,
    })
  end)
  if job <= 0 then
    stop_socket(tab)
    error("Pi 터미널 시작 실패: " .. tostring(job))
  end
  tab.job = job
  tab.status = "시작 중"
  if old_buf and vim.api.nvim_buf_is_valid(old_buf) then
    vim.api.nvim_buf_delete(old_buf, { force = true })
  end
  vim.keymap.set("t", "<C-\\>s", function()
    vim.cmd("stopinsert")
    M.sessions(project.cwd)
  end, { buffer = tab.buf, desc = "Pi 세션 선택" })
  vim.keymap.set("t", "<C-\\>[", function()
    M.cycle(-1, project.cwd)
  end, { buffer = tab.buf, desc = "이전 Pi 세션" })
  vim.keymap.set("t", "<C-\\>]", function()
    M.cycle(1, project.cwd)
  end, { buffer = tab.buf, desc = "다음 Pi 세션" })
  vim.keymap.set("t", "<C-\\>q", function()
    M.close(project.cwd)
  end, { buffer = tab.buf, desc = "Pi 화면 숨기기" })
end

function M.select(index, cwd)
  local project = projects[cwd or current_directory()]
  if not project or not is_window(project.terminal_win) then
    return
  end
  local tab = project.tabs[index]
  if not tab then
    return
  end
  project.selected_id = tab.id
  tab.unread = false
  save(project)
  if tab.job and tab.buf and vim.api.nvim_buf_is_valid(tab.buf) then
    vim.api.nvim_win_set_buf(project.terminal_win, tab.buf)
  else
    local ok, err = pcall(spawn, project, tab)
    if not ok then
      stop_socket(tab)
      tab.status = "오류"
      notify(tostring(err), vim.log.levels.ERROR)
    end
  end
  render(project)
  focus_terminal(project)
end

local function update_section_highlights()
  local title = vim.api.nvim_get_hl(0, { name = "FloatTitle", link = false })
  local border = vim.api.nvim_get_hl(0, { name = "FloatBorder", link = false })
  local background = vim.api.nvim_get_hl(0, { name = "Normal", link = false })
  vim.api.nvim_set_hl(0, "PiSectionBorder", {
    fg = border.fg or background.fg,
    bg = background.bg,
  })
  vim.api.nvim_set_hl(0, "PiSectionTitle", {
    fg = title.fg or background.fg,
    bg = background.bg,
    bold = title.bold or title.cterm and title.cterm.bold,
  })
  for source, target in pairs(title_status_groups) do
    if source ~= "Comment" then
      local highlight = vim.api.nvim_get_hl(0, { name = source, link = false })
      vim.api.nvim_set_hl(0, target, {
        fg = highlight.fg or background.fg,
        bg = background.bg,
      })
    end
  end
end

local function layout(project)
  local columns = vim.o.columns
  local lines = vim.o.lines - vim.o.cmdheight - 1
  if columns < 65 or lines < 18 then
    error("Neovim 창이 너무 작습니다. 최소 65×18이 필요합니다")
  end
  local total_width = math.min(math.floor(columns * 0.95), columns - 4)
  local width = total_width - 2
  local height = math.min(math.floor(lines * 0.86), lines - 4) - 2
  local col = math.floor((columns - total_width) / 2)
  local row = math.floor((lines - height - 2) / 2)
  update_section_highlights()

  local config = {
    relative = "editor",
    row = row,
    col = col,
    width = width,
    height = height,
    style = "minimal",
    border = "rounded",
    title = session_title(project, width),
    title_pos = "left",
    zindex = 50,
  }
  if is_window(project.terminal_win) then
    vim.api.nvim_win_set_config(project.terminal_win, config)
  else
    local tab = active_tab(project)
    local buffer = tab and tab.buf and vim.api.nvim_buf_is_valid(tab.buf) and tab.buf
      or vim.api.nvim_create_buf(false, true)
    project.terminal_win = vim.api.nvim_open_win(buffer, true, config)
    vim.wo[project.terminal_win].number = false
    vim.wo[project.terminal_win].signcolumn = "no"
    vim.wo[project.terminal_win].winhighlight = "FloatBorder:PiSectionBorder"
  end
  render(project)
end

local function start_spinner_timer(project)
  if project.spinner_timer then
    return
  end
  local timer = uv.new_timer()
  timer:start(120, 120, function()
    vim.schedule(function()
      if not is_window(project.terminal_win) then
        return
      end
      for _, tab in ipairs(project.tabs) do
        if tab.status == "작업 중" then
          project.frame_index = (project.frame_index % #spinner_frames) + 1
          render(project)
          return
        end
      end
    end)
  end)
  project.spinner_timer = timer
end

local function ensure_project(cwd)
  local project = projects[cwd]
  if not project then
    project = load(cwd)
    projects[cwd] = project
    if #project.tabs == 0 then
      add_tab(project)
      return project, true
    end
  end
  return project, false
end

local function open(cwd)
  local project = ensure_project(cwd)
  layout(project)
  start_spinner_timer(project)
  local index = 1
  for position, tab in ipairs(project.tabs) do
    if tab.id == project.selected_id then
      index = position
      break
    end
  end
  M.select(index, cwd)
  return project
end

function M.open(cwd)
  local ok, result = pcall(open, cwd or current_directory())
  if not ok then
    notify(tostring(result), vim.log.levels.ERROR)
    return nil
  end
  return result
end

function M.close(cwd)
  local project = projects[cwd or current_directory()]
  if not project then
    return
  end
  if is_window(project.terminal_win) then
    vim.api.nvim_win_close(project.terminal_win, true)
  end
  project.terminal_win = nil
  if project.spinner_timer then
    project.spinner_timer:stop()
    project.spinner_timer:close()
    project.spinner_timer = nil
  end
end

function M.toggle()
  local cwd = current_directory()
  local project = projects[cwd]
  if project and is_window(project.terminal_win) then
    M.close(cwd)
  else
    M.open(cwd)
  end
end

function M.sessions(cwd)
  local project = ensure_project(cwd or current_directory())
  local choices = {}
  for index, tab in ipairs(project.tabs) do
    choices[index] = { index = index, tab = tab }
  end
  vim.ui.select(choices, {
    prompt = "Pi 세션 선택",
    format_item = function(choice)
      local status = session_status(choice.tab, spinner_frames[project.frame_index])
      local marker = choice.tab.id == project.selected_id and "●" or " "
      return string.format("%s %d. %s · %s", marker, choice.index, choice.tab.title, status)
    end,
  }, function(choice)
    if not choice then
      return
    end
    if is_window(project.terminal_win) then
      M.select(choice.index, project.cwd)
    else
      project.selected_id = choice.tab.id
      M.open(project.cwd)
    end
  end)
end

function M.terminal()
  local current_win = vim.api.nvim_get_current_win()
  for _, project in pairs(projects) do
    if current_win == project.terminal_win then
      focus_terminal(project)
      return
    end
  end
  local project = M.open()
  if project then
    focus_terminal(project)
  end
end

function M.cycle(offset, cwd)
  cwd = cwd or current_directory()
  local project = ensure_project(cwd)
  local selected_index = 1
  for index, tab in ipairs(project.tabs) do
    if tab.id == project.selected_id then
      selected_index = index
      break
    end
  end
  local next_index = (selected_index - 1 + offset) % #project.tabs + 1
  if is_window(project.terminal_win) then
    M.select(next_index, cwd)
  else
    project.selected_id = project.tabs[next_index].id
    M.open(cwd)
  end
end

function M.new_session()
  local project, created = ensure_project(current_directory())
  if not created then
    add_tab(project)
  end
  M.open(project.cwd)
end

function M.ask(command_range)
  local cwd = current_directory()
  local selection = context.capture(command_range)
  vim.ui.input({ prompt = "Pi: " }, function(prompt)
    if not prompt or not prompt:match("%S") then
      return
    end
    local message = prompt .. "\n\n" .. selection
    local payload = vim.json.encode({ type = "prompt", text = message })
    if #payload > 900000 then
      notify("선택 영역이 너무 커서 전송할 수 없습니다", vim.log.levels.ERROR)
      return
    end
    local project = ensure_project(cwd)
    local tab = active_tab(project)
    if not tab.job then
      local ok, err = pcall(spawn, project, tab)
      if not ok then
        stop_socket(tab)
        tab.status = "오류"
        notify(tostring(err), vim.log.levels.ERROR)
        render(project)
        return
      end
    end
    if tab.title:match("^새 세션") then
      tab.title = prompt:sub(1, 35)
      save(project)
    end
    if tab.connected and tab.client then
      tab.client:write(payload .. "\n")
    else
      tab.pending[#tab.pending + 1] = payload
    end
    render(project)
  end)
end

function M.setup(options)
  command = options and options.command or "pi"
  vim.api.nvim_create_autocmd("ColorScheme", {
    group = vim.api.nvim_create_augroup("PiSectionColors", { clear = true }),
    callback = update_section_highlights,
  })
  vim.api.nvim_create_autocmd("WinClosed", {
    group = vim.api.nvim_create_augroup("PiFloatClose", { clear = true }),
    callback = function(event)
      local closed = tonumber(event.match)
      for _, project in pairs(projects) do
        if closed == project.terminal_win then
          vim.schedule(function()
            if closed == project.terminal_win then
              M.close(project.cwd)
            end
          end)
        end
      end
    end,
  })
  vim.api.nvim_create_autocmd("VimResized", {
    group = vim.api.nvim_create_augroup("PiFloatResize", { clear = true }),
    callback = function()
      for _, project in pairs(projects) do
        if is_window(project.terminal_win) then
          pcall(layout, project)
        end
      end
    end,
  })
  vim.api.nvim_create_autocmd("VimLeavePre", {
    group = vim.api.nvim_create_augroup("PiSocketCleanup", { clear = true }),
    callback = function()
      for _, project in pairs(projects) do
        for _, tab in ipairs(project.tabs) do
          stop_socket(tab)
        end
      end
    end,
  })
end

return M
