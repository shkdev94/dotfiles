vim.api.nvim_create_user_command("Git", function()
  require("git.view").open()
end, { desc = "Open git.lua history viewer" })

vim.keymap.set("n", "<leader>gg", "<cmd>Git<cr>", { desc = "Open git.lua" })
