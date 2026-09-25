vim.pack.add({ "https://github.com/akinsho/toggleterm.nvim" })

require("toggleterm").setup({
  open_mapping = [[<c-\>]],
  direction = "vertical",
  size = function(term)
    if term.direction == "vertical" then
      return math.floor(vim.o.columns * 0.4)
    end
  end,
  hide_number = false,
})

-- Open the path under the cursor (file or file:line, as printed by tools like
-- Claude Code) in the editor window next to the terminal, not in the terminal
-- window itself.
function _G.open_file_under_cursor()
  local word = vim.fn.expand("<cWORD>")
  local path, line = word:match("^(.-):(%d+)")
  path = path or word
  path = path:gsub("^[%(%[<\"']+", ""):gsub("[%)%]>\"',.:]+$", "")
  path = vim.fn.expand(path)
  if vim.fn.filereadable(path) == 0 then
    vim.notify("no file: " .. path, vim.log.levels.WARN)
    return
  end
  local term_win = vim.api.nvim_get_current_win()
  vim.cmd.wincmd("p")
  if vim.api.nvim_get_current_win() == term_win then
    vim.cmd("topleft vsplit") -- terminal was the only window
  end
  vim.cmd.edit(vim.fn.fnameescape(path))
  if line then
    vim.api.nvim_win_set_cursor(0, { tonumber(line), 0 })
  end
end

function _G.set_terminal_keymaps()
  local opts = { noremap = true }
  vim.api.nvim_buf_set_keymap(0, "t", "<C-]>", [[<C-\><C-n>]], opts)
  vim.api.nvim_buf_set_keymap(0, "n", "<C-]>", ":q<CR>", opts)
  vim.keymap.set("n", "gf", open_file_under_cursor, { buffer = 0 })
  vim.keymap.set("n", "gF", open_file_under_cursor, { buffer = 0 })
end

vim.cmd("autocmd! TermOpen term://* lua set_terminal_keymaps()")

vim.keymap.set("n", "<leader>1", ":1ToggleTerm<CR>", { noremap = true, silent = true })
vim.keymap.set("n", "<leader>2", ":2ToggleTerm<CR>", { noremap = true, silent = true })
vim.keymap.set("n", "<leader>3", ":3ToggleTerm<CR>", { noremap = true, silent = true })
vim.keymap.set("n", "<leader>4", ":4ToggleTerm<CR>", { noremap = true, silent = true })
vim.keymap.set("n", "<leader>5", ":5ToggleTerm<CR>", { noremap = true, silent = true })
