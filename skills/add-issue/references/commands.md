# 유용한 명령어

변수는 확인한 실제 값으로 채운다. 필요한 명령만 선택하고, 설치 버전과 저장소의 실행 규칙을 따른다.

## 조회와 등록

```bash
# 저장소·인증 확인
gh auth status
gh repo view "$REPOSITORY" --json nameWithOwner,url
# 이슈 양식과 중복 후보 확인
rg --files --hidden .github/ISSUE_TEMPLATE
gh issue list -R "$REPOSITORY" --state open --search "$SEARCH_QUERY" --limit 100
gh issue view "$ISSUE_URL" --comments
# 정리한 본문 파일로 생성 또는 기존 이슈 보완 (둘 중 해당 작업만)
gh issue create -R "$REPOSITORY" --title "$TITLE" --body-file "$BODY_FILE"
gh issue comment "$ISSUE_URL" --body-file "$COMMENT_FILE"
# 결과 확인
gh issue view "$ISSUE_URL" --json url,title,body,labels,assignees
```

검색 결과는 후보이며 같은 작업인지 본문으로 판단한다. 100개 제한을 전체 목록이라고 간주하지 않는다. Issue Type은 `gh issue create --help`에서 지원을 확인하고 대상 저장소에서 제공하는 값에 한해 `--type Bug` 등을 지정한다. Type과 라벨은 별개다.

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
