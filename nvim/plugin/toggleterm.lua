vim.pack.add({ "https://github.com/akinsho/toggleterm.nvim" })

require("toggleterm").setup({
  open_mapping = [[<c-\>]],
  direction = "float",
  hide_number = false,
})

function _G.set_terminal_keymaps()
  local opts = { noremap = true }
  vim.api.nvim_buf_set_keymap(0, "t", "<C-]>", [[<C-\><C-n>]], opts)
  vim.api.nvim_buf_set_keymap(0, "n", "<C-]>", ":q<CR>", opts)
end

vim.cmd("autocmd! TermOpen term://* lua set_terminal_keymaps()")

vim.keymap.set("n", "<leader>1", ":1ToggleTerm<CR>", { noremap = true, silent = true })
vim.keymap.set("n", "<leader>2", ":2ToggleTerm<CR>", { noremap = true, silent = true })
vim.keymap.set("n", "<leader>3", ":3ToggleTerm<CR>", { noremap = true, silent = true })
vim.keymap.set("n", "<leader>4", ":4ToggleTerm<CR>", { noremap = true, silent = true })
vim.keymap.set("n", "<leader>5", ":5ToggleTerm<CR>", { noremap = true, silent = true })
