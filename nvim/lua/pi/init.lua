local uv = vim.uv
local context = require("pi.context")
local prompt = require("pi.prompt")

local M = {}
local socket_dir = "/tmp/pi-nvim-" .. uv.getuid()

local function notify(message, level)
  vim.notify("Pi: " .. message, level or vim.log.levels.WARN)
end

local function current_directory()
  local cwd = vim.fn.getcwd()
  return uv.fs_realpath(cwd) or cwd
end

local function candidates(cwd)
  local result = {}
  local directory = uv.fs_lstat(socket_dir)
  if
    not directory
    or directory.type ~= "directory"
    or directory.uid ~= uv.getuid()
    or bit.band(directory.mode, 63) ~= 0
  then
    return result
  end
  local scan = uv.fs_scandir(socket_dir)
  if not scan then
    return result
  end
  while true do
    local filename, kind = uv.fs_scandir_next(scan)
    if not filename then
      break
    end
    if kind == "file" and filename:match("^[%d]+%-[%x]+%.json$") then
      local manifest = socket_dir .. "/" .. filename
      local ok, data = pcall(function()
        local info = assert(uv.fs_lstat(manifest))
        assert(info.size <= 16384 and info.uid == uv.getuid())
        return vim.json.decode(table.concat(vim.fn.readfile(manifest), "\n"))
      end)
      local socket = manifest:gsub("%.json$", ".sock")
      local stat = uv.fs_lstat(socket)
      if
        ok
        and type(data) == "table"
        and data.cwd == cwd
        and type(data.sessionId) == "string"
        and data.sessionId ~= ""
        and type(data.pid) == "number"
        and data.pid > 0
        and data.pid % 1 == 0
        and stat
        and stat.type == "socket"
        and stat.uid == uv.getuid()
      then
        result[#result + 1] = {
          socket = socket,
          cwd = cwd,
          id = data.sessionId,
          pid = data.pid,
          name = type(data.name) == "string" and data.name or nil,
        }
      end
    end
  end
  return result
end

local function request(socket, command, callback)
  local client = uv.new_pipe(false)
  local timer = uv.new_timer()
  if not client or not timer then
    if client then
      client:close()
    end
    if timer then
      timer:close()
    end
    callback("연결을 시작할 수 없습니다")
    return
  end
  local finished = false
  local function finish(err, response)
    if finished then
      return
    end
    finished = true
    timer:stop()
    timer:close()
    client:read_stop()
    client:close()
    vim.schedule(function()
      callback(err, response)
    end)
  end
  timer:start(command.type == "ping" and 1000 or 5000, 0, function()
    finish("연결 시간이 초과됐습니다")
  end)
  client:connect(socket, function(err)
    if finished then
      return
    end
    if err then
      finish(tostring(err))
      return
    end
    local buffer = ""
    client:read_start(function(read_err, chunk)
      if read_err or not chunk then
        finish(read_err and tostring(read_err) or "연결이 끊겼습니다")
        return
      end
      buffer = buffer .. chunk
      if #buffer > 16384 then
        finish("응답이 너무 큽니다")
        return
      end
      local newline = buffer:find("\n", 1, true)
      if newline then
        local ok, response = pcall(vim.json.decode, buffer:sub(1, newline - 1))
        if ok and type(response) == "table" then
          finish(nil, response)
        else
          finish("잘못된 응답입니다")
        end
      end
    end)
    client:write(vim.json.encode(command) .. "\n", function(write_err)
      if write_err then
        finish(tostring(write_err))
      end
    end)
  end)
end

local function find_sessions(cwd, callback)
  local found = candidates(cwd)
  if #found == 0 then
    notify("현재 디렉터리에서 실행 중인 Pi 세션이 없습니다")
    return
  end
  local live = {}
  local remaining = #found
  for _, session in ipairs(found) do
    request(session.socket, { type = "ping" }, function(err, response)
      if
        not err
        and response
        and response.ok == true
        and response.cwd == cwd
        and response.sessionId == session.id
        and response.pid == session.pid
      then
        session.name = type(response.name) == "string" and response.name or session.name
        live[#live + 1] = session
      end
      remaining = remaining - 1
      if remaining ~= 0 then
        return
      end
      if #live == 0 then
        notify("현재 디렉터리에서 연결 가능한 Pi 세션이 없습니다")
      else
        table.sort(live, function(a, b)
          return a.pid < b.pid
        end)
        callback(live)
      end
    end)
  end
end

function M.ask(command_range, include_diagnostics)
  local cwd = current_directory()
  local captured = context.capture(command_range, include_diagnostics, not include_diagnostics)
  find_sessions(cwd, function(sessions)
    prompt.open(sessions, function(session, question)
      local command = {
        type = "prompt",
        text = question .. "\n\n" .. captured,
        cwd = cwd,
        sessionId = session.id,
      }
      if #vim.json.encode(command) > 900000 then
        notify("선택한 내용이 너무 커서 전송할 수 없습니다", vim.log.levels.ERROR)
        return
      end
      request(session.socket, command, function(err, response)
        if err or not response or response.ok ~= true then
          notify(
            "요청 전송 실패: " .. tostring(err or response and response.error),
            vim.log.levels.ERROR
          )
        else
          notify("세션으로 요청을 보냈습니다", vim.log.levels.INFO)
        end
      end)
    end)
  end)
end

return M
