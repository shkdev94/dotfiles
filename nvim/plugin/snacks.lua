vim.pack.add({ "https://github.com/folke/snacks.nvim" })

require("snacks").setup({
  indent = { enabled = true },

  explorer = {
    enabled = true,
  },
  image = {
    enabled = true,
    doc = {
      inline = true,
      float = true,
    },
  },
  picker = {
    layout = {
      preset = "vscode",
    },

    sources = {
      files = {
        matcher = { fuzzy = false },
      },
    },
  },
  dashboard = {
    width = 60,
    row = nil,
    col = nil,
    pane_gap = 4,
    autokeys = "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
    preset = {
      pick = nil,
      header = [[
███╗   ██╗███████╗ ██████╗ ██╗   ██╗██╗███╗   ███╗
████╗  ██║██╔════╝██╔═══██╗██║   ██║██║████╗ ████║
██╔██╗ ██║█████╗  ██║   ██║██║   ██║██║██╔████╔██║
██║╚██╗██║██╔══╝  ██║   ██║╚██╗ ██╔╝██║██║╚██╔╝██║
██║ ╚████║███████╗╚██████╔╝ ╚████╔╝ ██║██║ ╚═╝ ██║
╚═╝  ╚═══╝╚══════╝ ╚═════╝   ╚═══╝  ╚═╝╚═╝     ╚═╝]],
    },
    sections = {
      { section = "header" },
      {
        text = (function()
          local n = #vim.pack.get()
          local dt = (vim.uv.hrtime() - vim.g._startuptime) / 1e6
          local ms = math.floor(dt * 100 + 0.5) / 100
          return "⚡ Loaded " .. n .. " plugins in " .. ms .. "ms"
        end)(),
        align = "center",
      },
    },
  },
})

-- Keymaps
vim.keymap.set("n", "<C-p>", function()
  Snacks.picker.files()
end)
vim.keymap.set("n", "<C-f>", function()
  Snacks.picker.lines()
end)
vim.keymap.set("n", "<C-l>", function()
  Snacks.picker.grep()
end)
vim.keymap.set("n", "<C-b>", function()
  Snacks.picker.buffers()
end)
vim.keymap.set("n", "<C-f-h>", function()
  Snacks.picker.help()
end)

vim.keymap.set({ "n", "x" }, "<C-y>", function()
  Snacks.picker.yanky()
end, { desc = "Open Yank History" })
vim.keymap.set("n", "<C-t>", function()
  Snacks.explorer()
end, { desc = "Toggle explorer" })
