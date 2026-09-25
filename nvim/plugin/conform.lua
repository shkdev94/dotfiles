vim.pack.add({ "https://github.com/stevearc/conform.nvim" })

require("conform").setup({
  formatters_by_ft = {
    lua = { "stylua" },
    nix = { "nixfmt" },
    javascript = { "prettier", "biome", stop_after_first = true },
    javascriptreact = { "prettier", "biome", stop_after_first = true },
    typescript = { "prettier", "biome", stop_after_first = true },
    typescriptreact = { "prettier", "biome", stop_after_first = true },
    html = { "prettier" },
    css = { "prettier", "biome", stop_after_first = true },
    json = { "prettier", "biome", stop_after_first = true },
    markdown = { "prettier" },
  },
  formatters = {
    stylua = {
      prepend_args = { "--indent-type", "Spaces" },
    },
  },
})

vim.keymap.set("n", "<leader>f", function()
  require("conform").format({ async = true, lsp_fallback = true })
end, { desc = "Format buffer" })
