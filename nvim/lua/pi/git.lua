local M = {}

function M.parse(output)
  local status = { branch = "Git 없음", files = {}, staged = {}, unstaged = {} }
  local lines = vim.split(output, "\n", { trimempty = true })
  local first = 1
  local header = lines[1] and lines[1]:match("^## (.+)")
  if header then
    status.branch = header:match("^No commits yet on (.+)$")
      or header:match("^Initial commit on (.+)$")
      or header:match("^(.-)%.%.%.")
      or header
    first = 2
  end

  for index = first, #lines do
    local line = lines[index]
    if #line >= 4 and line:sub(3, 3) == " " then
      local staged = line:sub(1, 1)
      local unstaged = line:sub(2, 2)
      local path = line:sub(4)
      status.files[#status.files + 1] = path
      if staged ~= " " and staged ~= "?" then
        status.staged[#status.staged + 1] = { code = staged, path = path }
      end
      if unstaged ~= " " or staged == "?" then
        status.unstaged[#status.unstaged + 1] =
          { code = staged == "?" and "?" or unstaged, path = path }
      end
    end
  end

  return status
end

return M
