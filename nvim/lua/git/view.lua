local data = require("git.data")
local graph = require("git.graph")

local M = {}
local current
local window_options
local graph_namespace = vim.api.nvim_create_namespace("git.lua.graph")
local selection_namespace = vim.api.nvim_create_namespace("git.lua.selection")
local working_tree_id = "__git_lua_working_tree__"
local ref_tabs = {
  { label = "Local", short = "L", kind = "Local branches" },
  { label = "Remote", short = "R", kind = "Remote branches" },
  { label = "Tags", short = "T", kind = "Tags" },
}
local history_tabs = {
  { label = "Graph", short = "G", mode = "commits" },
  { label = "Reflog", short = "R", mode = "reflog" },
}
local extras_tabs = {
  { label = "Worktrees", short = "W", items = "worktrees" },
  { label = "Submodules", short = "S", items = "submodules" },
}
local icons = { branch = "", tag = "", folder = "" }

local function icon_prefix(icon, checked_out)
  return (checked_out and " ✓ " or " ") .. icon .. " "
end

vim.api.nvim_set_hl(0, "GitLuaActiveBorder", { fg = "#d55bfa", bold = true, default = true })
vim.api.nvim_set_hl(0, "GitLuaInactiveBorder", { fg = "#596273", default = true })
vim.api.nvim_set_hl(0, "GitLuaHiddenCursor", { blend = 100, default = true })
vim.api.nvim_set_hl(0, "GitLuaActiveTab", { fg = "#d55bfa", bold = true, default = true })
vim.api.nvim_set_hl(0, "GitLuaInactiveTab", { fg = "#89919e", default = true })
vim.api.nvim_set_hl(0, "GitLuaCurrentBranch", { fg = "#d55bfa", bold = true, default = true })

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

local function pane_configs(page, show_details)
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
  local titles = page == "main"
      and {
        " [1] Local · Remote · Tags ",
        " [3] Graph · Reflog ",
        " [4] Commit details ",
        " [5] Changed files ",
      }
    or { " [1] Files ", " [2] Before ", " [3] After " }
  local footers = page == "main"
      and { " Enter: history · a: all ", " R: reflog · +: more ", nil, " Enter: compare " }
    or { " Enter: compare · q: back " }
  local configs = {}
  for index, width in ipairs(widths) do
    configs[index] = {
      relative = "editor",
      row = row,
      col = column,
      width = width,
      height = height,
      border = "rounded",
      title = titles[index],
      title_pos = "left",
      footer = footers[index],
      footer_pos = footers[index] and "right" or nil,
      style = "minimal",
      zindex = 50,
    }
    column = column + width + 2
  end
  if page == "main" then
    local refs_height = math.max(6, math.floor((height - 2) * 0.58))
    configs[1].height = refs_height
    configs[5] = vim.tbl_extend("force", configs[1], {
      row = row + refs_height + 2,
      height = height - 2 - refs_height,
      title = " [2] Worktrees · Submodules ",
    })
    configs[5].footer = nil
    configs[5].footer_pos = nil
    if show_details then
      local details_ratio = height < 28 and 0.60 or 0.42
      local details_height = math.max(6, math.floor((height - 2) * details_ratio))
      local files_height = height - 2 - details_height
      configs[3].height = details_height
      configs[3].hide = false
      configs[4] = vim.tbl_extend("force", configs[3], {
        row = row + details_height + 2,
        height = files_height,
        title = titles[4],
        footer = footers[4],
        footer_pos = "right",
      })
    else
      configs[3].hide = true
      configs[4] = vim.tbl_extend("force", configs[3], {
        hide = false,
        title = " [4] Changed files ",
        footer = footers[4],
        footer_pos = "right",
      })
    end
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
  local configs = assert(pane_configs(state.page, state.selected ~= nil))
  state.windows = {}
  for index, target in ipairs(buffers) do
    local window = vim.api.nvim_open_win(target, index == 2, configs[index])
    window_options(window)
    state.windows[index] = window
  end
  return unpack(state.windows)
end

local function restore_cursor(state)
  if not state.cursor_hidden then
    return
  end
  if vim.o.guicursor == state.hidden_guicursor then
    vim.o.guicursor = state.saved_guicursor
  end
  state.cursor_hidden = false
  state.saved_guicursor = nil
  state.hidden_guicursor = nil
end

local function update_cursor_visibility(state)
  local focused = vim.api.nvim_get_current_win()
  local on_git_list = state.page == "main"
      and (focused == state.sidebar_window or focused == state.extras_window or focused == state.center_window or focused == state.detail_files_window)
    or state.page == "diff" and focused == state.files_window
  if on_git_list and not state.cursor_hidden then
    state.saved_guicursor = vim.o.guicursor
    state.hidden_guicursor = state.saved_guicursor == "" and "n:block-GitLuaHiddenCursor"
      or state.saved_guicursor .. ",n:block-GitLuaHiddenCursor"
    vim.o.guicursor = state.hidden_guicursor
    state.cursor_hidden = true
  elseif not on_git_list then
    restore_cursor(state)
  end
end

local function update_borders(state)
  if not valid(state) or state.transitioning then
    return
  end
  local focused = vim.api.nvim_get_current_win()
  for _, window in ipairs(state.windows or {}) do
    if vim.api.nvim_win_is_valid(window) then
      local group = focused == window and "GitLuaActiveBorder" or "GitLuaInactiveBorder"
      local list_window = state.page == "main"
          and (window == state.sidebar_window or window == state.extras_window or window == state.center_window or window == state.detail_files_window)
        or state.page == "diff" and window == state.files_window
      if list_window and window ~= state.center_window then
        vim.wo[window].cursorline = focused == window
      end
      vim.wo[window].winhighlight = "NormalFloat:Normal,EndOfBuffer:Normal,FloatBorder:"
        .. group
        .. ",FloatTitle:"
        .. group
        .. ",FloatFooter:"
        .. group
        .. (list_window and focused == window and ",CursorLine:Visual" or "")
    end
  end
  update_cursor_visibility(state)
end

local function focus_windows(state)
  if state.page == "main" then
    local windows = { state.sidebar_window, state.extras_window, state.center_window }
    if state.selected then
      windows[#windows + 1] = state.detail_window
    end
    windows[#windows + 1] = state.detail_files_window
    return windows
  end
  return state.windows
end

local function update_right_layout(state)
  if not valid(state) or state.page ~= "main" then
    return
  end
  if not state.selected and vim.api.nvim_get_current_win() == state.detail_window then
    vim.api.nvim_set_current_win(state.detail_files_window)
  end
  local configs = assert(pane_configs("main", state.selected ~= nil))
  vim.api.nvim_win_set_config(state.detail_window, configs[3])
  vim.api.nvim_win_set_config(state.detail_files_window, configs[4])
  update_borders(state)
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

local function set_title(window, index, label, footer)
  local width = vim.api.nvim_win_get_width(window)
  local title = short(string.format(" [%d] %s ", index, label), width - 2)
  local config = { title = title, title_pos = "left" }
  if footer then
    config.footer = short(footer, width - 2)
    config.footer_pos = "right"
  end
  vim.api.nvim_win_set_config(window, config)
end

local function set_tabs_title(window, index, tabs, active, footer)
  local width = vim.api.nvim_win_get_width(window) - 2
  local prefix = string.format(" [%d]", index)
  local names = vim.tbl_map(function(tab)
    return tab.label
  end, tabs)
  if vim.fn.strdisplaywidth(prefix .. " " .. table.concat(names, " ") .. " ") > width then
    names = vim.tbl_map(function(tab)
      return tab.short
    end, tabs)
  end
  local title = { { prefix, "FloatTitle" } }
  if vim.fn.strdisplaywidth(prefix .. " " .. table.concat(names, " ") .. " ") > width then
    title[#title + 1] = { " " .. short(tabs[active].label, width - #prefix - 1), "GitLuaActiveTab" }
  else
    for tab_index, name in ipairs(names) do
      title[#title + 1] = {
        " " .. name,
        tab_index == active and "GitLuaActiveTab" or "GitLuaInactiveTab",
      }
    end
    title[#title + 1] = { " ", "FloatTitle" }
  end
  vim.api.nvim_win_set_config(window, {
    title = title,
    title_pos = "left",
    footer = short(footer, width),
    footer_pos = "right",
  })
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
  map(target, "<Down>", "j", "Move down")
  map(target, "<Up>", "k", "Move up")
  map(target, "<Tab>", function()
    local active = vim.api.nvim_get_current_win()
    local windows = focus_windows(state)
    for index, window in ipairs(windows) do
      if window == active then
        vim.api.nvim_set_current_win(windows[index % #windows + 1])
        return
      end
    end
  end, "Next Git pane")
  map(target, "<S-Tab>", function()
    local active = vim.api.nvim_get_current_win()
    local windows = focus_windows(state)
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

local function style_details(target, content)
  vim.api.nvim_buf_clear_namespace(target, graph_namespace, 0, -1)
  for index, line in ipairs(content) do
    if
      line:find("^ Message$")
      or line:find("^ Tags$")
      or line:find("^ Changed files")
      or line:match("^ %u+ %(")
    then
      vim.api.nvim_buf_add_highlight(target, graph_namespace, "Title", index - 1, 1, #line)
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
      if
        prefix
        and vim.fn.strchars(vim.trim(prefix)) > 1
        and vim.fn.strdisplaywidth("  " .. suffix .. character) <= width
      then
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

local function render_detail_info(state, content)
  state.detail_content = content
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
  style_details(state.detail_buffer, visible)
end

local function render_changed_files(state, content)
  lines(state.detail_files_buffer, content)
  style_details(state.detail_files_buffer, content)
  set_title(
    state.detail_files_window,
    state.selected and 5 or 4,
    string.format("Changed files (%d)", #state.detail_files)
  )
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
  state.detail_content = nil
  update_right_layout(state)
  lines(state.detail_buffer, { "" })
  vim.api.nvim_buf_clear_namespace(state.detail_buffer, graph_namespace, 0, -1)
  local file_lines = {}
  for _, kind in ipairs({ "staged", "unstaged", "untracked" }) do
    local count = 0
    local first_index
    for index, file in ipairs(state.detail_files) do
      if file.kind == kind then
        count = count + 1
        first_index = first_index or index
      end
    end
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
  if #state.detail_files == 0 then
    file_lines[1] = " No changed files"
  end
  render_changed_files(state, file_lines)
end

local function show_commit(state, commit)
  if not valid(state) or state.page ~= "main" then
    return
  end
  state.selected = commit
  update_right_layout(state)
  set_title(state.detail_window, 4, "Commit details")
  state.detail_request = (state.detail_request or 0) + 1
  local request = state.detail_request
  state.detail_files = {}
  state.detail_lines = {}
  local tags = vim.tbl_filter(function(reference)
    return reference.kind == "Tags" and reference.id == commit.id
  end, state.refs or {})
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
  render_detail_info(state, loading)
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
    }
    if #tags > 0 then
      output[#output + 1] = " Tags"
      for _, tag in ipairs(tags) do
        output[#output + 1] = "   " .. icons.tag .. " " .. tag.name
      end
    end
    output[#output + 1] = ""
    output[#output + 1] = " Message"
    for _, line in ipairs(vim.split(vim.trim(message), "\n", { plain = true })) do
      output[#output + 1] = " " .. line
    end
    render_detail_info(state, output)
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
  local first = references[1]
  local icon = first.kind == "Tags" and icons.tag or icons.branch
  local label = icon .. " " .. first.name
  if #references > 1 then
    label = label .. " +" .. (#references - 1)
  end
  return label
end

local function working_tree_entry(state)
  if #state.status == 0 or (state.reference and state.reference ~= "refs/heads/" .. state.head) then
    return nil
  end
  return {
    id = working_tree_id,
    parents = state.head_oid and { state.head_oid } or {},
    working_tree = true,
  }
end

local function update_selection_highlight(state)
  if
    not valid(state)
    or state.page ~= "main"
    or not vim.api.nvim_buf_is_valid(state.center_buffer)
  then
    return
  end
  vim.api.nvim_buf_clear_namespace(state.center_buffer, selection_namespace, 0, -1)
  if state.mode ~= "commits" then
    return
  end
  local line = vim.api.nvim_win_get_cursor(state.center_window)[1]
  local commit_line = line % 2 == 0 and line - 1 or line
  local bridge = state.bridge_ranges and state.bridge_ranges[commit_line]
  if bridge then
    vim.api.nvim_buf_set_extmark(
      state.center_buffer,
      selection_namespace,
      commit_line - 1,
      bridge.start,
      {
        end_col = bridge.finish,
        hl_group = graph.selected_highlight_group(bridge.color),
        priority = 200,
      }
    )
  else
    vim.api.nvim_buf_set_extmark(state.center_buffer, selection_namespace, line - 1, 0, {
      line_hl_group = "CursorLine",
      priority = 200,
    })
  end
end

local function render_history(state)
  if not valid(state) or state.page ~= "main" or not state.center_buffer then
    return
  end
  local width = vim.api.nvim_win_get_width(state.center_window)
  local result = {}
  local graph_spans = {}
  local bridge_ranges = {}
  local accent_spans = {}
  local label_spans = {}
  local label_connection_spans = {}
  state.history_lines = {}
  state.load_more_line = nil
  local references = decorate(state)

  if state.mode == "reflog" then
    for index, entry in ipairs(state.reflog or {}) do
      result[index] =
        string.format(" %s  %s  %s", padded(entry.selector, 12), entry.id:sub(1, 7), entry.subject)
      state.history_lines[index] = entry
    end
    if #result == 0 then
      result[1] = " No reflog entries"
    end
  else
    local commits = {}
    local pending = working_tree_entry(state)
    if pending then
      commits[1] = pending
    end
    vim.list_extend(commits, state.commits or {})
    state.layout = graph.layout(commits)
    local label_width = width >= 80 and math.min(22, math.floor(width * 0.22)) or 0
    local graph_width = math.max(
      6,
      math.min(34, state.layout.lanes * 3 + 2, math.floor((width - label_width) * 0.45))
    )
    local separator = "   ▏ "

    local function append(graph_text, spans, commit, color, label, is_commit_row)
      local line = #result + 1
      local prefix = string.rep(" ", label_width)
      if label and label_width > 0 then
        local text = short(label, label_width - 4)
        local label_prefix = " " .. text .. " "
        prefix = label_prefix
          .. string.rep("─", label_width - vim.fn.strdisplaywidth(label_prefix))
        label_connection_spans[line] = {
          start = #label_prefix,
          finish = #prefix,
          color = color,
        }
        label_spans[line] = { start = 1, finish = 1 + #text, color = color }
      end
      if is_commit_row then
        if commit.working_tree then
          result[line] = prefix .. graph_text
        else
          result[line] = prefix .. graph_text .. separator .. commit.subject
          local node_start = graph_text:find("●", 1, true)
          local stripe_start = #prefix + #graph_text + #"   "
          if node_start then
            bridge_ranges[line] = {
              start = #prefix + node_start - 1,
              finish = stripe_start + #"▏",
              color = color,
            }
          end
          accent_spans[line] =
            { start = stripe_start, finish = stripe_start + #"▏", color = color }
        end
      else
        result[line] = prefix .. graph_text
      end
      graph_spans[line] = { offset = #prefix, spans = spans }
      state.history_lines[line] = commit
    end

    for _, row in ipairs(state.layout.rows) do
      local commit = row.commit
      local label = not commit.working_tree and ref_summary(references[commit.id]) or nil
      local connect_ref = label and label_width > 0
      local commit_text, commit_spans = graph.commit_line(row, graph_width, connect_ref)
      append(commit_text, commit_spans, commit, row.color, label, true)
      local connector_text, connector_spans = graph.connector_line(row, graph_width)
      append(connector_text, connector_spans, commit, row.color, nil, false)
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
  vim.wo[state.center_window].cursorline = state.mode == "reflog"
  state.bridge_ranges = bridge_ranges
  if state.selected and state.mode == "commits" then
    for line, entry in ipairs(state.history_lines) do
      if entry.id == state.selected.id then
        vim.api.nvim_win_set_cursor(state.center_window, { line, 0 })
        break
      end
    end
  end
  vim.api.nvim_buf_clear_namespace(state.center_buffer, graph_namespace, 0, -1)
  for line, bridge in pairs(bridge_ranges) do
    vim.api.nvim_buf_set_extmark(state.center_buffer, graph_namespace, line - 1, bridge.start, {
      hl_group = graph.row_highlight_group(bridge.color),
      end_col = bridge.finish,
      priority = 10,
    })
  end
  for line, accent in pairs(accent_spans) do
    vim.api.nvim_buf_add_highlight(
      state.center_buffer,
      graph_namespace,
      graph.highlight_group(accent.color),
      line - 1,
      accent.start,
      accent.finish
    )
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
  for line, connection in pairs(label_connection_spans) do
    vim.api.nvim_buf_add_highlight(
      state.center_buffer,
      graph_namespace,
      graph.highlight_group(connection.color),
      line - 1,
      connection.start,
      connection.finish
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
  local history_tab = state.mode == "reflog" and 2 or 1
  local footer = state.reference and " " .. state.reference:gsub("^refs/", "") .. " "
    or state.mode == "reflog" and " [: prev · ]: next · Enter: select "
    or " [: prev · ]: next · +: more "
  set_tabs_title(state.center_window, 3, history_tabs, history_tab, footer)
  update_selection_highlight(state)
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
  local current_branch_line
  state.sidebar_lines = {}
  local selected_tab = ref_tabs[state.ref_tab]
  local items = vim.tbl_filter(function(item)
    return item.kind == selected_tab.kind
  end, state.refs or {})
  local title = sidebar_width >= 24 and selected_tab.kind or selected_tab.label
  output[#output + 1] = string.format(" %s (%d)", title, #items)
  headings[#headings + 1] = #output
  for _, item in ipairs(items) do
    local current_branch = item.kind == "Local branches" and item.name == state.head
    local icon = item.kind == "Tags" and icons.tag or icons.branch
    local prefix = icon_prefix(icon, current_branch)
    local name_width = sidebar_width - vim.fn.strdisplaywidth(prefix) - 1
    output[#output + 1] = prefix .. short(item.name, name_width)
    state.sidebar_lines[#output] = item
    if current_branch then
      current_branch_line = #output
    end
  end
  if #items == 0 then
    output[#output + 1] = "   —"
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
  if current_branch_line then
    vim.api.nvim_buf_add_highlight(
      state.sidebar_buffer,
      graph_namespace,
      "GitLuaCurrentBranch",
      current_branch_line - 1,
      1,
      #output[current_branch_line]
    )
  end
  set_tabs_title(state.sidebar_window, 1, ref_tabs, state.ref_tab, " [: prev · ]: next · a: all ")
end

local function render_extras(state)
  if not valid(state) or state.page ~= "main" or not state.extras_buffer then
    return
  end
  local width = vim.api.nvim_win_get_width(state.extras_window)
  local selected_tab = extras_tabs[state.extra_tab]
  local items = state[selected_tab.items] or {}
  local output = { string.format(" %s (%d)", selected_tab.label, #items) }
  for _, item in ipairs(items) do
    if selected_tab.items == "worktrees" then
      local folder = short(vim.fs.basename(item.path), width - 4)
      output[#output + 1] = " " .. icons.folder .. " " .. folder
      local prefix = " └ " .. icons.branch .. " "
      local name_width = width - vim.fn.strdisplaywidth(prefix) - 1
      output[#output + 1] = prefix .. short(item.branch or "detached", name_width)
    else
      local name = item.path .. " " .. (item.id or ""):sub(1, 7)
      local marker = item.state == " " and "○" or (item.state or "!")
      output[#output + 1] = " " .. marker .. " " .. short(name, width - 4)
    end
  end
  if #items == 0 then
    output[#output + 1] = "   —"
  end
  lines(state.extras_buffer, output)
  vim.api.nvim_buf_clear_namespace(state.extras_buffer, graph_namespace, 0, -1)
  vim.api.nvim_buf_add_highlight(state.extras_buffer, graph_namespace, "Title", 0, 1, #output[1])
  set_tabs_title(state.extras_window, 2, extras_tabs, state.extra_tab, " [: prev · ]: next ")
end

local function select_history(state)
  local line = vim.api.nvim_win_get_cursor(state.center_window)[1]
  local entry = state.history_lines[line]
  if not entry then
    return
  end
  if state.mode == "commits" then
    if entry.working_tree then
      show_status(state)
    else
      show_commit(state, entry)
    end
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

local function preview_history(state)
  local line = vim.api.nvim_win_get_cursor(state.center_window)[1]
  local entry = state.history_lines[line]
  if not entry then
    return
  end
  if entry.working_tree then
    if state.selected then
      show_status(state)
    end
  elseif not state.selected or state.selected.id ~= entry.id then
    select_history(state)
  end
end

local function move_history(state, offset)
  if not valid(state) or state.page ~= "main" then
    return
  end
  local current_line = vim.api.nvim_win_get_cursor(state.center_window)[1]
  local target_line
  if state.mode == "commits" then
    local commit_count = state.layout and #state.layout.rows or 0
    if commit_count == 0 then
      return
    end
    local selectable_count = commit_count + (state.load_more_line and 1 or 0)
    local current_index = math.floor((current_line + 1) / 2)
    local target_index = math.max(1, math.min(selectable_count, current_index + offset))
    target_line = target_index <= commit_count and target_index * 2 - 1 or state.load_more_line
  else
    local entry_count = #(state.reflog or {})
    if entry_count == 0 then
      return
    end
    target_line = math.max(1, math.min(entry_count, current_line + offset))
  end
  vim.api.nvim_win_set_cursor(state.center_window, { target_line, 0 })
  update_selection_highlight(state)
  preview_history(state)
end

local function set_mode(state, mode)
  if state.mode == mode then
    return
  end
  state.mode = mode
  show_status(state)
  render_history(state)
  vim.api.nvim_win_set_cursor(state.center_window, { 1, 0 })
  update_selection_highlight(state)
end

local function main_maps(state)
  for _, target in ipairs({
    state.sidebar_buffer,
    state.extras_buffer,
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
  for _, tab_key in ipairs({ { key = "[", offset = -1 }, { key = "]", offset = 1 } }) do
    map(state.sidebar_buffer, tab_key.key, function()
      state.ref_tab = (state.ref_tab - 1 + tab_key.offset) % #ref_tabs + 1
      render_sidebar(state)
      vim.api.nvim_win_set_cursor(state.sidebar_window, {
        math.min(5, vim.api.nvim_buf_line_count(state.sidebar_buffer)),
        0,
      })
    end, "Switch refs tab")
    map(state.extras_buffer, tab_key.key, function()
      state.extra_tab = (state.extra_tab - 1 + tab_key.offset) % #extras_tabs + 1
      render_extras(state)
      vim.api.nvim_win_set_cursor(state.extras_window, { 1, 0 })
    end, "Switch worktree/submodule tab")
    map(state.center_buffer, tab_key.key, function()
      local active_tab = state.mode == history_tabs[1].mode and 1 or 2
      local next_tab = (active_tab - 1 + tab_key.offset) % #history_tabs + 1
      set_mode(state, history_tabs[next_tab].mode)
    end, "Switch history tab")
  end
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
  for _, movement in ipairs({
    { key = "j", offset = 1 },
    { key = "<Down>", offset = 1 },
    { key = "k", offset = -1 },
    { key = "<Up>", offset = -1 },
  }) do
    map(state.center_buffer, movement.key, function()
      move_history(state, movement.offset * vim.v.count1)
    end, "Move between Git entries")
  end
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
  state.extras_buffer = buffer()
  state.detail_buffer = buffer()
  state.detail_files_buffer = buffer()
  state.sidebar_window, state.center_window, state.detail_window, state.detail_files_window, state.extras_window =
    open_windows(state, {
      state.sidebar_buffer,
      state.center_buffer,
      state.detail_buffer,
      state.detail_files_buffer,
      state.extras_buffer,
    })
  for _, window in ipairs({ state.detail_window, state.detail_files_window }) do
    vim.wo[window].wrap = true
    vim.wo[window].linebreak = true
    vim.wo[window].breakindent = true
  end
  vim.wo[state.detail_window].cursorline = false
  main_maps(state)
  vim.api.nvim_create_autocmd("CursorMoved", {
    group = state.augroup,
    buffer = state.center_buffer,
    callback = function()
      update_selection_highlight(state)
      state.cursor_request = (state.cursor_request or 0) + 1
      local request = state.cursor_request
      vim.defer_fn(function()
        if valid(state) and state.page == "main" and state.cursor_request == request then
          preview_history(state)
        end
      end, 120)
    end,
  })
  render_sidebar(state)
  render_extras(state)
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
    set_title(state.old_window, 2, "Before · " .. old_path)
    set_title(state.new_window, 3, "After · " .. new_path)
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
  set_title(state.files_window, 1, string.format("Files (%d)", #state.detail_files))
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
      if state.selected then
        show_commit(state, state.selected)
      end
    end)
  )
  data.status(
    state.root,
    update(function(files)
      state.status = files
      render_history(state)
      render_sidebar(state)
      if not state.selected then
        show_status(state)
      end
    end)
  )
  data.worktrees(
    state.root,
    update(function(worktrees)
      state.worktrees = worktrees
      render_extras(state)
    end)
  )
  data.submodules(
    state.root,
    update(function(submodules)
      state.submodules = submodules
      render_extras(state)
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
      render_history(state)
      render_sidebar(state)
      if not state.selected then
        show_status(state)
      end
    end)
  )
  data.run(state.root, { "rev-parse", "--verify", "HEAD" }, function(error_message, output)
    if not valid(state) or state.refresh_request ~= request then
      return
    end
    if error_message then
      state.head_oid = nil
    else
      state.head_oid = vim.trim(output)
    end
    render_history(state)
    render_sidebar(state)
  end)
end

function M.close(state)
  if current ~= state then
    return
  end
  restore_cursor(state)
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
    ref_tab = 1,
    extra_tab = 1,
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
      local configs = pane_configs(state.page, state.selected ~= nil)
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
        render_extras(state)
        render_history(state)
        if state.selected and state.detail_content then
          render_detail_info(state, state.detail_content)
        end
        if state.selected then
          set_title(state.detail_window, 4, "Commit details")
        end
        set_title(
          state.detail_files_window,
          state.selected and 5 or 4,
          string.format("Changed files (%d)", #state.detail_files)
        )
      else
        set_title(state.files_window, 1, string.format("Files (%d)", #state.detail_files))
        local file = state.detail_files[state.diff_index]
        if file then
          set_title(state.old_window, 2, "Before · " .. (file.original_path or file.path))
          set_title(state.new_window, 3, "After · " .. file.path)
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
        restore_cursor(state)
        if current == state then
          current = nil
        end
        vim.api.nvim_del_augroup_by_id(state.augroup)
      end
    end,
  })
end

return M
