local pi = require("pi")
pi.setup()

vim.api.nvim_create_user_command("Pi", pi.toggle, { desc = "Pi 세션 화면 전환" })
vim.api.nvim_create_user_command("PiNew", pi.new_session, { desc = "새 Pi 세션" })
vim.api.nvim_create_user_command("PiAsk", function(options)
  pi.ask(options)
end, { desc = "선택 영역과 요청을 Pi로 전송", range = true })

vim.keymap.set("n", "<leader>pt", pi.toggle, { desc = "Pi 화면 전환" })
vim.keymap.set("n", "<leader>pn", pi.new_session, { desc = "새 Pi 세션" })
vim.keymap.set("n", "<leader>ps", pi.sidebar, { desc = "Pi 세션 목록" })
vim.keymap.set("n", "<leader>pl", pi.terminal, { desc = "Pi 세션 창" })
vim.keymap.set({ "n", "x" }, "<leader>pa", pi.ask, { desc = "선택 영역으로 Pi에게 요청" })
