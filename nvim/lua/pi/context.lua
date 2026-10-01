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

function M.capture(command_range)
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
  if #items == 0 then
    local cursor = vim.api.nvim_win_get_cursor(0)
    return string.format("Neovim 현재 위치: %s:%d:%d", path, cursor[1], cursor[2] + 1)
  end

  local context = {
    "Neovim 버퍼에서 선택한 현재 내용입니다. 저장 전 수정 사항도 이 내용에 반영되어 있습니다.",
  }
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
  return table.concat(context, "\n\n")
end

return M
