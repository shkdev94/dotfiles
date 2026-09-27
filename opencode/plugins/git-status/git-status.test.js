import assert from "node:assert/strict"
import test from "node:test"
import { parseGitStatus } from "./git-status.js"

test("한 파일의 staged와 unstaged 변경을 모두 표시하고 중복 없이 전체 파일 수를 센다", () => {
  // 같은 파일에 커밋할 변경과 아직 올리지 않은 변경이 함께 있는 상태를 준비한다.
  const output = "## main...origin/main [ahead 1, behind 2]\0MM home.nix\0A  new.txt\0?? notes.md\0"

  // Git porcelain 출력을 사이드바에 표시할 그룹으로 변환한다.
  const status = parseGitStatus(output)

  // 분류는 각각 유지하고 전체 파일 수에는 중복 파일을 한 번만 포함한다.
  assert.deepEqual(status, {
    branch: "main",
    ahead: 1,
    behind: 2,
    changed: 3,
    groups: {
      conflicts: [],
      staged: [{ code: "M", file: "home.nix" }, { code: "A", file: "new.txt" }],
      unstaged: [{ code: "M", file: "home.nix" }],
      untracked: [{ code: "?", file: "notes.md" }],
    },
  })
})

test("충돌 파일을 일반 변경과 분리하고 이름 변경의 이전 경로를 파일로 세지 않는다", () => {
  // NUL 형식에서 rename 뒤에는 이전 파일명이 별도 레코드로 온다.
  const output = "## topic\0UU conflict.txt\0R  new name.txt\0old name.txt\0"

  // Git 상태를 충돌과 staged 파일로 분류한다.
  const status = parseGitStatus(output)

  // rename의 이전 경로는 별개 파일이 아니며 충돌도 staged로 중복 표시하지 않는다.
  assert.equal(status.changed, 2)
  assert.deepEqual(status.groups.conflicts, [{ code: "UU", file: "conflict.txt" }])
  assert.deepEqual(status.groups.staged, [{ code: "R", file: "new name.txt" }])
})

test("변경이 없으면 비어 있는 그룹과 0개의 파일을 반환한다", () => {
  // 커밋되지 않은 변경이 없는 브랜치 상태를 준비한다.
  const output = "## main...origin/main\0"

  // 상태 정보를 변환한다.
  const status = parseGitStatus(output)

  // 변경이 없을 때 사이드바가 비어 있도록 빈 상태를 보존한다.
  assert.equal(status.changed, 0)
  assert.deepEqual(status.groups, { conflicts: [], staged: [], unstaged: [], untracked: [] })
})
