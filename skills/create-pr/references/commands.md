# 유용한 명령어

변수는 확인한 실제 값으로 채운다. 필요한 명령만 선택하고, 설치 버전과 저장소의 실행 규칙을 따른다.

## 일반 PR 생성·갱신

```bash
# 상태·기본 브랜치·단계별 diff 확인
git status --short
gh repo view "$REPOSITORY" --json nameWithOwner,defaultBranchRef
git log --oneline "$BASE_REF..$HEAD_REF"
git diff "$BASE_REF...$HEAD_REF"
gh pr list -R "$REPOSITORY" --head "$HEAD_BRANCH" --state open
# 확인한 브랜치 게시 후 명시적인 base·head와 본문으로 생성
git push -u "$REMOTE" "$HEAD_BRANCH"
gh pr create -R "$REPOSITORY" --base "$BASE_BRANCH" --head "$HEAD_SELECTOR" --title "$TITLE" --body-file "$BODY_FILE"
# 기존 PR 내용 갱신
gh pr edit "$PR_URL" --title "$TITLE" --body-file "$BODY_FILE"
# 게시 결과와 CI 확인
gh pr view "$PR_URL" --json url,title,body,baseRefName,headRefName,state
gh pr diff "$PR_URL"
gh pr checks "$PR_URL"
```

`HEAD_SELECTOR`는 같은 저장소면 브랜치 이름, fork면 설치된 `gh pr create --help`의 지원 형식과 head 소유자를 확인해 지정한다. `--fill`로 한국어 제목·본문 규칙을 대신하지 않는다. `gh pr create --dry-run`도 push를 수행할 수 있으므로 읽기 전용 미리보기로 사용하지 않는다. CI 대기는 필요할 때만 `gh pr checks --watch --interval 10`으로 수행하며 대기 중인 상태를 통과로 보고하지 않는다.

## gh stack

아래는 [공식 github/gh-stack](https://github.com/github/gh-stack#commands) 기준이다. 같은 이름의 다른 확장에 그대로 적용하지 않는다. `gh extension list`와 `gh stack --help`, 사용할 하위 명령의 `--help`로 설치 상태와 실제 지원 옵션을 확인한다. 없다면 환경의 패키지 관리 규칙을 따르며 임의 설치 대신 일반 PR 명령으로 base·head를 연결할 수 있다.

```bash
# 현재 스택 조회 (설치된 공식 확장에서)
gh stack view --json
# 이미 준비된 PR들을 아래 단계부터 위 단계 순서로 연결
gh stack link --base "$BASE_BRANCH" "$FIRST_PR_URL" "$SECOND_PR_URL"
```

`link`는 GitHub의 스택과 PR base를 변경한다. 브랜치 인자를 주면 push와 PR 생성도 수행할 수 있으므로, 제목·본문을 미리 확정해야 할 때는 일반 PR 명령으로 각 PR을 먼저 만든 뒤 URL로 연결한다. 일반 PR 생성만으로 GitHub의 별도 Stack 객체까지 생성됐다고 보고하지 않는다.

로컬에서 이미 관리하는 스택을 게시할 때:

```bash
gh stack submit --help
gh stack submit
```

`submit`은 스택 브랜치 push와 PR 생성·갱신을 수행한다. 대화형 편집에서 제목·본문을 작성할 수 있다. `--auto`는 자동 제목과 draft 상태를 사용할 수 있어 기본 실행 경로로 삼지 않는다. 비대화형 환경에서 작성 규칙을 충족하기 어렵다면 일반 PR 생성 후 `link`를 사용한다. 기존 PR의 제목·본문이 갱신됐다고 가정하지 말고 조회해 필요한 경우 `gh pr edit`으로 반영한다.

| 명령 | 효과와 사용 조건 |
| --- | --- |
| `gh stack push --remote "$REMOTE"` | 스택의 활성 브랜치를 lease 조건으로 push. PR 생성은 하지 않으며 일부 브랜치만 성공할 수 있으므로 실패 시 개별 결과 확인 |
| `gh stack rebase` | 스택 이력 재작성. 영향받는 브랜치와 요청 범위를 먼저 확인 |
| `gh stack rebase --continue` / `--abort` | 현재 작업에서 진행 중인 rebase의 충돌 해결 후 계속 또는 복구 |
| `gh stack sync` | fetch·rebase·push·PR/스택 갱신을 함께 수행. 상태 확인용으로 실행하지 않음 |

`sync --prune`은 병합 브랜치 삭제까지 포함하므로 PR 생성 과정에서 사용하지 않는다. rebase·push의 결과가 불확실하면 로컬·원격 SHA와 PR을 재조회하고 무조건 재시도하지 않는다.

## 화면 변경 증거 첨부

```bash
gh attach "$SCREENSHOT_PATH" -R "$REPOSITORY" --markdown
```

민감정보를 확인한 기존 스크린샷에 사용하고 반환된 Markdown을 본문 파일에 반영한다. 설치 버전이 지원하면 `gh pr create --attach "$SCREENSHOT_PATH"`도 가능하지만 중복 업로드하지 않는다. 일부 첨부 실패로 명령이 실패해도 PR이 생성됐을 수 있으므로 URL을 확인한 뒤 후속 작업을 결정한다.
