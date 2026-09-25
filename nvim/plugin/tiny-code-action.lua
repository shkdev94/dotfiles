vim.api.nvim_create_autocmd("LspAttach", {
  once = true,
  callback = function()
    vim.pack.add({ "https://github.com/rachartier/tiny-code-action.nvim" })
    vim.keymap.set("n", "<leader>a", function()
      require("tiny-code-action").code_action({ picker = { "select" } })
    end, { noremap = true, silent = true })
  end,
})
