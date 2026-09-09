---
name: create-branch
description: 작업용 Git 브랜치 생성을 요청할 때 사용한다. 작업 목적, 시작 지점과 기존 브랜치를 확인하고 명명 규칙에 맞게 생성한다.
---

# 작업 브랜치 생성

## 목표와 역할

작업 목적과 시작 지점을 입력받아 기존 브랜치와 작업 상태를 확인하고, 명명 규칙에 맞는 작업 브랜치를 생성하거나 재사용한다. 결과물은 작업할 브랜치와 확인된 시작 커밋, 작업 경로다.

## 진행 방식

- 저장소 지침, 현재 브랜치와 변경 사항, 워크트리 및 기존 관련 브랜치를 확인한다. 사용자나 실행 환경의 명시적인 브랜치 이름·접두사 제약을 아래 기본 형식보다 우선한다.
- 시작 지점은 사용자가 지정한 ref를 우선한다. 없으면 작업 맥락과 원격 기본 브랜치를 확인하며 `main`을 가정하지 않는다. 후속 작업이면 선행 PR의 실제 head와 반영 상태를 확인한다.
- 기존 브랜치가 있으면 작업 목적과 시작 지점을 확인해 재사용한다. 동명 브랜치를 덮어쓰거나 초기화하지 않는다.
- 미커밋 변경을 임의로 stash·폐기하지 않는다. 브랜치 전환으로 충돌하거나 다른 작업을 섞게 되는 경우에만 처리 방식을 확인한다.
- 시작 ref를 확인한 뒤 새 브랜치를 생성·전환한다. 별도 워크트리를 요청했다면 해당 워크트리에 생성한다.

## 브랜치 이름

저장소 루트와 작업 경로에 적용되는 `AGENTS.md`에 브랜치 이름·접두사 규칙이 있으면 그 규칙을 우선한다. 아래 형식은 별도 규칙이 없는 경우의 기본값이다. 사용자가 이번 작업에 명시한 이름이나 실행 환경의 필수 제약은 함께 반영한다.

- 이번 작업에 지정된 브랜치가 있으면 그 이름을 그대로 사용한다. 아래 형식을 맞추려고 브랜치를 바꾸거나 쓰기 가능한 범위 밖에 새 브랜치를 만들지 않는다.
- 브랜치 이름을 직접 지정할 수 있고 생성이 허용된 환경에서는 기존 저장소의 `<분류>/<영문-요약>` 형식을 따른다. 기능은 `feature/`, 버그 수정은 `fix/`를 사용한다. 커밋·PR 제목의 `feat`는 브랜치에서 `feature`로 표기한다. 그 외 분류는 최근 유사 작업의 실제 브랜치 명명 방식을 확인해 따른다.
- 요약은 변경 목적을 나타내는 짧은 영문 소문자와 숫자를 하이픈으로 연결한다. 공백, 한글, `#`은 사용하지 않는다. 이슈 번호나 단계 순서 번호를 필수로 붙이지 않는다.
- stacked PR도 각 단계의 목적에 맞는 동일한 브랜치 형식을 사용한다. 예를 들어 `feature/redact-enhancement`를 base로 `feature/rbac-organization`을 연결한 기존 PR처럼 구성하며, 의존 순서와 이슈 연결은 PR 본문에 기록한다.
- 시작 브랜치나 기존 선행 PR의 브랜치는 이 규칙에 맞춰 변경하지 않는다. 스택 의존 관계는 이름이 아닌 실제 PR의 base와 head로 확인한다.

```text
feature/extract-table-right-panel
feature/organization-admin-page-separation
fix/dataset-document-delete
fix/redact-delete-focus
```

## 결과 전달

생성 또는 재사용한 브랜치, 시작 ref와 커밋, 현재 작업 경로를 확인해 한국어로 보고한다. 생성할 수 없으면 이유와 필요한 다음 조치를 알린다.

## 유용한 명령어

변수는 확인한 실제 값으로 채운다. 필요한 명령만 선택하고, 설치 버전과 저장소의 실행 규칙을 따른다.

```bash
# 현재 상태와 기존 브랜치·워크트리 확인
git status --short
git branch --show-current
git branch --list "$BRANCH"
git worktree list --porcelain
gh repo view "$OWNER_REPO" --json viewerPermission,defaultBranchRef
# 원격 기본 브랜치에서 시작하는 경우에만 조회·갱신
DEFAULT_BRANCH="$(gh repo view "$OWNER_REPO" --json defaultBranchRef --jq '.defaultBranchRef.name')"
git fetch --no-tags "$REMOTE" "$DEFAULT_BRANCH"
git rev-parse "refs/remotes/$REMOTE/$DEFAULT_BRANCH"
# 시작 커밋 확인 후 생성 (재사용이라면 switch만)
git rev-parse --verify "$START_REF^{commit}"
git switch -c "$BRANCH" "$START_REF"
# 별도 워크트리를 요청한 경우 위 생성 명령 대신 사용
git worktree add -b "$BRANCH" "$WORKTREE_PATH" "$START_REF"
```

지정된 시작 ref나 선행 PR에서 시작할 때는 기본 브랜치 조회·fetch 단계 대신 해당 ref를 확인한다. fetch 후 원격 추적 ref가 갱신됐는지 확인하고, 사용자 지정 refspec이면 실제 갱신된 ref를 사용한다. `git switch -C`로 기존 브랜치를 초기화하지 않는다.

공식 `github/gh-stack`이 설치되어 있고 스택 구성이 요청된 경우, `gh stack init --help`·`gh stack add --help`를 먼저 확인한다.

```bash
# 기존 브랜치를 아래 단계부터 등록하거나 없는 브랜치 생성
gh stack init --base "$BASE_BRANCH" "$FIRST_BRANCH" "$SECOND_BRANCH"
# 스택 최상단에서 새 단계 생성
gh stack add "$NEXT_BRANCH"
```

`init`은 로컬 스택 설정과 브랜치를 변경하고 `git rerere`를 활성화할 수 있다. `add -Am`은 전체 staging·커밋까지 결합하므로 단순 브랜치 생성에 사용하지 않는다.
