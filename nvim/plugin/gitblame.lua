vim.schedule(function()
  vim.pack.add({ "https://github.com/f-person/git-blame.nvim" })
  require("gitblame").setup({ enabled = false })
  vim.g.gitblame_message_template = "<committer>, <sha> (<committer-date>)"
  vim.g.gitblame_date_format = "%r"
end)
