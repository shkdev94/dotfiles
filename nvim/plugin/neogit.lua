vim.api.nvim_create_user_command("Neogit", function(opts)
  vim.api.nvim_del_user_command("Neogit")
  vim.pack.add({
    "https://github.com/NeogitOrg/neogit",
    "https://github.com/sindrets/diffview.nvim",
  })
  require("neogit").setup({ integrations = { diffview = true, snacks = true } })
  require("neogit").open(#opts.fargs > 0 and { opts.fargs[1] } or {})
end, { nargs = "?" })

vim.keymap.set("n", "<leader>gg", "<cmd>Neogit<cr>")
