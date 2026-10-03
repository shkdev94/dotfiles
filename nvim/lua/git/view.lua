local data = require("git.data")
local graph = require("git.graph")

local M = {}
local current
local window_options
local graph_namespace = vim.api.nvim_create_namespace("git.lua.graph")

vim.api.nvim_set_hl(0, "GitLuaActiveBorder", { fg = "#d55bfa", bold = true, default = true })
vim.api.nvim_set_hl(0, "GitLuaInactiveBorder", { fg = "#596273", default = true })

local function buffer()
  local result = vim.api.nvim_create_buf(false, true)
  vim.bo[result].bufhidden = "wipe"
  vim.bo[result].swapfile = false
  vim.bo[result].filetype = "gitview"
  return result
end

local function lines(target, content)
  vim.bo[target].modifiable = true
  vim.api.nvim_buf_set_lines(target, 0, -1, false, #content > 0 and content or { "" })
  vim.bo[target].modifiable = false
end

local function valid(state)
  return current == state and vim.api.nvim_tabpage_is_valid(state.tab)
end

local function pane_configs(page)
  local columns = vim.o.columns
  local rows = vim.o.lines - vim.o.cmdheight - 1
  if columns < 54 or rows < 20 then
    return nil
  end
  local outer_width = math.min(columns - 2, math.floor(columns * 0.96))
  local height = math.min(rows - 4, math.floor(rows * 0.90) - 2)
  local inner_width = outer_width - 6
  local left_width = math.max(12, math.floor(inner_width * (page == "diff" and 0.22 or 0.20)))
  local right_width = math.max(18, math.floor(inner_width * (page == "diff" and 0.39 or 0.31)))
  local center_width = inner_width - left_width - right_width
  local column = math.floor((columns - outer_width) / 2)
  local row = math.max(1, math.floor((rows - height - 2) / 2))
  local widths = { left_width, center_width, right_width }
  local configs = {}
  for index, width in ipairs(widths) do
    configs[index] = {
      relative = "editor",
      row = row,
      col = column,
      width = width,
      height = height,
      border = "rounded",
      style = "minimal",
      zindex = 50,
    }
    column = column + width + 2
  end
  if page == "main" then
    local details_ratio = height < 28 and 0.60 or 0.42
    local details_height = math.max(6, math.floor((height - 2) * details_ratio))
    local files_height = height - 2 - details_height
    configs[3].height = details_height
    configs[4] = vim.tbl_extend("force", configs[3], {
      row = row + details_height + 2,
      height = files_height,
    })
  end
  return configs
end

local function close_windows(state)
  state.transitioning = true
  for _, window in ipairs(state.windows or {}) do
    if vim.api.nvim_win_is_valid(window) then
      vim.api.nvim_win_close(window, true)
    end
  end
  state.windows = {}
  state.transitioning = false
end

local function open_windows(state, buffers)
  local configs = assert(pane_configs(state.page))
  state.windows = {}
  for index, target in ipairs(buffers) do
    local window = vim.api.nvim_open_win(target, index == 2, configs[index])
    window_options(window)
    state.windows[index] = window
  end
  return unpack(state.windows)
end

local function update_borders(state)
  if not valid(state) or state.transitioning then
    return
  end
  local focused = vim.api.nvim_get_current_win()
  for _, window in ipairs(state.windows or {}) do
    if vim.api.nvim_win_is_valid(window) then
      local group = focused == window and "GitLuaActiveBorder" or "GitLuaInactiveBorder"
      vim.wo[window].winhighlight = "FloatBorder:" .. group
    end
  end
end

local function short(text, width)
  text = text or ""
  if width < 1 then
    return ""
  end
  if vim.fn.strdisplaywidth(text) <= width then
    return text
  end
  while vim.fn.strdisplaywidth(text) > width - 1 and text ~= "" do
    text = vim.fn.strcharpart(text, 0, vim.fn.strchars(text) - 1)
  end
  return text .. "…"
end

local function padded(text, width)
  text = short(text, width)
  return text .. string.rep(" ", math.max(0, width - vim.fn.strdisplaywidth(text)))
end

window_options = function(window)
  vim.wo[window].number = false
  vim.wo[window].relativenumber = false
  vim.wo[window].signcolumn = "no"
  vim.wo[window].foldcolumn = "0"
  vim.wo[window].wrap = false
  vim.wo[window].cursorline = true
end

local function map(target, key, callback, description)
  vim.keymap.set("n", key, callback, { buffer = target, silent = true, desc = description })
end

local function common_maps(state, target)
  map(target, "<Tab>", function()
    local active = vim.api.nvim_get_current_win()
    local windows = state.windows
    for index, window in ipairs(windows) do
      if window == active then
        vim.api.nvim_set_current_win(windows[index % #windows + 1])
        return
      end
    end
  end, "Next Git pane")
  map(target, "<S-Tab>", function()
    local active = vim.api.nvim_get_current_win()
    local windows = state.windows
    for index, window in ipairs(windows) do
      if window == active then
        vim.api.nvim_set_current_win(windows[(index - 2) % #windows + 1])
        return
      end
    end
  end, "Previous Git pane")
  map(target, "r", function()
    M.refresh(state)
  end, "Refresh Git view")
end

local function style_details(target, content, color)
  vim.api.nvim_buf_clear_namespace(target, graph_namespace, 0, -1)
  if color then
    vim.api.nvim_buf_set_extmark(target, graph_namespace, 0, 0, {
      line_hl_group = graph.row_highlight_group(color),
      priority = 10,
    })
  end
  for index, line in ipairs(content) do
    if line:find("^ Message$") or line:find("^ Changed files") or line:match("^ %u+ %(") then
      vim.api.nvim_buf_add_highlight(target, graph_namespace, "Title", index - 1, 1, #line)
    elseif line:find("^ Branches") and color then
      vim.api.nvim_buf_add_highlight(
        target,
        graph_namespace,
        graph.highlight_group(color),
        index - 1,
        1,
        9
      )
    elseif line:match("^  [AMDRCU%?]  ") then
      local status = line:sub(3, 3)
      local group = (status == "A" or status == "?") and "DiffAdd"
        or status == "D" and "DiffDelete"
        or "DiffChange"
      vim.api.nvim_buf_add_highlight(target, graph_namespace, group, index - 1, 2, 3)
    end
  end
end

local function wrap_line(line, width)
  local wrapped = {}
  local current = ""
  for index = 0, vim.fn.strchars(line) - 1 do
    local character = vim.fn.strcharpart(line, index, 1)
    if current ~= "" and vim.fn.strdisplaywidth(current .. character) > width then
      local prefix, suffix = current:match("^(.*%S)%s+(%S+)$")
      if prefix and vim.fn.strdisplaywidth("  " .. suffix .. character) <= width then
        wrapped[#wrapped + 1] = prefix
        current = "  " .. suffix .. character
      else
        wrapped[#wrapped + 1] = current
        current = "  " .. character
      end
    else
      current = current .. character
    end
  end
  wrapped[#wrapped + 1] = current
  return wrapped
end

local function render_detail_info(state, content, color)
  state.detail_content = content
  state.detail_color = color
  local width = math.max(4, vim.api.nvim_win_get_width(state.detail_window) - 2)
  local height = vim.fn.getwininfo(state.detail_window)[1].height
  local visible = {}
  local overflow = false
  for _, line in ipairs(content) do
    for _, part in ipairs(wrap_line(line, width)) do
      if #visible >= height then
        overflow = true
        break
      end
      visible[#visible + 1] = part
    end
    if overflow then
      break
    end
  end
  if overflow then
    visible[#visible] = short(visible[#visible], width - 1) .. "…"
  end
  lines(state.detail_buffer, visible)
  style_details(state.detail_buffer, visible, color)
end

local function render_changed_files(state, content)
  lines(state.detail_files_buffer, content)
  style_details(state.detail_files_buffer, content)
  vim.wo[state.detail_files_window].winbar =
    string.format(" Changed files (%d) · Enter: compare", #state.detail_files)
end

local function show_status(state)
  if not valid(state) or state.page ~= "main" then
    return
  end
  state.cursor_request = (state.cursor_request or 0) + 1
  state.detail_request = (state.detail_request or 0) + 1
  state.selected = nil
  state.detail_files = state.status or {}
  state.detail_lines = {}
  local info = {
    " Working tree",
    " Branch: " .. (state.head ~= "" and state.head or "detached HEAD"),
    " " .. vim.fs.basename(state.root),
  }
  local file_lines = {}
  local counts = {}
  for _, kind in ipairs({ "staged", "unstaged", "untracked" }) do
    local count = 0
    local first_index
    for index, file in ipairs(state.detail_files) do
      if file.kind == kind then
        count = count + 1
        first_index = first_index or index
      end
    end
    counts[kind] = count
    if count > 0 then
      if #file_lines > 0 then
        file_lines[#file_lines + 1] = ""
      end
      file_lines[#file_lines + 1] = " " .. kind:upper() .. " (" .. count .. ")"
      state.detail_lines[#file_lines] = first_index
    end
    for index, file in ipairs(state.detail_files) do
      if file.kind == kind then
        file_lines[#file_lines + 1] = string.format("  %s  %s", file.status, file.path)
        state.detail_lines[#file_lines] = index
      end
    end
  end
  info[#info + 1] = ""
  info[#info + 1] = string.format(" Staged %d · Unstaged %d", counts.staged, counts.unstaged)
  info[#info + 1] = " Untracked " .. counts.untracked
  if #state.detail_files == 0 then
    file_lines[1] = " No changed files"
  end
  render_detail_info(state, info)
  render_changed_files(state, file_lines)
end

local function show_commit(state, commit)
  if not valid(state) or state.page ~= "main" then
    return
  end
  state.selected = commit
  state.detail_request = (state.detail_request or 0) + 1
  local request = state.detail_request
  state.detail_files = {}
  state.detail_lines = {}
  state.branch_cache = state.branch_cache or {}
  local branches = state.branch_cache[commit.id]
  local branch_error
  local color = state.commit_colors and state.commit_colors[commit.id]
  local hash_width = math.min(12, math.max(7, vim.api.nvim_win_get_width(state.detail_window) - 10))
  local display_hash = commit.id:sub(1, hash_width)
  local loading = {
    " Commit " .. display_hash,
    " Author: " .. (commit.author or ""),
    " Date: " .. (commit.date or ""),
    "",
    " Message",
    " Loading details…",
  }
  render_detail_info(state, loading, color)
  render_changed_files(state, { " Loading changed files…" })

  local message, files
  local function render()
    if not valid(state) or state.page ~= "main" or state.detail_request ~= request then
      return
    end
    if message == nil or files == nil then
      return
    end
    local output = {
      " Commit " .. display_hash,
      " Author: " .. (commit.author or ""),
      " Date: " .. (commit.date or ""),
      branch_error and " Branches: unavailable" or branches and string.format(
        " Branches (%d): %s",
        #branches,
        #branches > 0 and table.concat(branches, ", ") or "none"
      ) or " Branches: loading…",
      "",
      " Message",
    }
    for _, line in ipairs(vim.split(vim.trim(message), "\n", { plain = true })) do
      output[#output + 1] = " " .. line
    end
    render_detail_info(state, output, color)
    if state.detail_files ~= files then
      state.detail_files = files
      state.detail_lines = {}
      local file_lines = {}
      for index, file in ipairs(files) do
        file_lines[#file_lines + 1] = string.format("  %s  %s", file.status, file.path)
        state.detail_lines[#file_lines] = index
      end
      if #files == 0 then
        file_lines[1] = " No file changes"
      end
      render_changed_files(state, file_lines)
    end
  end

  data.commit_message(state.root, commit, function(error_message, result)
    message = error_message and error_message or result
    render()
  end)
  data.commit_files(state.root, commit, function(error_message, result)
    files = error_message and {} or result
    if error_message then
      message = error_message
    end
    render()
  end)
  if not branches then
    vim.defer_fn(function()
      if not valid(state) or state.page ~= "main" or state.detail_request ~= request then
        return
      end
      data.containing_branches(state.root, commit.id, function(error_message, result)
        if not valid(state) or state.detail_request ~= request then
          return
        end
        branch_error = error_message
        branches = error_message and {} or result
        if not error_message then
          state.branch_cache[commit.id] = branches
        end
        render()
      end)
    end, 180)
  end
end

local function decorate(state)
  local references = {}
  for _, reference in ipairs(state.refs or {}) do
    if not (reference.kind == "Remote branches" and reference.name:match("/HEAD$")) then
      references[reference.id] = references[reference.id] or {}
      table.insert(references[reference.id], reference)
    end
  end
  local priority = { ["Local branches"] = 1, Tags = 2, ["Remote branches"] = 3 }
  for _, items in pairs(references) do
    table.sort(items, function(left, right)
      local left_priority = priority[left.kind] or 4
      local right_priority = priority[right.kind] or 4
      return left_priority == right_priority and left.name < right.name
        or left_priority < right_priority
    end)
  end
  return references
end

local function ref_summary(references)
  if not references or #references == 0 then
    return nil
  end
  local label = references[1].name
  if #references > 1 then
    label = label .. " +" .. (#references - 1)
  end
  return label
end

local function render_history(state)
  if not valid(state) or state.page ~= "main" or not state.center_buffer then
    return
  end
  local width = vim.api.nvim_win_get_width(state.center_window)
  local result = {}
  local graph_spans = {}
  local row_colors = {}
  local label_spans = {}
  state.history_lines = {}
  state.load_more_line = nil
  local references = decorate(state)

  if state.mode == "reflog" then
    for index, entry in ipairs(state.reflog or {}) do
      result[index] = string.format(
        " %s  %s  %s",
        padded(entry.selector, 12),
        entry.id:sub(1, 7),
        short(entry.subject, width - 26)
      )
      state.history_lines[index] = entry
    end
    if #result == 0 then
      result[1] = " No reflog entries"
    end
  else
    state.layout = graph.layout(state.commits or {})
    state.commit_colors = {}
    local label_width = width >= 80 and math.min(22, math.floor(width * 0.22)) or 0
    local graph_width = math.max(
      6,
      math.min(34, state.layout.lanes * 3 + 2, math.floor((width - label_width) * 0.45))
    )
    local content_width = math.max(1, width - label_width - graph_width - 2)

    local function append(graph_text, spans, content, commit, color, label)
      local line = #result + 1
      local prefix = string.rep(" ", label_width)
      if label and label_width > 0 then
        local text = short(label, label_width - 2)
        prefix = " " .. padded(text, label_width - 1)
        label_spans[line] = { start = 1, finish = 1 + #text, color = color }
      end
      result[line] = prefix .. graph_text .. "  " .. short(content, content_width)
      graph_spans[line] = { offset = #prefix, spans = spans }
      row_colors[line] = color
      state.history_lines[line] = commit
    end

    for _, row in ipairs(state.layout.rows) do
      local commit = row.commit
      local label = ref_summary(references[commit.id])
      state.commit_colors[commit.id] = row.color
      local metadata = commit.id:sub(1, 7)
      if width >= 72 then
        metadata = metadata .. "  " .. padded(commit.author, 12) .. "  " .. commit.date:sub(1, 10)
      elseif width >= 55 then
        metadata = metadata .. "  " .. commit.date:sub(1, 10)
      end
      if label and label_width == 0 then
        metadata = metadata .. "  [" .. label .. "]"
      end

      local commit_text, commit_spans = graph.commit_line(row, graph_width)
      append(commit_text, commit_spans, metadata, commit, row.color, label)
      local connector_text, connector_spans = graph.connector_line(row, graph_width)
      append(connector_text, connector_spans, commit.subject, commit, row.color)
    end
    if #(state.commits or {}) == state.max_commits then
      state.load_more_line = #result + 1
      result[state.load_more_line] = " + Load more commits"
    end
    if #result == 0 then
      result[1] = " No commits"
    end
  end
  lines(state.center_buffer, result)
  vim.api.nvim_buf_clear_namespace(state.center_buffer, graph_namespace, 0, -1)
  for line, color in pairs(row_colors) do
    vim.api.nvim_buf_set_extmark(state.center_buffer, graph_namespace, line - 1, 0, {
      line_hl_group = graph.row_highlight_group(color),
      priority = 10,
    })
  end
  for line, label in pairs(label_spans) do
    vim.api.nvim_buf_add_highlight(
      state.center_buffer,
      graph_namespace,
      graph.ref_highlight_group(label.color),
      line - 1,
      label.start,
      label.finish
    )
  end
  for line, graph_line in pairs(graph_spans) do
    for _, span in ipairs(graph_line.spans) do
      vim.api.nvim_buf_add_highlight(
        state.center_buffer,
        graph_namespace,
        graph.highlight_group(span.color),
        line - 1,
        graph_line.offset + span.start,
        graph_line.offset + span.finish
      )
    end
  end
  vim.wo[state.center_window].winbar = state.mode == "reflog"
      and " Reflog · C: commits · Enter: select"
    or (
      (width >= 80 and " Branch / Tag │ Graph │ Commit" or " Git graph")
      .. (state.reference and (" · " .. state.reference:gsub("^refs/", "")) or "")
      .. " · R: reflog · +: more · Enter: select"
    )
end

local function render_sidebar(state)
  if not valid(state) or state.page ~= "main" or not state.sidebar_buffer then
    return
  end
  local sidebar_width = vim.api.nvim_win_get_width(state.sidebar_window)
  local output = {
    " Repository · " .. vim.fs.basename(state.root),
    " " .. short(state.root, sidebar_width - 2),
    "",
  }
  local headings = { 1 }
  local ref_spans = {}
  state.sidebar_lines = {}
  local sections = {
    {
      title = "Local branches",
      short_title = "Local",
      items = state.refs or {},
      kind = "Local branches",
    },
    {
      title = "Remote branches",
      short_title = "Remote",
      items = state.refs or {},
      kind = "Remote branches",
    },
    { title = "Tags", short_title = "Tags", items = state.refs or {}, kind = "Tags" },
    { title = "Worktrees", short_title = "Worktrees", items = state.worktrees or {} },
    { title = "Submodules", short_title = "Submodules", items = state.submodules or {} },
  }
  for _, section in ipairs(sections) do
    local count = 0
    for _, item in ipairs(section.items) do
      if not section.kind or item.kind == section.kind then
        count = count + 1
      end
    end
    local title = sidebar_width >= 24 and section.title or section.short_title
    output[#output + 1] = string.format(" %s (%d)", title, count)
    headings[#headings + 1] = #output
    for _, item in ipairs(section.items) do
      if not section.kind or item.kind == section.kind then
        local name = item.name or item.path
        if section.title == "Worktrees" then
          name = (item.branch or "detached") .. " · " .. vim.fs.basename(item.path)
        elseif section.title == "Submodules" then
          name = item.path .. " " .. (item.id or ""):sub(1, 7)
        end
        local color = state.commit_colors and state.commit_colors[item.id]
        local marker = item.kind and "●" or " "
        if item.kind == "Local branches" and item.name == state.head then
          marker = "◆"
        end
        if section.title == "Worktrees" and item.path == state.root then
          marker = "●"
        elseif section.title == "Submodules" then
          marker = item.state == " " and "○" or (item.state or "!")
        end
        output[#output + 1] = " " .. marker .. " " .. short(name or item.path, sidebar_width - 4)
        state.sidebar_lines[#output] = item
        if color then
          ref_spans[#ref_spans + 1] = { line = #output, finish = #output[#output], color = color }
        end
      end
    end
    if count == 0 then
      output[#output + 1] = "   —"
    end
    output[#output + 1] = ""
  end
  lines(state.sidebar_buffer, output)
  vim.api.nvim_buf_clear_namespace(state.sidebar_buffer, graph_namespace, 0, -1)
  for _, line in ipairs(headings) do
    vim.api.nvim_buf_add_highlight(
      state.sidebar_buffer,
      graph_namespace,
      "Title",
      line - 1,
      1,
      #output[line]
    )
  end
  for _, span in ipairs(ref_spans) do
    vim.api.nvim_buf_add_highlight(
      state.sidebar_buffer,
      graph_namespace,
      graph.ref_highlight_group(span.color),
      span.line - 1,
      1,
      span.finish
    )
  end
end

local function select_history(state)
  local line = vim.api.nvim_win_get_cursor(state.center_window)[1]
  local entry = state.history_lines[line]
  if not entry then
    return
  end
  if state.mode == "commits" then
    show_commit(state, entry)
  else
    data.run(
      state.root,
      { "show", "-s", "--format=%H%x1f%P%x1f%s%x1f%an%x1f%aI", entry.id },
      function(error_message, output)
        if error_message then
          vim.notify(error_message, vim.log.levels.ERROR)
          return
        end
        local values = vim.split(vim.trim(output), "\31", { plain = true })
        show_commit(state, {
          id = values[1],
          parents = values[2] == "" and {} or vim.split(values[2], " ", { plain = true }),
          subject = values[3],
          author = values[4],
          date = values[5],
        })
      end
    )
  end
end

local function set_mode(state, mode)
  if state.mode == mode then
    return
  end
  state.mode = mode
  show_status(state)
  render_history(state)
end

local function main_maps(state)
  for _, target in ipairs({
    state.sidebar_buffer,
    state.center_buffer,
    state.detail_buffer,
    state.detail_files_buffer,
  }) do
    common_maps(state, target)
    map(target, "q", function()
      M.close(state)
    end, "Close Git view")
    map(target, "R", function()
      set_mode(state, "reflog")
    end, "Show reflog")
    map(target, "C", function()
      set_mode(state, "commits")
    end, "Show commits")
  end
  map(state.sidebar_buffer, "<CR>", function()
    local line = vim.api.nvim_win_get_cursor(state.sidebar_window)[1]
    local reference = state.sidebar_lines[line]
    if reference and reference.ref then
      state.reference = reference.ref
      state.max_commits = 300
      M.refresh(state)
    end
  end, "Show ref history")
  map(state.sidebar_buffer, "a", function()
    state.reference = nil
    state.max_commits = 300
    M.refresh(state)
  end, "Show all refs")
  map(state.center_buffer, "<CR>", function()
    local line = vim.api.nvim_win_get_cursor(state.center_window)[1]
    if state.mode == "commits" and line == state.load_more_line then
      state.max_commits = state.max_commits + 300
      M.refresh(state)
    else
      select_history(state)
    end
  end, "Select commit")
  map(state.center_buffer, "+", function()
    if state.mode == "commits" then
      state.max_commits = state.max_commits + 300
      M.refresh(state)
    end
  end, "Load more commits")
  map(state.center_buffer, "<Esc>", function()
    show_status(state)
  end, "Show working tree")
  map(state.detail_buffer, "<CR>", function()
    vim.api.nvim_set_current_win(state.detail_files_window)
  end, "Focus changed files")
  map(state.detail_files_buffer, "<CR>", function()
    local line = vim.api.nvim_win_get_cursor(state.detail_files_window)[1]
    local file_index = state.detail_lines[line]
    if type(file_index) == "number" then
      M.open_diff(state, file_index)
    end
  end, "Compare selected file")
end

local function main_layout(state)
  state.page = "main"
  close_windows(state)
  state.center_buffer = buffer()
  state.sidebar_buffer = buffer()
  state.detail_buffer = buffer()
  state.detail_files_buffer = buffer()
  state.sidebar_window, state.center_window, state.detail_window, state.detail_files_window =
    open_windows(state, {
      state.sidebar_buffer,
      state.center_buffer,
      state.detail_buffer,
      state.detail_files_buffer,
    })
  for _, window in ipairs({ state.detail_window, state.detail_files_window }) do
    vim.wo[window].wrap = true
    vim.wo[window].linebreak = true
    vim.wo[window].breakindent = true
  end
  vim.wo[state.sidebar_window].winbar = " Refs · Enter: history · a: all"
  vim.wo[state.center_window].winbar = " Commits · R: reflog · C: commits · Enter: select"
  vim.wo[state.detail_window].winbar = " Commit details"
  main_maps(state)
  vim.api.nvim_create_autocmd("CursorMoved", {
    group = state.augroup,
    buffer = state.center_buffer,
    callback = function()
      state.cursor_request = (state.cursor_request or 0) + 1
      local request = state.cursor_request
      vim.defer_fn(function()
        if valid(state) and state.page == "main" and state.cursor_request == request then
          local line = vim.api.nvim_win_get_cursor(state.center_window)[1]
          local entry = state.history_lines[line]
          if entry and (not state.selected or state.selected.id ~= entry.id) then
            select_history(state)
          end
        end
      end, 120)
    end,
  })
  render_sidebar(state)
  render_history(state)
  show_status(state)
  vim.api.nvim_set_current_win(state.center_window)
  update_borders(state)
end

local function diff_revisions(file)
  if file.kind == "commit" then
    return file.status == "A" and "empty" or (file.commit.parents[1] or "empty"),
      file.status == "D" and "empty" or file.commit.id
  elseif file.kind == "staged" then
    return file.status == "A" and "empty" or "HEAD", file.status == "D" and "empty" or ""
  elseif file.kind == "unstaged" then
    return file.status == "A" and "empty" or "", file.status == "D" and "empty" or "worktree"
  end
  return "empty", "worktree"
end

local function diff_content(state, file, request)
  local old_revision, new_revision = diff_revisions(file)
  local old_path = file.original_path or file.path
  local new_path = file.path
  local old_content, new_content

  local function finish()
    if state.diff_request ~= request or not valid(state) or state.page ~= "diff" then
      return
    end
    if old_content == nil or new_content == nil then
      return
    end
    local function display(target, content)
      if content:find("\0", 1, true) then
        content = "Binary file (preview unavailable)"
      end
      local content_lines = vim.split(content:gsub("\n$", ""), "\n", { plain = true })
      lines(target, content_lines)
      vim.bo[target].filetype = vim.filetype.match({ filename = file.path }) or ""
    end
    display(state.old_buffer, old_content)
    display(state.new_buffer, new_content)
    vim.wo[state.old_window].winbar = " Before · " .. old_path:gsub("%%", "%%%%")
    vim.wo[state.new_window].winbar = " After · " .. new_path:gsub("%%", "%%%%")
    vim.api.nvim_win_call(state.old_window, function()
      vim.cmd("diffthis")
    end)
    vim.api.nvim_win_call(state.new_window, function()
      vim.cmd("diffthis")
    end)
  end

  data.content(state.root, old_revision, old_path, function(error_message, result)
    old_content = error_message and ("Git error: " .. error_message) or result
    finish()
  end)
  data.content(state.root, new_revision, new_path, function(error_message, result)
    new_content = error_message and ("Git error: " .. error_message) or result
    finish()
  end)
end

local function render_diff(state, file_index)
  local file = state.detail_files[file_index]
  if not file then
    return
  end
  state.diff_request = (state.diff_request or 0) + 1
  local request = state.diff_request
  state.diff_index = file_index
  for _, window in ipairs({ state.old_window, state.new_window }) do
    vim.api.nvim_win_call(window, function()
      vim.cmd("diffoff")
    end)
  end
  lines(state.old_buffer, { "Loading " .. file.path .. "…" })
  lines(state.new_buffer, { "Loading " .. file.path .. "…" })
  vim.api.nvim_win_set_cursor(state.files_window, { file_index + 2, 0 })
  diff_content(state, file, request)
end

function M.open_diff(state, file_index)
  if not valid(state) or not state.detail_files[file_index] then
    return
  end
  state.history_cursor = vim.api.nvim_win_get_cursor(state.center_window)[1]
  close_windows(state)
  state.page = "diff"
  state.old_buffer = buffer()
  state.files_buffer = buffer()
  state.new_buffer = buffer()
  state.files_window, state.old_window, state.new_window = open_windows(state, {
    state.files_buffer,
    state.old_buffer,
    state.new_buffer,
  })
  vim.wo[state.files_window].winbar = " Files · Enter: compare · q: back"
  local file_lines = { " Changed files", "" }
  for _, file in ipairs(state.detail_files) do
    file_lines[#file_lines + 1] = string.format(" %s %s", file.status, file.path)
  end
  lines(state.files_buffer, file_lines)

  for _, target in ipairs({ state.files_buffer, state.old_buffer, state.new_buffer }) do
    common_maps(state, target)
    map(target, "q", function()
      M.back(state)
    end, "Back to Git history")
    map(target, "<Esc>", function()
      M.back(state)
    end, "Back to Git history")
  end
  map(state.files_buffer, "<CR>", function()
    render_diff(state, vim.api.nvim_win_get_cursor(state.files_window)[1] - 2)
  end, "Compare file")
  render_diff(state, file_index)
  vim.api.nvim_set_current_win(state.files_window)
  update_borders(state)
end

function M.back(state)
  if not valid(state) or state.page ~= "diff" then
    return
  end
  local selected = state.selected
  for _, window in ipairs({ state.old_window, state.new_window }) do
    vim.api.nvim_win_call(window, function()
      vim.cmd("diffoff")
    end)
  end
  main_layout(state)
  if state.history_cursor then
    vim.api.nvim_win_set_cursor(state.center_window, {
      math.min(state.history_cursor, vim.api.nvim_buf_line_count(state.center_buffer)),
      0,
    })
  end
  if selected then
    show_commit(state, selected)
  end
end

function M.refresh(state)
  if not valid(state) then
    return
  end
  state.refresh_request = (state.refresh_request or 0) + 1
  local request = state.refresh_request
  local function update(callback)
    return function(error_message, result)
      if not valid(state) or state.refresh_request ~= request then
        return
      end
      if error_message then
        vim.notify("git.lua: " .. error_message, vim.log.levels.WARN)
        return
      end
      callback(result)
    end
  end

  data.commits(
    state.root,
    state.reference,
    state.max_commits,
    update(function(commits)
      state.commits = commits
      render_history(state)
      render_sidebar(state)
    end)
  )
  data.refs(
    state.root,
    update(function(refs)
      state.refs = refs
      render_history(state)
      render_sidebar(state)
    end)
  )
  data.status(
    state.root,
    update(function(files)
      state.status = files
      if not state.selected then
        show_status(state)
      end
    end)
  )
  data.worktrees(
    state.root,
    update(function(worktrees)
      state.worktrees = worktrees
      render_sidebar(state)
    end)
  )
  data.submodules(
    state.root,
    update(function(submodules)
      state.submodules = submodules
      render_sidebar(state)
    end)
  )
  data.reflog(
    state.root,
    update(function(reflog)
      state.reflog = reflog
      if state.mode == "reflog" then
        render_history(state)
      end
    end)
  )
  data.run(
    state.root,
    { "branch", "--show-current" },
    update(function(head)
      state.head = vim.trim(head)
      render_sidebar(state)
      if not state.selected then
        show_status(state)
      end
    end)
  )
end

function M.close(state)
  if current ~= state then
    return
  end
  current = nil
  vim.api.nvim_del_augroup_by_id(state.augroup)
  close_windows(state)
  if vim.api.nvim_win_is_valid(state.anchor_window) then
    vim.api.nvim_set_current_win(state.anchor_window)
  end
end

function M.open()
  if current and valid(current) then
    vim.api.nvim_set_current_tabpage(current.tab)
    local window = current.page == "diff" and current.files_window or current.center_window
    if vim.api.nvim_win_is_valid(window) then
      vim.api.nvim_set_current_win(window)
    end
    update_borders(current)
    return
  end
  if not pane_configs("main") then
    vim.notify("git.lua: terminal is too small for the Git view", vim.log.levels.ERROR)
    return
  end
  local root, error_message = data.root()
  if not root then
    vim.notify("git.lua: " .. error_message, vim.log.levels.ERROR)
    return
  end
  local state = {
    root = root,
    tab = vim.api.nvim_get_current_tabpage(),
    anchor_window = vim.api.nvim_get_current_win(),
    mode = "commits",
    max_commits = 300,
    head = "",
    commits = {},
    status = {},
  }
  current = state
  state.augroup = vim.api.nvim_create_augroup("GitLuaView", { clear = true })
  main_layout(state)
  M.refresh(state)
  vim.api.nvim_create_autocmd("VimResized", {
    group = state.augroup,
    callback = function()
      if not valid(state) then
        return
      end
      local configs = pane_configs(state.page)
      if not configs then
        M.close(state)
        return
      end
      for index, window in ipairs(state.windows) do
        if vim.api.nvim_win_is_valid(window) then
          vim.api.nvim_win_set_config(window, configs[index])
        end
      end
      if state.page == "main" then
        render_sidebar(state)
        render_history(state)
        if state.detail_content then
          render_detail_info(state, state.detail_content, state.detail_color)
        end
      end
      update_borders(state)
    end,
  })
  vim.api.nvim_create_autocmd("WinEnter", {
    group = state.augroup,
    callback = function()
      update_borders(state)
    end,
  })
  vim.api.nvim_create_autocmd("WinClosed", {
    group = state.augroup,
    callback = function(event)
      if current ~= state or state.transitioning then
        return
      end
      for _, window in ipairs(state.windows) do
        if tonumber(event.match) == window then
          M.close(state)
          return
        end
      end
    end,
  })
  vim.api.nvim_create_autocmd("TabClosed", {
    group = state.augroup,
    callback = function()
      if not vim.api.nvim_tabpage_is_valid(state.tab) then
        if current == state then
          current = nil
        end
        vim.api.nvim_del_augroup_by_id(state.augroup)
      end
    end,
  })
end

return M
