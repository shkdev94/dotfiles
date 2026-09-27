import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { parseGitStatus } from "./git-status.js"

const run = promisify(execFile)
const sections = [
  { key: "conflicts", title: "Conflicts" },
  { key: "staged", title: "Staged" },
  { key: "unstaged", title: "Unstaged" },
  { key: "untracked", title: "Untracked" },
] as const

function GitChanges(props: { directory: string }) {
  const [status, setStatus] = createSignal<ReturnType<typeof parseGitStatus> | null>(null)
  const [error, setError] = createSignal(false)

  createEffect(() => {
    const directory = props.directory
    let active = true
    let pending = false

    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const { stdout } = await run(
          "git",
          ["-C", directory, "status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"],
          { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
        )
        if (active) {
          setStatus(parseGitStatus(stdout))
          setError(false)
        }
      } catch {
        if (active) {
          setStatus(null)
          setError(true)
        }
      } finally {
        pending = false
      }
    }

    setStatus(null)
    setError(false)
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    onCleanup(() => {
      active = false
      clearInterval(timer)
    })
  })

  return (
    <box flexDirection="column">
      <Show when={status()} fallback={<text>{error() ? "Git 상태를 읽을 수 없음" : "Git 확인 중…"}</text>}>
        {(result) => (
          <Show when={result().changed > 0}>
            <text>{`git · ${result().branch} · ${result().changed} uncommitted${result().ahead ? ` ↑${result().ahead}` : ""}${result().behind ? ` ↓${result().behind}` : ""}`}</text>
            <For each={sections}>
              {(section) => (
                <Show when={result().groups[section.key].length > 0}>
                  <text> </text>
                  <text>{`${section.title} (${result().groups[section.key].length})`}</text>
                  <For each={result().groups[section.key]}>
                    {(entry) => <text>{`  ${entry.code} ${entry.file.replace(/[\x00-\x1f\x7f]/g, "?")}`}</text>}
                  </For>
                </Show>
              )}
            </For>
          </Show>
        )}
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "dotfiles.git-status",
  setup(context) {
    return context.ui.slot({
      replace: "sidebar.content",
      render: ({ sessionID }) => (
        <GitChanges
          directory={context.data.session.get(sessionID)?.location.directory ?? context.location?.directory ?? context.data.location.default().directory}
        />
      ),
    })
  },
})
