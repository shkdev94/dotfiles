local graph = require("git.graph")

local M = {}
M.__index = M

function M.new(buffer, window, layout, columns, on_failure)
  if vim.fn.executable("resvg") == 0 or not Snacks.image.supports_terminal() then
    return nil
  end

  local self = setmetatable({
    buffer = buffer,
    window = window,
    layout = layout,
    columns = columns,
    on_failure = on_failure,
    chunks = {},
    chunk_size = math.min(24, vim.api.nvim_win_get_height(window)),
    directory = vim.fn.tempname(),
  }, M)
  vim.fn.mkdir(self.directory, "p")
  return self
end

function M:close()
  self.closed = true
  for _, chunk in pairs(self.chunks) do
    if chunk.placement then
      chunk.placement:close()
    end
  end
  vim.fn.delete(self.directory, "rf")
end

function M:visible()
  if self.closed or not vim.api.nvim_win_is_valid(self.window) or self.chunk_size < 1 then
    return
  end
  local bounds = vim.api.nvim_win_call(self.window, function()
    return { vim.fn.line("w0"), vim.fn.line("w$") }
  end)
  local first_chunk = math.floor((bounds[1] - 1) / self.chunk_size)
  local last_chunk = math.floor((bounds[2] - 1) / self.chunk_size)
  for chunk_index = first_chunk, last_chunk do
    self:show_chunk(chunk_index)
  end
end

function M:show_chunk(chunk_index)
  if self.chunks[chunk_index] then
    return
  end
  local first_row = chunk_index * self.chunk_size + 1
  local last_row = math.min(#self.layout.rows, first_row + self.chunk_size - 1)
  if first_row > last_row then
    return
  end

  local terminal_size = Snacks.image.terminal.size()
  local source = self.directory .. "/" .. chunk_index .. ".svg"
  local target = self.directory .. "/" .. chunk_index .. ".png"
  local file = assert(io.open(source, "wb"))
  file:write(
    graph.svg(
      self.layout,
      first_row,
      last_row,
      self.columns,
      terminal_size.cell_width,
      terminal_size.cell_height
    )
  )
  file:close()

  local chunk = {}
  self.chunks[chunk_index] = chunk
  vim.system({ "resvg", source, target }, { text = true }, function(result)
    vim.schedule(function()
      if self.closed or not vim.api.nvim_buf_is_valid(self.buffer) then
        return
      end
      if result.code ~= 0 then
        self.on_failure(vim.trim(result.stderr or "Unable to render Git graph"))
        return
      end
      chunk.placement = Snacks.image.placement.new(self.buffer, target, {
        inline = true,
        conceal = true,
        pos = { first_row, 0 },
        range = { first_row, 0, last_row, self.columns },
        width = self.columns,
        height = last_row - first_row + 1,
      })
    end)
  end)
end

return M
