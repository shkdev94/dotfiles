vim.api.nvim_create_user_command("Neogit", function(opts)
  vim.api.nvim_del_user_command("Neogit")
  vim.pack.add({
    "https://github.com/NeogitOrg/neogit",
    "https://github.com/sindrets/diffview.nvim",
  })
  -- diffview has no default `q` in the diff view / file panel; make it close everywhere
  local close = { "n", "q", "<Cmd>DiffviewClose<CR>", { desc = "Close diffview" } }
  require("diffview").setup({
    keymaps = { view = { close }, file_panel = { close }, file_history_panel = { close } },
  })
  require("neogit").setup({ integrations = { diffview = true, snacks = true } })
  require("neogit").open(#opts.fargs > 0 and { opts.fargs[1] } or {})
end, { nargs = "?" })

vim.keymap.set("n", "<leader>gg", "<cmd>Neogit<cr>")
