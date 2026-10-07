local pi = require("pi")

vim.api.nvim_create_user_command("PiAsk", function(options)
  pi.ask(options)
end, { desc = "현재 파일 또는 선택 영역을 Pi에 질문", range = true })

vim.keymap.set(
  { "n", "x" },
  "<leader>pa",
  pi.ask,
  { desc = "파일 또는 선택 영역으로 Pi에게 질문" }
)
vim.keymap.set({ "n", "x" }, "<leader>pd", function()
  pi.ask(nil, true)
end, { desc = "현재 위치 또는 선택 영역의 진단으로 Pi에게 질문" })
