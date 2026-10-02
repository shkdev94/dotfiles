local data = require("git.data")
local graph = require("git.graph")
local image = require("git.image")

local M = {}
local current
local window_options

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
  if columns < 54 or rows < 12 then
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
    for index, window in ipairs(state.windows) do
      if window == active then
        vim.api.nvim_set_current_win(state.windows[index % #state.windows + 1])
        return
      end
    end
  end, "Next Git pane")
  map(target, "<S-Tab>", function()
    local active = vim.api.nvim_get_current_win()
    for index, window in ipairs(state.windows) do
      if window == active then
        vim.api.nvim_set_current_win(state.windows[(index - 2) % #state.windows + 1])
        return
      end
    end
  end, "Previous Git pane")
  map(target, "r", function()
    M.refresh(state)
  end, "Refresh Git view")
end

local function close_image(state)
  if state.graph_image then
    state.graph_image:close()
    state.graph_image = nil
  end
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
  local output = {
    " Working tree · " .. (state.head ~= "" and state.head or "detached HEAD"),
    " " .. state.root,
    "",
    " Changed files (Enter to compare)",
  }
  state.detail_lines[4] = "files"
  for _, kind in ipairs({ "staged", "unstaged", "untracked" }) do
    local count = 0
    for _, file in ipairs(state.detail_files) do
      if file.kind == kind then
        count = count + 1
      end
    end
    if count > 0 then
      output[#output + 1] = ""
      output[#output + 1] = " " .. kind:upper() .. " (" .. count .. ")"
      for index, file in ipairs(state.detail_files) do
        if file.kind == kind then
          output[#output + 1] = string.format("  %s  %s", file.status, file.path)
          state.detail_lines[#output] = index
        end
      end
    end
  end
  if #state.detail_files == 0 then
    output[#output + 1] = "  Clean working tree"
  end
  lines(state.detail_buffer, output)
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
  lines(state.detail_buffer, {
    " Commit " .. commit.id:sub(1, 12),
    " " .. (commit.author or ""),
    " " .. (commit.date or ""),
    "",
    " Loading details…",
  })

  local message, files
  local function render()
    if not valid(state) or state.page ~= "main" or state.detail_request ~= request then
      return
    end
    if message == nil or files == nil then
      return
    end
    local output = {
      " Commit " .. commit.id,
      " Author: " .. (commit.author or ""),
      " Date: " .. (commit.date or ""),
      "",
    }
    for _, line in ipairs(vim.split(vim.trim(message), "\n", { plain = true })) do
      output[#output + 1] = " " .. line
    end
    output[#output + 1] = ""
    output[#output + 1] = " Changed files (Enter to compare)"
    state.detail_lines = { [#output] = "files" }
    state.detail_files = files
    for index, file in ipairs(files) do
      output[#output + 1] = string.format("  %s  %s", file.status, file.path)
      state.detail_lines[#output] = index
    end
    if #files == 0 then
      output[#output + 1] = "  No file changes"
    end
    lines(state.detail_buffer, output)
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
    references[reference.id] = references[reference.id] or {}
    table.insert(references[reference.id], reference.name)
  end
  return references
end

local function render_history(state)
  if not valid(state) or state.page ~= "main" or not state.center_buffer then
    return
  end
  close_image(state)
  local width = vim.api.nvim_win_get_width(state.center_window)
  local result = {}
  state.history_lines = {}
  local references = decorate(state)
  local can_image = not state.image_failed
    and vim.fn.executable("resvg") == 1
    and Snacks.image.supports_terminal()

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
    local graph_width =
      math.max(6, math.min(22, state.layout.lanes * 3 + 2, math.floor(width * 0.42)))
    state.graph_width = graph_width
    for index, row in ipairs(state.layout.rows) do
      local commit = row.commit
      local names = references[commit.id]
      local suffix = names and ("  [" .. table.concat(names, ", ") .. "]") or ""
      local graph_text = can_image and string.rep(" ", graph_width)
        or graph.text_row(row, graph_width)
      local subject = width >= 72 and suffix ~= "" and (suffix .. " " .. commit.subject)
        or commit.subject
      if width >= 72 then
        local subject_width = math.max(8, width - graph_width - 35)
        result[index] = string.format(
          "%s %s  %s  %s  %s",
          graph_text,
          commit.id:sub(1, 7),
          padded(commit.author, 12),
          commit.date:sub(1, 10),
          short(subject, subject_width)
        )
      else
        result[index] = string.format(
          "%s %s  %s",
          graph_text,
          commit.id:sub(1, 7),
          short(subject, math.max(8, width - graph_width - 12))
        )
      end
      state.history_lines[index] = commit
    end
    if #result == state.max_commits then
      result[#result + 1] = " + Load more commits"
    end
    if #result == 0 then
      result[1] = " No commits"
    end
  end
  lines(state.center_buffer, result)
  vim.wo[state.center_window].winbar = state.mode == "reflog"
      and " Reflog · C: commits · Enter: select"
    or (
      " Commits"
      .. (state.reference and (" · " .. state.reference:gsub("^refs/", "")) or "")
      .. " · R: reflog · +: more · Enter: select"
    )

  if state.mode == "commits" and #state.layout.rows > 0 and can_image then
    state.graph_image = image.new(
      state.center_buffer,
      state.center_window,
      state.layout,
      state.graph_width,
      function(error_message)
        if not valid(state) then
          return
        end
        state.image_failed = true
        close_image(state)
        vim.notify("git.lua graph: " .. error_message, vim.log.levels.WARN)
        render_history(state)
      end
    )
    if state.graph_image then
      state.graph_image:visible()
    end
  end
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
  state.sidebar_lines = {}
  local sections = {
    { title = "Local branches", items = state.refs or {}, kind = "Local branches" },
    { title = "Remote branches", items = state.refs or {}, kind = "Remote branches" },
    { title = "Tags", items = state.refs or {}, kind = "Tags" },
    { title = "Worktrees", items = state.worktrees or {} },
    { title = "Submodules", items = state.submodules or {} },
  }
  for _, section in ipairs(sections) do
    output[#output + 1] = " " .. section.title
    local count = 0
    for _, item in ipairs(section.items) do
      if not section.kind or item.kind == section.kind then
        count = count + 1
        local name = item.name or item.path
        if section.title == "Worktrees" then
          name = (item.branch or "detached") .. " · " .. vim.fs.basename(item.path)
        elseif section.title == "Submodules" then
          name = item.path .. " " .. (item.id or ""):sub(1, 7)
        end
        local marker = item.kind == "Local branches" and item.name == state.head and "●" or " "
        if section.title == "Worktrees" and item.path == state.root then
          marker = "●"
        elseif section.title == "Submodules" then
          marker = item.state == " " and "○" or (item.state or "!")
        end
        output[#output + 1] = " " .. marker .. " " .. short(name or item.path, sidebar_width - 4)
        state.sidebar_lines[#output] = item
      end
    end
    if count == 0 then
      output[#output + 1] = "   —"
    end
    output[#output + 1] = ""
  end
  lines(state.sidebar_buffer, output)
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
  for _, target in ipairs({ state.sidebar_buffer, state.center_buffer, state.detail_buffer }) do
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
    if state.mode == "commits" and line > #(state.commits or {}) then
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
    local line = vim.api.nvim_win_get_cursor(state.detail_window)[1]
    local file_index = state.detail_lines[line]
    if file_index == "files" then
      file_index = 1
    end
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
  state.sidebar_window, state.center_window, state.detail_window = open_windows(state, {
    state.sidebar_buffer,
    state.center_buffer,
    state.detail_buffer,
  })
  vim.wo[state.sidebar_window].winbar = " Refs · Enter: history · a: all"
  vim.wo[state.center_window].winbar = " Commits · R: reflog · C: commits · Enter: select"
  vim.wo[state.detail_window].winbar = " Details · Enter: files"
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
  close_image(state)
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
    end)
  )
  data.refs(
    state.root,
    update(function(refs)
      state.refs = refs
      render_sidebar(state)
      render_history(state)
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
  close_image(state)
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
  vim.api.nvim_create_autocmd("WinScrolled", {
    group = state.augroup,
    callback = function(event)
      if valid(state) and state.graph_image and tonumber(event.match) == state.center_window then
        state.graph_image:visible()
      end
    end,
  })
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
      end
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
        close_image(state)
        if current == state then
          current = nil
        end
        vim.api.nvim_del_augroup_by_id(state.augroup)
      end
    end,
  })
end

return M
