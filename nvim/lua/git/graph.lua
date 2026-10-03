local M = {}
local bit = require("bit")

local palette = {
  "#a0dc65",
  "#7b91ff",
  "#ffc06b",
  "#ff628c",
  "#34b4ff",
  "#d55bfa",
  "#33d4bd",
  "#ff8e6e",
}

local highlight_groups = {}

local function copy_lanes(lanes)
  local result = {}
  for index, lane in ipairs(lanes) do
    result[index] = lane
  end
  return result
end

local function find_lane(lanes, target)
  for index, lane in ipairs(lanes) do
    if lane.target == target then
      return index
    end
  end
end

local function vacant_lane(lanes, start)
  for index = start, #lanes do
    if not lanes[index].target then
      return index
    end
  end
  for index = 1, start - 1 do
    if not lanes[index].target then
      return index
    end
  end
  return #lanes + 1
end

function M.layout(commits)
  local lanes = {}
  local rows = {}
  local next_color = 0
  local max_lanes = 0

  local function color()
    next_color = next_color + 1
    return palette[(next_color - 1) % #palette + 1]
  end

  for _, commit in ipairs(commits) do
    local lane_index = find_lane(lanes, commit.id)
    if not lane_index then
      lane_index = vacant_lane(lanes, 1)
      lanes[lane_index] = { target = commit.id, color = color(), dotted = commit.working_tree }
    end

    local before = copy_lanes(lanes)
    local current = before[lane_index]
    local after = copy_lanes(before)
    after[lane_index] = { target = false }
    local edges = {}

    for index, lane in ipairs(before) do
      if index ~= lane_index and lane.target then
        edges[#edges + 1] = {
          from = index,
          to = index,
          color = lane.color,
          dotted = lane.dotted,
        }
      end
    end

    for parent_index, parent in ipairs(commit.parents) do
      local destination = find_lane(after, parent)
      if not destination then
        destination = not after[lane_index].target and lane_index
          or vacant_lane(after, lane_index + 1)
        after[destination] = {
          target = parent,
          color = destination == lane_index and current.color or color(),
          dotted = commit.working_tree or false,
        }
      end
      edges[#edges + 1] = {
        from = lane_index,
        to = destination,
        color = parent_index == 1 and current.color or after[destination].color,
        dotted = commit.working_tree or false,
      }
    end

    while #after > 0 and not after[#after].target do
      table.remove(after)
    end

    rows[#rows + 1] = {
      commit = commit,
      lane = lane_index,
      color = current.color,
      before = before,
      after = after,
      edges = edges,
    }
    max_lanes = math.max(max_lanes, #before, #after)
    lanes = after
  end

  return { rows = rows, lanes = max_lanes }
end

local function cells_to_text(cells)
  local text = {}
  local highlights = {}
  local byte_offset = 0
  for _, cell in ipairs(cells) do
    local symbol = cell.symbol or " "
    text[#text + 1] = symbol
    if cell.color then
      highlights[#highlights + 1] = {
        start = byte_offset,
        finish = byte_offset + #symbol,
        color = cell.color,
      }
    end
    byte_offset = byte_offset + #symbol
  end
  return table.concat(text), highlights
end

local function empty_cells(width)
  local cells = {}
  for index = 1, width do
    cells[index] = { symbol = " " }
  end
  return cells
end

local function position(lane)
  return lane * 3 - 1
end

function M.commit_line(row, width)
  local cells = empty_cells(width)
  for index, lane in ipairs(row.before) do
    local column = position(index)
    if lane.target and column <= width then
      cells[column] = {
        symbol = index == row.lane and (row.commit.working_tree and "◌" or "●")
          or (lane.dotted and "┊" or "│"),
        color = lane.color,
      }
    end
  end
  return cells_to_text(cells)
end

local glyphs = {
  [0] = " ",
  [1] = "│",
  [2] = "│",
  [3] = "│",
  [4] = "─",
  [5] = "╯",
  [6] = "╮",
  [7] = "┤",
  [8] = "─",
  [9] = "╰",
  [10] = "╭",
  [11] = "├",
  [12] = "─",
  [13] = "┴",
  [14] = "┬",
  [15] = "┼",
}

function M.connector_line(row, width)
  local cells = empty_cells(width)
  for _, edge in ipairs(row.edges) do
    local source = position(edge.from)
    local destination = position(edge.to)
    if source <= width and destination <= width then
      local function connect(column, direction)
        local cell = cells[column]
        cell.mask = bit.bor(cell.mask or 0, direction)
        cell.color = edge.color
        cell.dotted = edge.dotted
      end

      if source == destination then
        connect(source, 3)
      else
        local left, right = math.min(source, destination), math.max(source, destination)
        connect(source, source < destination and 9 or 5)
        for column = left + 1, right - 1 do
          connect(column, 12)
        end
        connect(destination, destination < source and 10 or 6)
      end
    end
  end

  for _, cell in ipairs(cells) do
    cell.symbol = glyphs[cell.mask or 0]
    if cell.dotted then
      if cell.symbol == "│" then
        cell.symbol = "┊"
      elseif cell.symbol == "─" then
        cell.symbol = "┄"
      end
    end
  end
  return cells_to_text(cells)
end

local function tint(background, foreground, opacity)
  local function channel(shift)
    local base = bit.band(bit.rshift(background, shift), 0xff)
    local accent = bit.band(bit.rshift(foreground, shift), 0xff)
    return math.floor(base * (1 - opacity) + accent * opacity + 0.5)
  end
  return bit.bor(bit.lshift(channel(16), 16), bit.lshift(channel(8), 8), channel(0))
end

local function groups(color)
  if highlight_groups[color] then
    return highlight_groups[color]
  end
  local suffix = color:sub(2)
  local names = {
    line = "GitLuaGraph" .. suffix,
    row = "GitLuaBranchRow" .. suffix,
    selected = "GitLuaBranchSelected" .. suffix,
    selected_line = "GitLuaBranchSelectedLine" .. suffix,
    ref = "GitLuaBranchRef" .. suffix,
  }
  local normal = vim.api.nvim_get_hl(0, { name = "Normal", link = false })
  local background = normal.bg or (vim.o.background == "light" and 0xffffff or 0x1e1e1e)
  local foreground = tonumber(suffix, 16)
  vim.api.nvim_set_hl(0, names.line, { fg = color, default = true })
  vim.api.nvim_set_hl(0, names.row, { bg = tint(background, foreground, 0.16), default = true })
  vim.api.nvim_set_hl(
    0,
    names.selected,
    { bg = tint(background, foreground, 0.42), default = true }
  )
  vim.api.nvim_set_hl(
    0,
    names.selected_line,
    { bg = tint(background, foreground, 0.10), default = true }
  )
  vim.api.nvim_set_hl(0, names.ref, {
    fg = color,
    bg = tint(background, foreground, 0.32),
    bold = true,
    default = true,
  })
  highlight_groups[color] = names
  return names
end

function M.highlight_group(color)
  return groups(color).line
end

function M.row_highlight_group(color)
  return groups(color).row
end

function M.selected_highlight_group(color)
  return groups(color).selected
end

function M.selected_line_highlight_group(color)
  return groups(color).selected_line
end

function M.ref_highlight_group(color)
  return groups(color).ref
end

return M
