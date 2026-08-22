vim.api.nvim_create_autocmd("FileType", {
  pattern = { "http", "rest" },
  once = true,
  callback = function()
    vim.pack.add({ "https://github.com/mistweaverco/kulala.nvim" })
    require("kulala").setup({
      global_keymaps = false,
      global_keymaps_prefix = "<leader>R",
      kulala_keymaps_prefix = "",
    })
  end,
})
