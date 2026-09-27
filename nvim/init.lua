vim.g._startuptime = vim.uv.hrtime()

vim.api.nvim_create_autocmd("UIEnter", {
  once = true,
  callback = function()
    local dt = (vim.uv.hrtime() - vim.g._startuptime) / 1e6
    vim.g._startuptime_ms = math.floor(dt * 100 + 0.5) / 100
  end,
})

-- Starting with a directory should open an empty buffer, not a file explorer.
if vim.fn.argc() == 1 and vim.fn.isdirectory(vim.fn.argv(0)) == 1 then
  vim.g.loaded_netrwPlugin = 1
  vim.g.loaded_nvim_dir_plugin = 1
  vim.api.nvim_create_autocmd("VimEnter", {
    once = true,
    callback = function()
      local directory_buffer = vim.api.nvim_get_current_buf()
      vim.cmd("argdelete *")
      vim.cmd.enew()
      vim.api.nvim_buf_delete(directory_buffer, { force = true })
    end,
  })
end

-- Shared plugin dependencies (init.lua runs before plugin/*.lua)
vim.pack.add({ "https://github.com/nvim-tree/nvim-web-devicons" }) -- file icons: bufferline, lualine, diffview

-- Leaders
vim.g.mapleader = " "
vim.g.localleader = "\\"

-- Options
local options = {
  number = true,
  clipboard = "unnamed",
  shiftwidth = 2,
  expandtab = true,
  tabstop = 2,
  smartcase = true,
  smartindent = true,
  showtabline = 2,
  swapfile = false,
  wrap = false,
  encoding = "utf-8",
  autoread = true,
  termguicolors = true,
  numberwidth = 5,
  cursorline = true,
}

for k, v in pairs(options) do
  vim.opt[k] = v
end

-- Keymaps
-- close buffer but keep the window layout (:bd would also close the window,
-- which collapses the editor + toggleterm split)
vim.keymap.set("n", "-", function()
  Snacks.bufdelete()
end)

-- LSP
vim.lsp.config("*", {
  root_markers = { ".git" },
})

vim.lsp.enable("lua_ls")
vim.lsp.enable("nil_ls")
vim.lsp.enable("ts_ls")
vim.lsp.enable("eslint")
vim.lsp.enable("html")
vim.lsp.enable("cssls")
vim.lsp.enable("tailwindcss")
vim.lsp.enable("biome")

-- LSP Keymaps
vim.api.nvim_create_autocmd("LspAttach", {
  group = vim.api.nvim_create_augroup("UserLspConfig", {}),
  callback = function(ev)
    vim.bo[ev.buf].omnifunc = "v:lua.vim.lsp.omnifunc"

    local opts = { buffer = ev.buf }

    vim.keymap.set("n", "gD", function()
      Snacks.picker.lsp_declarations()
    end, opts)
    vim.keymap.set("n", "gd", function()
      Snacks.picker.lsp_definitions()
    end, opts)
    vim.keymap.set("n", "gr", function()
      Snacks.picker.lsp_references()
    end, opts)
    vim.keymap.set("n", "K", vim.lsp.buf.hover, opts)
    vim.keymap.set("n", "gi", vim.lsp.buf.implementation, opts)
    vim.keymap.set("n", "<C-k>", vim.lsp.buf.signature_help, opts)
  end,
})
