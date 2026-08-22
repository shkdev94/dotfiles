vim.pack.add({ "https://github.com/rachartier/tiny-inline-diagnostic.nvim" })

require("tiny-inline-diagnostic").setup({
  preset = "minimal",
  transparent_bg = true,
  transparent_cursorline = true,
  options = {
    show_source = {
      enabled = true,
      if_many = false,
    },
  },
})
