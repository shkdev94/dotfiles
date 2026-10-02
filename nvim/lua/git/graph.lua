local M = {}

local palette = {
  "#34b4ff",
  "#d55bfa",
  "#ff628c",
  "#33d4bd",
  "#ffc06b",
  "#a0dc65",
  "#7b91ff",
  "#ff8e6e",
}

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
      lane_index = #lanes + 1
      lanes[lane_index] = { target = commit.id, color = color() }
    end

    local before = copy_lanes(lanes)
    local current = before[lane_index]
    local after = {}
    local existing = {}
    for index, lane in ipairs(before) do
      if index ~= lane_index then
        existing[lane.target] = true
      end
    end

    for index, lane in ipairs(before) do
      if index == lane_index then
        for parent_index, parent in ipairs(commit.parents) do
          if not existing[parent] then
            after[#after + 1] = {
              target = parent,
              color = parent_index == 1 and current.color or color(),
            }
            existing[parent] = true
          end
        end
      else
        after[#after + 1] = lane
      end
    end

    local edges = {}
    for index, lane in ipairs(before) do
      if index == lane_index then
        for parent_index, parent in ipairs(commit.parents) do
          local destination = find_lane(after, parent)
          if destination then
            edges[#edges + 1] = {
              from = index,
              to = destination,
              color = parent_index == 1 and current.color or after[destination].color,
            }
          end
        end
      else
        edges[#edges + 1] = {
          from = index,
          to = find_lane(after, lane.target),
          color = lane.color,
        }
      end
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

function M.text_row(row, width)
  local cells = {}
  for index = 1, width do
    cells[index] = " "
  end
  for index in ipairs(row.before) do
    local position = index * 3 - 1
    if position <= width then
      cells[position] = index == row.lane and "●" or "│"
    end
  end
  return table.concat(cells)
end

function M.svg(layout, first_row, last_row, graph_columns, cell_width, cell_height)
  local width = math.floor(graph_columns * cell_width)
  local height = math.floor((last_row - first_row + 1) * cell_height)
  local output = {
    string.format(
      '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">',
      width,
      height,
      width,
      height
    ),
  }

  local function x(lane)
    return (lane * 3 - 1.5) * cell_width
  end

  local function y(row)
    return (row - first_row + 0.5) * cell_height
  end

  for index = math.max(1, first_row - 1), math.min(#layout.rows, last_row) do
    local row = layout.rows[index]
    if index < #layout.rows then
      for _, edge in ipairs(row.edges) do
        local start_x, end_x = x(edge.from), x(edge.to)
        local start_y, end_y = y(index), y(index + 1)
        local middle_y = (start_y + end_y) / 2
        output[#output + 1] = string.format(
          '<path d="M %.1f %.1f C %.1f %.1f %.1f %.1f %.1f %.1f" fill="none" stroke="%s" stroke-width="2.5" stroke-linecap="round"/>',
          start_x,
          start_y,
          start_x,
          middle_y,
          end_x,
          middle_y,
          end_x,
          end_y,
          edge.color
        )
      end
    end
  end

  for index = first_row, last_row do
    local row = layout.rows[index]
    if row then
      output[#output + 1] = string.format(
        '<circle cx="%.1f" cy="%.1f" r="5.2" fill="#20242d" stroke="%s" stroke-width="2.8"/>',
        x(row.lane),
        y(index),
        row.color
      )
    end
  end

  output[#output + 1] = "</svg>"
  return table.concat(output)
end

return M
