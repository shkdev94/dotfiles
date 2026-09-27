const conflicts = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"])

export function parseGitStatus(output) {
  const records = output.split("\0")
  const header = records.shift() ?? ""
  const branch = header.startsWith("## ") ? header.slice(3) : ""
  const [name, upstream] = branch.split("...")
  const ahead = Number(upstream?.match(/\bahead (\d+)/)?.[1] ?? 0)
  const behind = Number(upstream?.match(/\bbehind (\d+)/)?.[1] ?? 0)
  const groups = { conflicts: [], staged: [], unstaged: [], untracked: [] }
  const changed = new Set()

  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record) continue
    const code = record.slice(0, 2)
    const file = record.slice(3)
    changed.add(file)

    if (conflicts.has(code)) {
      groups.conflicts.push({ code, file })
    } else if (code === "??") {
      groups.untracked.push({ code: "?", file })
    } else {
      if (code[0] !== " ") groups.staged.push({ code: code[0], file })
      if (code[1] !== " ") groups.unstaged.push({ code: code[1], file })
    }

    // In porcelain -z output, a rename/copy has an extra NUL-terminated old path.
    if (code.includes("R") || code.includes("C")) index++
  }

  return {
    branch: name.replace(/^(?:No commits yet|Initial commit) on /, ""),
    ahead,
    behind,
    changed: changed.size,
    groups,
  }
}
