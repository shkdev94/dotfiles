local M = {}

local function region(buf, first, last, mode)
  local options = { type = mode }
  local lines = vim.fn.getregion(first, last, options)
  local positions = vim.fn.getregionpos(first, last, options)
  if #lines == 0 or #positions == 0 then
    return nil
  end

  local start_pos = positions[1][1]
  local end_pos = positions[#positions][2]
  return {
    start_line = start_pos[2],
    start_col = start_pos[3],
    end_line = end_pos[2],
    end_col = end_pos[3],
    text = table.concat(lines, "\n"),
    segments = positions,
    block = mode == "\22",
  }
end

local function selections(buf, mode)
  local result = {}
  local ok, multicursor = pcall(require, "multicursor-nvim")
  if ok then
    multicursor.action(function(ctx)
      local cursors = ctx:getCursors({ enabledCursors = true })
      if #cursors < 2 then
        return
      end
      for _, cursor in ipairs(cursors) do
        if cursor:hasSelection() then
          local first, last = cursor:getVisual()
          local selection_mode = cursor:mode()
          if selection_mode == "s" then
            selection_mode = "v"
          elseif selection_mode == "S" then
            selection_mode = "V"
          elseif selection_mode == "\19" then
            selection_mode = "\22"
          end
          local item = region(
            buf,
            { buf, first[1], first[2], first[3] },
            { buf, last[1], last[2], last[3] },
            selection_mode
          )
          if item then
            result[#result + 1] = item
          end
        end
      end
    end)
  end

  if #result == 0 and (mode == "v" or mode == "V" or mode == "\22") then
    local item = region(buf, vim.fn.getpos("v"), vim.fn.getpos("."), mode)
    if item then
      result[1] = item
    end
  end
  return result
end

local function fence(text)
  local longest = 2
  for run in text:gmatch("`+") do
    longest = math.max(longest, #run)
  end
  return string.rep("`", longest + 1)
end

local function overlaps_selection(diagnostic, item)
  local end_line = diagnostic.end_lnum or diagnostic.lnum
  for _, segment in ipairs(item.segments) do
    local line = segment[1][2] - 1
    if diagnostic.lnum <= line and line <= end_line then
      local first_col = math.max(0, segment[1][3] - 1)
      local last_col = math.max(first_col + 1, segment[2][3])
      local diagnostic_first = line == diagnostic.lnum and diagnostic.col or 0
      local diagnostic_last = line == end_line and diagnostic.end_col or math.huge
      if diagnostic.lnum == end_line and diagnostic.col == diagnostic.end_col then
        diagnostic_last = diagnostic_last + 1
      end
      if diagnostic_first < last_col and first_col < diagnostic_last then
        return true
      end
    end
  end
  return false
end

local function diagnostic_context(buf, items, cursor_line)
  local matches = {}
  local diagnostics = vim.diagnostic.get(buf, {
    severity = { min = vim.diagnostic.severity.WARN },
  })
  for _, diagnostic in ipairs(diagnostics) do
    local relevant = #items == 0
      and diagnostic.lnum < cursor_line
      and cursor_line <= (diagnostic.end_lnum or diagnostic.lnum) + 1
    for _, item in ipairs(items) do
      if overlaps_selection(diagnostic, item) then
        relevant = true
        break
      end
    end
    if relevant then
      matches[#matches + 1] = diagnostic
    end
  end
  if #matches == 0 then
    return nil
  end

  table.sort(matches, function(a, b)
    if a.lnum ~= b.lnum then
      return a.lnum < b.lnum
    end
    if a.col ~= b.col then
      return a.col < b.col
    end
    return a.severity < b.severity
  end)

  local lines = { "해당 위치의 Neovim 오류·경고 (저장 전 진단 포함):" }
  for _, diagnostic in ipairs(matches) do
    local severity = diagnostic.severity == vim.diagnostic.severity.ERROR and "ERROR" or "WARN"
    local source = diagnostic.source or "출처 미상"
    if diagnostic.code ~= nil then
      source = source .. "/" .. tostring(diagnostic.code)
    end
    lines[#lines + 1] = string.format(
      "- %s [%s] %d:%d: %s",
      severity,
      source,
      diagnostic.lnum + 1,
      diagnostic.col + 1,
      (diagnostic.message:gsub("\n", "\n  "))
    )
  end
  return table.concat(lines, "\n")
end

function M.capture(command_range, include_diagnostics, include_file)
  local buf = vim.api.nvim_get_current_buf()
  local path = vim.api.nvim_buf_get_name(buf)
  if path == "" then
    path = "[이름 없는 버퍼]"
  end
  local mode = vim.fn.mode()
  local items = selections(buf, mode)
  if #items == 0 and command_range and command_range.range > 0 then
    local visual_mode = vim.fn.visualmode()
    local first = vim.fn.getpos("'<")
    local last = vim.fn.getpos("'>")
    if first[2] ~= command_range.line1 or last[2] ~= command_range.line2 then
      visual_mode = "V"
      first = { buf, command_range.line1, 1, 0 }
      last = { buf, command_range.line2, 1, 0 }
    end
    local item = region(buf, first, last, visual_mode)
    if item then
      items[1] = item
    end
  end
  local cursor = vim.api.nvim_win_get_cursor(0)
  local context = {}
  if #items == 0 then
    if include_file then
      local text = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n")
      local marker = fence(text)
      context[1] = string.format(
        "Neovim 현재 파일: %s (저장 전 수정 사항 포함)\n%s\n%s\n%s",
        path,
        marker,
        text,
        marker
      )
    else
      context[1] = string.format("Neovim 현재 위치: %s:%d:%d", path, cursor[1], cursor[2] + 1)
    end
  else
    context[1] =
      "Neovim 버퍼에서 선택한 현재 내용입니다. 저장 전 수정 사항도 이 내용에 반영되어 있습니다."
    for index, item in ipairs(items) do
      local range = string.format(
        "%s:%d:%d-%d:%d",
        path,
        item.start_line,
        item.start_col,
        item.end_line,
        item.end_col
      )
      local marker = fence(item.text)
      context[#context + 1] = string.format(
        "선택 %d (%s%s):\n%s\n%s\n%s",
        index,
        range,
        item.block and ", 블록 선택" or "",
        marker,
        item.text,
        marker
      )
    end
  end
  if include_diagnostics then
    local diagnostics = diagnostic_context(buf, items, cursor[1])
    if diagnostics then
      context[#context + 1] = diagnostics
    end
  end
  return table.concat(context, "\n\n")
end

return M
