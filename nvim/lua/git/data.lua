local M = {}

function M.root()
  local result = vim.system({ "git", "rev-parse", "--show-toplevel" }, { text = true }):wait()
  if result.code ~= 0 then
    return nil, vim.trim(result.stderr or "Not a Git repository")
  end
  return vim.trim(result.stdout)
end

function M.run(root, arguments, callback, binary)
  local command = { "git" }
  vim.list_extend(command, arguments)
  vim.system(command, { cwd = root, text = not binary }, function(result)
    vim.schedule(function()
      local error_message
      if result.code ~= 0 then
        error_message = vim.trim(result.stderr or "Git command failed")
        if error_message == "" then
          error_message = "Git exited with code " .. result.code
        end
      end
      callback(error_message, result.stdout or "")
    end)
  end)
end

local function fields(line)
  return vim.split(line, "\31", { plain = true })
end

function M.commits(root, reference, limit, callback)
  local arguments = {
    "log",
    "--topo-order",
    "--no-show-signature",
    "-n",
    tostring(limit),
    "--format=%H%x1f%P%x1f%s%x1f%an%x1f%aI",
  }
  if reference then
    arguments[#arguments + 1] = reference
  else
    arguments[#arguments + 1] = "--all"
  end
  M.run(root, arguments, function(error_message, output)
    if error_message then
      if reference then
        callback(error_message)
        return
      end
      M.run(root, { "rev-list", "--all", "--count" }, function(count_error, count_output)
        if not count_error and tonumber(vim.trim(count_output)) == 0 then
          callback(nil, {})
        else
          callback(error_message)
        end
      end)
      return
    end
    local commits = {}
    for _, line in ipairs(vim.split(vim.trim(output), "\n", { plain = true })) do
      local values = fields(line)
      if #values >= 5 then
        commits[#commits + 1] = {
          id = values[1],
          parents = values[2] == "" and {} or vim.split(values[2], " ", { plain = true }),
          subject = values[3],
          author = values[4],
          date = values[5],
        }
      end
    end
    callback(nil, commits)
  end)
end

function M.refs(root, callback)
  M.run(root, {
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(*objectname)",
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  }, function(error_message, output)
    if error_message then
      callback(error_message)
      return
    end
    local refs = {}
    for _, line in ipairs(vim.split(vim.trim(output), "\n", { plain = true })) do
      local parts = vim.split(line, "\0", { plain = true })
      if #parts >= 2 then
        local kind, name
        if parts[1]:find("^refs/heads/") then
          kind, name = "Local branches", parts[1]:sub(12)
        elseif parts[1]:find("^refs/remotes/") then
          kind, name = "Remote branches", parts[1]:sub(14)
        elseif parts[1]:find("^refs/tags/") then
          kind, name = "Tags", parts[1]:sub(11)
        end
        if kind and not (kind == "Remote branches" and name:match("/HEAD$")) then
          refs[#refs + 1] = {
            kind = kind,
            name = name,
            ref = parts[1],
            id = parts[3] ~= "" and parts[3] or parts[2],
          }
        end
      end
    end
    callback(nil, refs)
  end)
end

function M.status(root, callback)
  M.run(
    root,
    { "status", "--porcelain=v1", "-z", "--untracked-files=all" },
    function(error_message, output)
      if error_message then
        callback(error_message)
        return
      end
      local files = {}
      local records = vim.split(output, "\0", { plain = true })
      local index = 1
      while index <= #records do
        local record = records[index]
        if record and #record >= 4 then
          local staged_status, unstaged_status = record:sub(1, 1), record:sub(2, 2)
          local path = record:sub(4)
          local original_path
          if staged_status:match("[RC]") or unstaged_status:match("[RC]") then
            index = index + 1
            original_path = records[index]
          end
          if staged_status == "?" then
            files[#files + 1] = { kind = "untracked", status = "?", path = path }
          else
            if staged_status ~= " " then
              files[#files + 1] = {
                kind = "staged",
                status = staged_status,
                path = path,
                original_path = original_path,
              }
            end
            if unstaged_status ~= " " then
              files[#files + 1] = {
                kind = "unstaged",
                status = unstaged_status,
                path = path,
                original_path = original_path,
              }
            end
          end
        end
        index = index + 1
      end
      callback(nil, files)
    end,
    true
  )
end

function M.worktrees(root, callback)
  M.run(root, { "worktree", "list", "--porcelain" }, function(error_message, output)
    if error_message then
      callback(error_message)
      return
    end
    local worktrees = {}
    local current
    for _, line in ipairs(vim.split(output, "\n", { plain = true })) do
      if line:find("^worktree ") then
        current = { path = line:sub(10) }
        worktrees[#worktrees + 1] = current
      elseif current and line:find("^branch ") then
        current.branch = line:sub(8):gsub("^refs/heads/", "")
      elseif current and line == "detached" then
        current.branch = "detached"
      end
    end
    callback(nil, worktrees)
  end)
end

function M.submodules(root, callback)
  M.run(root, { "submodule", "status" }, function(error_message, output)
    if error_message then
      callback(error_message)
      return
    end
    local submodules = {}
    for _, line in ipairs(vim.split(vim.trim(output), "\n", { plain = true })) do
      local state, id, path = line:match("^([ %+%-U])([%da-f]+)%s+([^%s]+)")
      if path then
        submodules[#submodules + 1] = { path = path, state = state, id = id }
      end
    end
    callback(nil, submodules)
  end)
end

function M.reflog(root, callback)
  M.run(
    root,
    { "reflog", "show", "-n", "100", "--format=%H%x1f%gd%x1f%gs%x1f%ci" },
    function(error_message, output)
      if error_message then
        M.run(root, { "rev-parse", "--verify", "HEAD" }, function(head_error)
          if head_error then
            callback(nil, {})
          else
            callback(error_message)
          end
        end)
        return
      end
      local entries = {}
      for _, line in ipairs(vim.split(vim.trim(output), "\n", { plain = true })) do
        local values = fields(line)
        if #values >= 4 then
          entries[#entries + 1] = {
            id = values[1],
            selector = values[2],
            subject = values[3],
            date = values[4],
          }
        end
      end
      callback(nil, entries)
    end
  )
end

function M.commit_files(root, commit, callback)
  local arguments
  if commit.parents[1] then
    arguments = { "diff", "--name-status", "-z", commit.parents[1], commit.id, "--" }
  else
    arguments = { "diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", commit.id }
  end
  M.run(root, arguments, function(error_message, output)
    if error_message then
      callback(error_message)
      return
    end
    local files = {}
    local records = vim.split(output, "\0", { plain = true })
    local index = 1
    while index < #records do
      local status = records[index]
      local path = records[index + 1]
      if status == "" or not path then
        break
      end
      local original_path
      if status:match("^[RC]") then
        original_path = path
        path = records[index + 2]
        index = index + 1
      end
      files[#files + 1] = {
        kind = "commit",
        status = status:sub(1, 1),
        path = path,
        original_path = original_path,
        commit = commit,
      }
      index = index + 2
    end
    callback(nil, files)
  end, true)
end

function M.commit_message(root, commit, callback)
  M.run(root, { "show", "-s", "--format=%B", commit.id }, callback)
end

function M.content(root, revision, path, callback)
  if revision == "empty" then
    callback(nil, "")
  elseif revision == "worktree" then
    local file_path = root .. "/" .. path
    local stat = vim.uv.fs_lstat(file_path)
    if not stat then
      callback("Unable to read " .. path, "")
      return
    end
    if stat.type == "link" then
      callback(nil, vim.uv.fs_readlink(file_path) or "")
      return
    end
    if stat.type ~= "file" then
      callback(nil, "Non-file change (content preview unavailable)")
      return
    end
    local file = io.open(file_path, "rb")
    if not file then
      callback("Unable to read " .. path, "")
      return
    end
    local content = file:read("*a")
    file:close()
    callback(nil, content)
  else
    M.run(root, { "show", revision .. ":" .. path }, callback, true)
  end
end

return M
