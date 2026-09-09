# 안전한 명령과 검증

아래 변수는 실제 조회 결과로 채운다. 경로는 절대 경로로, 브랜치는 확인된 전체 ref로 다루고 문자열을 셸 코드로 평가하지 않는다. Git과 `gh`의 설치 버전에서 지원되는 필드·옵션을 확인한다.

## 읽기와 대상 확인

```bash
gh pr view "$PR_URL" --json url,state,mergedAt,headRefName,headRefOid,headRepository,headRepositoryOwner,baseRefName,mergeCommit,isCrossRepository
git remote -v
git worktree list --porcelain
git -C "$WORKTREE" status --porcelain=v1 --untracked-files=all
git -C "$WORKTREE" ls-files --others --ignored --exclude-standard
git ls-remote --heads "$HEAD_REMOTE" "refs/heads/$HEAD_BRANCH"
```

PR의 병합 여부·최종 head SHA·head 저장소 정체성을 확정할 수 없으면 조회를 보완하거나 해당 삭제를 보류한다. PR API의 삭제된 head 저장소나 ref에 대한 null 응답을 다른 저장소의 동명 ref로 대체하지 않는다. 로컬 후보는 `git for-each-ref`로 ref·SHA·upstream을 확인한다.

열린 PR 의존성은 대상 저장소에서 base·head를 조회하고 모든 페이지를 확인한다. `gh pr list`의 기본 개수 제한만으로 의존성이 없다고 결론내리지 않는다. 필요하면 `gh api --paginate`를 사용하며 GitHub Enterprise에서는 URL의 호스트를 지정한다.

## 워크트리와 로컬 브랜치

워크트리 제거는 삭제 대상 밖에서 실행한다. Git 상태 외에 무시된 파일, 잠금, 활성 작업, 서브모듈도 먼저 검사한다.

```bash
git -C "$REPO" worktree remove -- "$WORKTREE"
git -C "$REPO" branch -d -- "$LOCAL_BRANCH"
```

`branch -d` 성공 여부만으로 삭제 안전성을 결정하지 않는다. 추적 대상 설정에 따라 병합 판단이 달라질 수 있으므로 본문의 PR·tip·의존성 검사를 먼저 충족해야 한다.

### Squash·rebase 병합

PR이 실제로 병합되었고 로컬 tip이 그 PR의 최종 head SHA와 정확히 같더라도 조상 관계가 없어 `branch -d`가 거부될 수 있다. 아래 조건이 모두 확인된 경우에만 SHA 조건부 ref 삭제를 사용할 수 있다.

- PR 상태와 병합 시각이 확인된다.
- 로컬 tip은 병합된 PR 최종 head와 정확히 일치한다. 추가 커밋이나 분기를 삭제하지 않는다.
- 대상은 기본·base·보호·공유 브랜치가 아니며 다른 PR이나 로컬 stack에서 필요하지 않다.
- 해당 브랜치를 체크아웃한 워크트리가 없고 동시 사용 징후가 없다.
- 저장소 지침이 이 정리를 금지하지 않는다.

```bash
git -C "$REPO" update-ref -d "refs/heads/$LOCAL_BRANCH" "$VERIFIED_LOCAL_SHA"
```

조건이 맞지 않으면 자동으로 `-D`로 우회하지 않는다. 추가 커밋이나 후속 의존성은 본문의 필수 질문 절차를 거친다. 별도 보존 또는 폐기를 명시적으로 승인받은 경우에는 그 처리가 완료됐는지 확인한 뒤 현재 SHA를 조건으로 삭제한다. 이 방식은 branch 설정을 자동 정리하지 않으므로, 삭제 성공 후 해당 브랜치의 설정이 그대로인지 확인하고 그 설정 섹션만 제거한다. 다른 브랜치 설정은 변경하지 않는다.

## 원격 브랜치

검증한 head 저장소로 향하는 push URL을 사용한다. 원격에 여러 push URL이 있거나 URL 재작성으로 실제 대상이 달라질 수 있으면 먼저 대상이 하나인지 확인한다.

```bash
git push --force-with-lease="refs/heads/$HEAD_BRANCH:$VERIFIED_REMOTE_SHA" \
  "$VERIFIED_HEAD_PUSH_URL" ":refs/heads/$HEAD_BRANCH"
```

여기서 lease는 브랜치 내용을 덮어쓰는 용도가 아니라, 확인 이후 추가 커밋이 생긴 브랜치를 삭제하지 않기 위한 조건이다. 실패하면 lease를 제거하거나 일반 강제 push로 재시도하지 않는다. 삭제 거부·권한 부족은 보존 사유로 보고한다.

재조회로 원격 ref가 없음을 확인한 뒤, 정확히 매핑되는 로컬 원격 추적 ref만 남아 있다면 읽어둔 SHA를 조건으로 제거한다. fetch refspec을 확인하고 `refs/remotes/origin/...`을 가정하지 않는다.

## 참고 문서

- [git worktree](https://git-scm.com/docs/git-worktree)
- [git branch](https://git-scm.com/docs/git-branch)
- [git push](https://git-scm.com/docs/git-push)
- [git update-ref](https://git-scm.com/docs/git-update-ref)
- [gh pr view](https://cli.github.com/manual/gh_pr_view)
