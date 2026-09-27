vim.pack.add({ { src = "https://github.com/nickjvandyke/opencode.nvim", version = "main" } })

local command = "opencode --auto"
local terminal_opts = {
  win = {
    position = "right",
    width = 0.4,
    enter = true,
  },
}

vim.g.opencode_opts = {
  server = {
    start = function()
      require("snacks.terminal").open(command, terminal_opts)
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
  require("snacks.terminal").toggle(command, terminal_opts)
end, { desc = "Toggle OpenCode" })

vim.keymap.set({ "n", "x" }, "go", function()
  return require("opencode").operator("@this")
end, { expr = true, desc = "Send range to OpenCode" })

vim.keymap.set("n", "goo", function()
  return require("opencode").operator("@this") .. "_"
end, { expr = true, desc = "Send line to OpenCode" })
