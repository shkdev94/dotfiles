# 유용한 명령어

변수는 확인한 실제 값으로 채운다. 필요한 명령만 선택하고, 설치 버전과 저장소의 실행 규칙을 따른다.

## 조회와 등록

```bash
# 저장소·인증 확인
gh auth status
gh repo view "$REPOSITORY" --json nameWithOwner,url
gh repo view "$REPOSITORY" --json viewerPermission,defaultBranchRef
gh label list --repo "$REPOSITORY"
# 이슈 양식과 중복 후보 확인
rg --files --hidden .github/ISSUE_TEMPLATE
gh issue list -R "$REPOSITORY" --state open --search "$SEARCH_QUERY" --limit 100
gh issue view "$ISSUE_URL" --comments
# 정리한 본문 파일로 생성 또는 기존 이슈 보완 (둘 중 해당 작업만)
gh issue create -R "$REPOSITORY" --title "$TITLE" --body-file "$BODY_FILE"
gh issue comment "$ISSUE_URL" --body-file "$COMMENT_FILE"
# 결과 확인
gh issue view "$ISSUE_URL" --json url,title,body,labels,assignees,state
```

검색 결과는 후보이며 같은 작업인지 본문으로 판단한다. 100개 제한을 전체 목록이라고 간주하지 않는다. Issue Type은 `gh issue create --help`에서 지원을 확인하고 대상 저장소에서 제공하는 값에 한해 `--type Bug` 등을 지정한다. Type과 라벨은 별개다.

지원되는 Issue Type을 API로 지정하는 대안:

```bash
gh api --method POST "repos/$OWNER_REPO/issues" \
  -f "title=$TITLE" -F "body=@$BODY_FILE" -f "type=$ISSUE_TYPE"
```

`OWNER_REPO`는 확인한 `소유자/저장소`, `ISSUE_TYPE`은 해당 저장소가 지원하는 실제 값이다. Enterprise에서는 API에 해당 `--hostname`을 지정한다. CLI와 API 생성 중 한 경로만 실행한다. 타입·프로젝트 등 기본 조회에 없는 필드는 해당 메타데이터를 지원하는 조회로 확인한다.

## 수정과 상태 변경

설치된 `gh issue edit --help`, `gh issue close --help`, `gh issue reopen --help`를 먼저 확인하고 요청된 변경만 실행한다.

```bash
# 본문·메타데이터를 확인한 뒤 요청된 필드만 수정
gh issue edit "$ISSUE_URL" --body-file "$BODY_FILE"
# 종료 또는 재개를 요청받은 경우에만 해당 명령 선택
gh issue close "$ISSUE_URL" --reason "$CLOSE_REASON"
gh issue reopen "$ISSUE_URL"
# 실제 반영 상태 확인
gh issue view "$ISSUE_URL" --json url,title,body,labels,assignees,state
```

`CLOSE_REASON`은 요청과 실제 처리 결과에 맞는 지원 값으로 지정한다. 위 명령을 일괄 실행하지 않는다. 본문 갱신에는 최신 내용을 반영한 파일을 사용하며 무관한 댓글·메타데이터를 덮어쓰지 않는다.

## 관련 PR 조회

```bash
gh pr list -R "$PR_REPOSITORY" --state open --search "$ISSUE_REFERENCE"
gh pr view "$PR_URL" --json url,body,baseRefName,headRefName,state
```

`PR_REPOSITORY`는 실제 구현 저장소다. 이슈 저장소와 같다고 가정하지 않는다. 식별자 검색은 후보 검색이며 본문 링크와 범위를 확인한다. 종료 문구 판단에는 [PR 연결과 이슈 종료 규칙](pull-request-links.md)을 적용한다.

## 스크린샷 첨부

```bash
gh attach --help
# 대상 저장소에 업로드하고 본문에 넣을 Markdown 획득
gh attach "$SCREENSHOT_PATH" -R "$REPOSITORY" --markdown
```

반환된 Markdown을 관련 설명 가까이에 넣고 본문 파일을 저장한 뒤 이슈를 생성한다. 로컬 파일 경로를 웹 이미지 URL처럼 쓰지 않는다. 업로드는 외부 쓰기이며 초안 작성만 요청된 경우 실행하지 않는다. 세션 쿠키나 인증 값을 명령 인자로 직접 노출하지 않는다.

설치 버전의 `gh issue create --help`가 `--attach`를 지원하면 생성과 첨부를 한 번에 처리할 수도 있다. 두 방식을 중복 사용하지 않는다.

```bash
gh issue create -R "$REPOSITORY" --title "$TITLE" --body-file "$BODY_FILE" --attach "$SCREENSHOT_PATH"
```

일부 첨부만 실패해도 이슈는 생성되고 명령은 실패 코드로 끝날 수 있다. 출력된 URL과 실제 이슈를 먼저 확인하고, 생성 명령을 곧바로 재실행하지 않는다.
