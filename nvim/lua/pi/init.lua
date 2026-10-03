local uv = vim.uv
local context = require("pi.context")
local git = require("pi.git")

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
    session_scroll = 0,
    frame_index = 1,
    git = git.parse(""),
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

local function session_rows(project)
  return math.min(9, math.max(1, project.session_height - 4))
end

local function truncate(text, width)
  if vim.fn.strdisplaywidth(text) <= width then
    return text
  end
  if width <= 1 then
    return "…"
  end
  local result = ""
  for index = 0, vim.fn.strchars(text) - 1 do
    local char = vim.fn.strcharpart(text, index, 1)
    if vim.fn.strdisplaywidth(result .. char .. "…") > width then
      break
    end
    result = result .. char
  end
  return result .. "…"
end

local function git_header(project)
  local prefix = " "
  local suffix = string.format(" · %d uncommitted", #project.git.files)
  if vim.fn.strdisplaywidth(prefix .. "…" .. suffix) > project.sidebar_width then
    suffix = string.format(" · %d", #project.git.files)
  end
  local branch_width = project.sidebar_width - vim.fn.strdisplaywidth(prefix .. suffix)
  return prefix .. truncate(project.git.branch, branch_width) .. suffix
end

local function status_highlight(code)
  if code == "A" or code == "?" then
    return "DiagnosticOk"
  end
  if code == "D" then
    return "DiagnosticError"
  end
  return "DiagnosticWarn"
end

local function session_status(tab, frame)
  if tab.status == "작업 중" then
    local phase = tab.phase == "retry" and "재시도"
      or tab.phase == "tool" and "도구 실행"
      or tab.phase == "compaction" and "정리 중"
      or "작업 중"
    return frame .. " " .. phase, "DiagnosticInfo"
  end
  if tab.status == "입력 필요" then
    return "◉ 입력 필요", "DiagnosticWarn"
  end
  if tab.status == "오류" then
    return tab.unread and "! 오류 확인" or "! 오류", "DiagnosticError"
  end
  if tab.status == "시작 중" then
    return "… 시작 중", "Comment"
  end
  if tab.status == "종료" then
    return "□ 종료", "Comment"
  end
  if tab.unread then
    return "✓ 결과 확인", "DiagnosticOk"
  end
  return "○ 대기", "Comment"
end

local function session_line(tab, number, width, number_width, frame)
  local status, highlight = session_status(tab, frame)
  local prefix = string.format(" %" .. number_width .. "d. ", number)
  local title_width = math.max(1, width - vim.fn.strdisplaywidth(prefix .. status) - 1)
  local left = prefix .. truncate(tab.title, title_width)
  local spacing = math.max(1, width - vim.fn.strdisplaywidth(left .. status))
  return left .. string.rep(" ", spacing) .. status,
    #left + spacing,
    highlight,
    assert(prefix:find("%d")) - 1,
    #prefix - 1
end

local function render_sessions(project)
  if not project.sidebar_buf or not vim.api.nvim_buf_is_valid(project.sidebar_buf) then
    return
  end
  local height = project.session_height
  local size = session_rows(project)
  local selected = active_tab(project)
  local frame = spinner_frames[project.frame_index]
  project.session_scroll =
    math.max(0, math.min(project.session_scroll, math.max(0, #project.tabs - size)))

  local lines = {}
  for index = 1, height do
    lines[index] = ""
  end
  lines[1] = " " .. truncate(vim.fn.fnamemodify(project.cwd, ":~"), project.sidebar_width - 2)
  local start = project.session_scroll
  local visible_sessions = math.min(size, #project.tabs - start)
  local session_first_line = 3
  local number_width = #tostring(#project.tabs)
  local badges = {}
  for index = 1, visible_sessions do
    local tab = project.tabs[start + index]
    local line = session_first_line + index - 1
    local text, status_col, highlight, number_start, number_end =
      session_line(tab, start + index, project.sidebar_width, number_width, frame)
    lines[line] = text
    badges[#badges + 1] = {
      line = line,
      col = status_col,
      width = #text - status_col,
      highlight = highlight,
      number_start = number_start,
      number_end = number_end,
      number_highlight = tab == selected and "CursorLineNr" or "LineNr",
    }
  end
  local action_line = session_first_line + visible_sessions
  lines[action_line] = " + 새 세션"
  if #project.tabs > size then
    lines[height] = string.format(" %d–%d/%d", start + 1, start + visible_sessions, #project.tabs)
  end
  project.session_first_line = session_first_line
  project.session_last_line = session_first_line + size - 1
  project.visible_session_count = visible_sessions
  project.new_session_line = action_line

  vim.bo[project.sidebar_buf].modifiable = true
  vim.api.nvim_buf_set_lines(project.sidebar_buf, 0, -1, false, lines)
  vim.bo[project.sidebar_buf].modifiable = false
  vim.api.nvim_buf_clear_namespace(project.sidebar_buf, project.namespace, 0, -1)
  vim.api.nvim_buf_add_highlight(project.sidebar_buf, project.namespace, "Title", 0, 0, -1)
  vim.api.nvim_buf_add_highlight(
    project.sidebar_buf,
    project.namespace,
    "Directory",
    action_line - 1,
    0,
    -1
  )
  if #project.tabs > size then
    vim.api.nvim_buf_add_highlight(
      project.sidebar_buf,
      project.namespace,
      "Comment",
      height - 1,
      0,
      -1
    )
  end
  for index = 1, visible_sessions do
    local tab = project.tabs[start + index]
    if tab and tab == selected then
      vim.api.nvim_buf_add_highlight(
        project.sidebar_buf,
        project.namespace,
        "Visual",
        session_first_line + index - 2,
        0,
        -1
      )
    end
  end
  for _, badge in ipairs(badges) do
    vim.api.nvim_buf_add_highlight(
      project.sidebar_buf,
      project.namespace,
      badge.number_highlight,
      badge.line - 1,
      badge.number_start,
      badge.number_end
    )
    vim.api.nvim_buf_add_highlight(
      project.sidebar_buf,
      project.namespace,
      badge.highlight,
      badge.line - 1,
      badge.col,
      badge.col + badge.width
    )
  end
end

local function render_git(project)
  if not project.git_buf or not vim.api.nvim_buf_is_valid(project.git_buf) then
    return
  end
  local height = project.git_height
  local lines = {}
  for index = 1, height do
    lines[index] = ""
  end
  lines[1] = git_header(project)
  lines[2] = string.format(" %d staged", #project.git.staged)
  local file_slots = math.max(0, height - 3)
  local staged_visible = math.min(#project.git.staged, math.ceil(file_slots / 2))
  local unstaged_visible = math.min(#project.git.unstaged, file_slots - staged_visible)
  staged_visible = math.min(#project.git.staged, file_slots - unstaged_visible)
  for index = 1, staged_visible do
    local file = project.git.staged[index]
    lines[2 + index] = string.format("  %s %s", file.code, file.path)
  end
  local unstaged_line = 3 + staged_visible
  lines[unstaged_line] = string.format(" %d unstaged", #project.git.unstaged)
  for index = 1, unstaged_visible do
    local file = project.git.unstaged[index]
    lines[unstaged_line + index] = string.format("  %s %s", file.code, file.path)
  end

  vim.bo[project.git_buf].modifiable = true
  vim.api.nvim_buf_set_lines(project.git_buf, 0, -1, false, lines)
  vim.bo[project.git_buf].modifiable = false
  vim.api.nvim_buf_clear_namespace(project.git_buf, project.namespace, 0, -1)
  vim.api.nvim_buf_add_highlight(project.git_buf, project.namespace, "Title", 0, 0, -1)
  vim.api.nvim_buf_add_highlight(project.git_buf, project.namespace, "Directory", 1, 0, -1)
  vim.api.nvim_buf_add_highlight(
    project.git_buf,
    project.namespace,
    "Directory",
    unstaged_line - 1,
    0,
    -1
  )
  for index = 1, staged_visible do
    local file = project.git.staged[index]
    vim.api.nvim_buf_add_highlight(
      project.git_buf,
      project.namespace,
      status_highlight(file.code),
      1 + index,
      2,
      3
    )
  end
  for index = 1, unstaged_visible do
    local file = project.git.unstaged[index]
    vim.api.nvim_buf_add_highlight(
      project.git_buf,
      project.namespace,
      status_highlight(file.code),
      unstaged_line + index - 1,
      2,
      3
    )
  end
end

local function render(project)
  render_sessions(project)
  render_git(project)
end

local function scroll_sessions(project, amount)
  local maximum = math.max(0, #project.tabs - session_rows(project))
  local position = math.max(0, math.min(maximum, project.session_scroll + amount))
  if position ~= project.session_scroll then
    project.session_scroll = position
    render(project)
  end
end

local function refresh_git(project)
  vim.system(
    { "git", "status", "--porcelain=v1", "--branch", "--untracked-files=all" },
    { cwd = project.cwd, text = true },
    function(result)
      vim.schedule(function()
        if not projects[project.cwd] then
          return
        end
        project.git = result.code == 0 and git.parse(result.stdout or "") or git.parse("")
        render(project)
      end)
    end
  )
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
    vim.api.nvim_set_current_win(project.sidebar_win)
  end, { buffer = tab.buf, desc = "Pi 세션 목록" })
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
  if index <= project.session_scroll then
    project.session_scroll = index - 1
  elseif index > project.session_scroll + session_rows(project) then
    project.session_scroll = index - session_rows(project)
  end
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

local function sidebar_choice(project)
  local line = vim.api.nvim_win_get_cursor(project.sidebar_win)[1]
  if line == project.new_session_line then
    add_tab(project)
    M.select(#project.tabs, project.cwd)
    return
  end
  local number = line - project.session_first_line + 1
  if number >= 1 and number <= project.visible_session_count then
    M.select(project.session_scroll + number, project.cwd)
  end
end

local function make_sidebar(project)
  if project.sidebar_buf and vim.api.nvim_buf_is_valid(project.sidebar_buf) then
    return project.sidebar_buf
  end
  local buf = vim.api.nvim_create_buf(false, true)
  project.sidebar_buf = buf
  vim.bo[buf].bufhidden = "hide"
  vim.bo[buf].filetype = "pi"
  vim.bo[buf].modifiable = false
  local map = function(key, callback)
    vim.keymap.set("n", key, callback, { buffer = buf, nowait = true, silent = true })
  end
  map("<CR>", function()
    sidebar_choice(project)
  end)
  map("<LeftMouse>", function()
    local mouse = vim.fn.getmousepos()
    if mouse.winid == project.sidebar_win then
      vim.api.nvim_win_set_cursor(project.sidebar_win, { mouse.line, 0 })
      sidebar_choice(project)
    elseif mouse.winid == project.terminal_win then
      focus_terminal(project)
    elseif mouse.winid ~= 0 and is_window(mouse.winid) then
      vim.api.nvim_set_current_win(mouse.winid)
      if mouse.line > 0 and mouse.column > 0 then
        vim.api.nvim_win_set_cursor(mouse.winid, { mouse.line, mouse.column - 1 })
      end
    end
  end)
  map("<Tab>", function()
    focus_terminal(project)
  end)
  map("<C-w>l", function()
    focus_terminal(project)
  end)
  map("<C-w><C-l>", function()
    focus_terminal(project)
  end)
  map("n", function()
    add_tab(project)
    M.select(#project.tabs, project.cwd)
  end)
  map("q", function()
    M.close(project.cwd)
  end)
  for digit = 1, 9 do
    map(tostring(digit), function()
      M.select(digit, project.cwd)
    end)
  end
  map("[", function()
    scroll_sessions(project, -1)
  end)
  map("]", function()
    scroll_sessions(project, 1)
  end)
  map("<ScrollWheelUp>", function()
    local mouse = vim.fn.getmousepos()
    if
      mouse.winid == project.sidebar_win
      and mouse.line >= project.session_first_line
      and mouse.line <= project.session_last_line
    then
      scroll_sessions(project, -3)
    end
  end)
  map("<ScrollWheelDown>", function()
    local mouse = vim.fn.getmousepos()
    if
      mouse.winid == project.sidebar_win
      and mouse.line >= project.session_first_line
      and mouse.line <= project.session_last_line
    then
      scroll_sessions(project, 3)
    end
  end)
  return buf
end

local function make_git(project)
  if project.git_buf and vim.api.nvim_buf_is_valid(project.git_buf) then
    return project.git_buf
  end
  local buf = vim.api.nvim_create_buf(false, true)
  project.git_buf = buf
  vim.bo[buf].bufhidden = "hide"
  vim.bo[buf].filetype = "pi"
  vim.bo[buf].modifiable = false
  local map = function(key, callback)
    vim.keymap.set("n", key, callback, { buffer = buf, nowait = true, silent = true })
  end
  map("<LeftMouse>", function()
    local mouse = vim.fn.getmousepos()
    if mouse.winid == project.terminal_win then
      focus_terminal(project)
    elseif mouse.winid == project.sidebar_win then
      vim.api.nvim_set_current_win(project.sidebar_win)
      if mouse.line > 0 then
        vim.api.nvim_win_set_cursor(project.sidebar_win, { mouse.line, 0 })
        sidebar_choice(project)
      end
    elseif mouse.winid ~= 0 and is_window(mouse.winid) then
      vim.api.nvim_set_current_win(mouse.winid)
    end
  end)
  map("<Tab>", function()
    focus_terminal(project)
  end)
  map("<C-w>l", function()
    focus_terminal(project)
  end)
  map("<C-w>k", function()
    vim.api.nvim_set_current_win(project.sidebar_win)
  end)
  map("q", function()
    M.close(project.cwd)
  end)
  return buf
end

local function layout(project)
  local columns = vim.o.columns
  local lines = vim.o.lines - vim.o.cmdheight - 1
  if columns < 65 or lines < 18 then
    error("Neovim 창이 너무 작습니다. 최소 65×18이 필요합니다")
  end
  local total_width = math.min(math.floor(columns * 0.95), columns - 4)
  local height = math.min(math.floor(lines * 0.86), lines - 4) - 2
  local sidebar_height = math.max(5, math.min(15, math.floor((height - 2) * 0.48)))
  local git_height = height - sidebar_height - 3
  local sidebar_width = math.min(36, math.max(24, math.floor(total_width * 0.29)))
  local terminal_width = total_width - sidebar_width - 5
  local col = math.floor((columns - total_width) / 2)
  local row = math.floor((lines - height - 2) / 2)
  project.height = height
  project.session_height = sidebar_height
  project.git_height = git_height
  project.sidebar_width = sidebar_width

  local sidebar_config = {
    relative = "editor",
    row = row,
    col = col,
    width = sidebar_width,
    height = sidebar_height,
    style = "minimal",
    border = "rounded",
    title = " Sessions ",
    zindex = 50,
  }
  local git_config = {
    relative = "editor",
    row = row + sidebar_height + 3,
    col = col,
    width = sidebar_width,
    height = git_height,
    style = "minimal",
    border = "rounded",
    title = " Git ",
    zindex = 50,
  }
  local terminal_config = {
    relative = "editor",
    row = row,
    col = col + sidebar_width + 3,
    width = terminal_width,
    height = height,
    style = "minimal",
    border = "rounded",
    title = " Session ",
    zindex = 50,
  }
  if
    is_window(project.sidebar_win)
    and is_window(project.git_win)
    and is_window(project.terminal_win)
  then
    vim.api.nvim_win_set_config(project.sidebar_win, sidebar_config)
    vim.api.nvim_win_set_config(project.git_win, git_config)
    vim.api.nvim_win_set_config(project.terminal_win, terminal_config)
  else
    for _, key in ipairs({ "sidebar_win", "git_win", "terminal_win" }) do
      if is_window(project[key]) then
        vim.api.nvim_win_close(project[key], true)
      end
    end
    project.sidebar_win = vim.api.nvim_open_win(make_sidebar(project), false, sidebar_config)
    project.git_win = vim.api.nvim_open_win(make_git(project), false, git_config)
    local tab = active_tab(project)
    local buffer = tab and tab.buf and vim.api.nvim_buf_is_valid(tab.buf) and tab.buf
      or vim.api.nvim_create_buf(false, true)
    project.terminal_win = vim.api.nvim_open_win(buffer, true, terminal_config)
    vim.wo[project.sidebar_win].number = false
    vim.wo[project.sidebar_win].cursorline = true
    vim.wo[project.sidebar_win].wrap = false
    vim.wo[project.git_win].number = false
    vim.wo[project.git_win].wrap = false
    vim.wo[project.terminal_win].number = false
    vim.wo[project.terminal_win].signcolumn = "no"
  end
  render(project)
end

local function start_git_timer(project)
  if project.git_timer then
    return
  end
  refresh_git(project)
  local timer = uv.new_timer()
  timer:start(5000, 5000, function()
    vim.schedule(function()
      refresh_git(project)
    end)
  end)
  project.git_timer = timer
end

local function start_spinner_timer(project)
  if project.spinner_timer then
    return
  end
  local timer = uv.new_timer()
  timer:start(120, 120, function()
    vim.schedule(function()
      if not is_window(project.sidebar_win) then
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
    project.namespace = vim.api.nvim_create_namespace("pi." .. vim.fn.sha256(cwd):sub(1, 12))
    projects[cwd] = project
    if #project.tabs == 0 then
      add_tab(project)
    end
  end
  return project
end

local function open(cwd)
  local project = ensure_project(cwd)
  layout(project)
  start_git_timer(project)
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
  for _, key in ipairs({ "sidebar_win", "git_win", "terminal_win" }) do
    if is_window(project[key]) then
      vim.api.nvim_win_close(project[key], true)
    end
    project[key] = nil
  end
  if project.git_timer then
    project.git_timer:stop()
    project.git_timer:close()
    project.git_timer = nil
  end
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

function M.sidebar()
  local project = projects[current_directory()]
  if not project or not is_window(project.sidebar_win) then
    project = M.open()
  end
  if project then
    vim.api.nvim_set_current_win(project.sidebar_win)
  end
end

function M.terminal()
  local current_win = vim.api.nvim_get_current_win()
  for _, project in pairs(projects) do
    if
      current_win == project.sidebar_win
      or current_win == project.git_win
      or current_win == project.terminal_win
    then
      focus_terminal(project)
      return
    end
  end
  local project = M.open()
  if project then
    focus_terminal(project)
  end
end

function M.new_session()
  local project = M.open()
  if project then
    add_tab(project)
    M.select(#project.tabs, project.cwd)
  end
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
  vim.api.nvim_create_autocmd("WinClosed", {
    group = vim.api.nvim_create_augroup("PiFloatClose", { clear = true }),
    callback = function(event)
      local closed = tonumber(event.match)
      for _, project in pairs(projects) do
        if
          closed == project.sidebar_win
          or closed == project.git_win
          or closed == project.terminal_win
        then
          vim.schedule(function()
            if
              closed == project.sidebar_win
              or closed == project.git_win
              or closed == project.terminal_win
            then
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
