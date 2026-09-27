vim.pack.add({ { src = "https://github.com/nickjvandyke/opencode.nvim", version = "main" } })

local terminals = {}

local function get_terminal()
  local directory = vim.fn.getcwd()
  if not terminals[directory] then
    terminals[directory] = require("toggleterm.terminal").Terminal:new({
      cmd = "opencode --auto",
      dir = directory,
      hidden = true,
      display_name = "OpenCode",
    })
  end
  return terminals[directory]
end

vim.g.opencode_opts = {
  server = {
    start = function()
      get_terminal():open()
    end,
  },
}

vim.keymap.set({ "n", "x" }, "<leader>oa", function()
  require("opencode").ask("@this: ")
end, { desc = "Ask OpenCode" })

vim.keymap.set({ "n", "x" }, "<leader>os", function()
  require("opencode").select()
end, { desc = "OpenCode prompts and commands" })

vim.keymap.set("n", "<leader>ot", function()
  get_terminal():toggle()
end, { desc = "Toggle OpenCode" })

vim.keymap.set({ "n", "x" }, "go", function()
  return require("opencode").operator("@this")
end, { expr = true, desc = "Send range to OpenCode" })

vim.keymap.set("n", "goo", function()
  return require("opencode").operator("@this") .. "_"
end, { expr = true, desc = "Send line to OpenCode" })
