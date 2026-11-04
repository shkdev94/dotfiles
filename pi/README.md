# Pi 설정

Radian 도메인 에이전트 프로필 7개와 Pi·Radian 공용 스킬을 관리한다.

Pi CLI는 `flake.lock`의 nixpkgs가 제공하는 `pi-coding-agent`로 관리한다. 독립 실행 Pi에는 기존 하위 에이전트·MCP·웹 접근 확장을 더 이상 설치하지 않는다. Radian은 내장 MCP·웹 접근 기능을 사용하고 `radian-subagent`로 위임한다. 설정 변경은 필요할 때 `nxr`로 적용하되, 현재 세션에는 `/reload` 또는 재시작이 필요하다. `pi` 명령은 독립 실행 Pi를 실행한다.

초기 셋업에서는 sudo 없이 실행할 수 있도록 Nix 사용자 프로필에 Pi를 설치했었다. 당시 사용자 프로필에 중복 설치한 Pi를 시스템 적용 후 `nix profile remove pi`로 제거할 수 있었다. 현재는 별도의 `.#pi` 확장 번들 빌드 대상을 제공하지 않는다.

## Pi 화면과 Neovim 연동

Pi는 기본 입력창·하단 상태 표시·출력 탐색을 사용한다. 개인 UI 확장과 외부 Neovim 연동용 Pi 소켓 서버 확장은 제거했다. 기존 Pi 세션에 로드된 확장은 `/reload`하거나 세션을 다시 시작해야 해제된다.

`nvim/lua/pi/`와 `nvim/plugin/pi.lua`의 클라이언트 설정은 별도로 남아 있지만, 현재 Pi 구성은 전송 대상 소켓을 제공하지 않는다. 이 클라이언트는 Radian의 내장 Neovim을 실행하는 데 필요하지 않다.

Pi TUI는 [hasit/pi-community-themes의 Atom One Dark](https://github.com/hasit/pi-community-themes/blob/a6d7731fd46db4721654bf45161fb2cd1e8cbc1e/themes/atom-one-dark.json) 원본을 `themes/atom-one-dark.json`에 보관하고 사용한다. 원본의 MIT 라이선스는 `themes/LICENSE`에 포함한다. `settings.json`에서 `atom-one-dark`를 선택하며, home-manager는 테마 파일을 `~/.pi/agent/themes/`에 연결한다.

## 모델과 계정

- Default model: `openai-codex/gpt-6.1-sol`, thinking level `xhigh`. This shared `settings.json` default applies to new sessions without an explicit model; it is not a parent-only model override. Agent profiles keep their explicit model selections, and existing conversations retain their selected model unless changed with `/model` while idle.
- Product Lead: `openai-codex/gpt-6-astra`, `xhigh`.
- Tech Lead·UI/UX Lead: `claude-code/claude-opus-5-5`, `xhigh`.
- PM·Engineer: `openai-codex/gpt-6.1-sol`, `high`.
- Designer: `claude-code/claude-sonnet-5-5`, `high`.
- QA: `openai-codex/gpt-6-astra`, `high`.
- Codex는 Pi의 기본 구독 로그인을 사용한다. Claude 모델은 `pi-claude-code` 확장과 Claude Code CLI의 별도 구독 로그인을 사용하며, Radian `/accounts`의 Anthropic 로그인과는 독립적이다.
- `commandAgents.plan`은 미설정이다. 지원 호스트의 기본 `/plan`은 부모가 필요한 분기를 선언하고 각 Lead가 상세 계획을 소유·게시하는 계층형 경로다. `/plan --single`만 기존 단일 계획 경로이며, 현재처럼 `commandAgents.plan`이 없으면 부모가 `radian-plan submit`으로 제출한다. 계획은 편집·작업 실행을 하지 않는다. 재위임은 호스트가 전이적 읽기 전용 계획 기능을 제공·허용할 때만 가능하며, 그 외에는 현재 호스트의 재위임 금지 등 제한을 따른다.
- 모델과 추론 수준은 실제 동적 카탈로그에서 확인한다. 기본 배정은 프로젝트 벤치마크로 입증된 우열이 아니며, 임의 대체하지 않는다.

고정된 Pi 0.86.1의 기본 모델 목록에는 `gpt-6-sol`이 없어 `models.json`에서 Codex의 기본 전송·OAuth를 이용하는 모델로 추가한 기록이 남아 있다. 현재 프로필의 `gpt-6.1-sol`과 `gpt-6-astra`는 `modelOverrides`로 컨텍스트 예산을 872,000으로 맞췄다. 모델 자체의 지원 범위는 [OpenAI Sol 문서](https://developers.openai.com/api/docs/models/gpt-6-sol)와 [Astra 문서](https://developers.openai.com/api/docs/models/gpt-6-astra)를 확인했다. 실제 구독 계정의 모델 접근 권한은 로그인 후 확인한다.

Pi 안에서 `/login`을 실행하고 OpenAI Codex 계정에 로그인한다. 별도의 계정 전환 확장은 사용하지 않는다.

인증 정보는 `~/.pi/agent/auth.json`에 저장되며 dotfiles에 연결하거나 커밋하지 않는다. 인증은 Pi의 기본 기능으로 관리한다.

## 프롬프트 명령어

`pi/prompts/*.md`를 home-manager로 `~/.pi/agent/prompts/`에 연결한다. 파일명이 명령어 이름이 되며, `sync-branch.md`는 `/sync-branch`로 호출한다.

```text
/sync-branch
/sync-branch origin/develop
/sync-branch --rebase origin/develop
```

`sync-branch`는 현재 브랜치에 기준 브랜치의 변경을 반영한다. 이미 최신이면 종료하고, fast-forward가 가능하면 그대로 이동한다. 이력이 갈라졌으면 기본은 merge이며, `--rebase`를 명시했을 때만 rebase한다. 기준 ref를 생략하면 PR base와 작업 맥락을 확인하고, 불명확하면 질문한다. 미커밋 변경과 진행 중인 Git 작업을 임의로 처리하지 않으며, 복구용 브랜치를 만든 뒤 최신화하고 검증한다. push나 자식 브랜치 전체 갱신은 포함하지 않는다.

옵션은 실행 코드가 아닌 프롬프트 인수다. 에이전트가 해석하므로 코드 수준의 옵션 검증이나 안전 경계를 제공하지 않는다. 처음 연결을 추가한 뒤에는 `nxr`로 적용하고 Pi에서 `/reload`한다. 이후 프롬프트 수정은 `/reload`만 하면 된다.

## 에이전트·스킬·MCP

부모는 전체 요청·직군 간 충돌·최종 통합을 담당하고, Product Lead → PM, Tech Lead → Engineer, UI/UX Lead → Designer로 도메인 판단과 제작을 나눈다. QA는 호스트 경로가 있으면 task에 배정된 Lead·구현자에게 `radian-task finding`·`radian-task verdict`로 보고하고 루트도 볼 수 있으며 담당 Lead가 확인한다. 경로가 없으면 소유자에게 반환한다. 독립성은 구현자·Lead·루트가 QA 판정을 대신할 수 없다는 뜻이지 루트 전용 보고가 아니며, 전달만으로 QA에 조율 권한이 생기지 않는다. QA는 제품 코드를 편집하지 않고 최초 구현과 모든 자동·수동/사람 수정의 현재 리비전을 새로 검증한다. 각 역할은 산출물·실행 근거·미확인 사항을 반환하며 모든 작업에 모든 역할을 호출하지 않는다.

런타임 도구 스키마와 호스트 지침이 이 안내보다 우선한다. 호스트가 `radian-task`와 task binding을 제공할 때만 역할별 동작을 사용하고, 없으면 `radian-supervisor progress/ask`(제공 시) 또는 최종 결과로 소유자에게 전달한다. 구형 실행 세션에는 명시적 재시작 전까지 새 도구가 없고 독립 실행 Pi에도 없으므로 없는 도구 호출이나 소유자 전용 채널 우회는 하지 않는다. 이 문서 변경은 재시작이나 설정 변경을 수행하지 않는다.

계층형 `/plan`에서 부모는 `radian-task declare`로 관련 분기만 선언한다. 각 Lead는 상세 계획과 소속 실무자를 책임지고 `radian-task publish-plan`으로 게시하며 호스트가 저장한다. 부모는 제한된 요약과 `ref@revision`만 받고 본문을 수락·저장·재작성하지 않는다. `radian-plan report`는 준비 상태를 보고할 뿐 승인·실행이 아니며, `radian-plan cancel`은 선언과 기존 산출물을 보존한다. 계획 자손도 읽기 전용이다.

구현자로 바인딩된 실무자는 `radian-task submit`으로 QA에 제출하며 검증 완료를 자칭하지 않는다. 수정은 호스트가 시도를 허용하고 소유자가 배정한 경우에만 한다. 최초 발견·최초 QA는 0회이고 오래된·중복·차단·중단 결과도 세지 않는다. 수정 후 자동 QA 재검증 3회 실패는 영구 잠금이며 4번째 자동 시도나 재배정·분할·이어가기·복구를 통한 초기화는 없다. 모든 담당 Lead는 재현, 3회 시도와 QA 근거, 확인된 원인과 가설, 수정 후보, 필요한 결정을 읽기 전용 `radian-task analysis`로 게시해 부모를 거쳐 사람에게 전달한다. 직접 사용자 `/repair status`, `/repair recheck`, `/repair cancel`, `/repair continue`만 수동 처리의 권한 경로이며 모델 문구·도구·알림은 권한이 아니다. 사람 수정도 새 QA가 필요하고 잠금은 유지된다.

프로필의 `delegation: { enabled: true }`가 있는 조율자만 재위임할 수 있다. 현재 세 Lead만 활성화하지만 역할 이름에 따른 특권은 없다. 생략·false는 실무자와 QA처럼 leaf로 남으며 `allowedAgents`는 사용하지 않는다. 일반 실행에서는 자신의 도구 권한과 자식 프로필의 권한이 별개이므로 읽기 전용 Lead가 쓰기 가능한 Engineer를 호출할 수 있지만, 계획·분석 목적의 자손은 프로필과 관계없이 같은 읽기 전용 제한을 상속한다.

`list`로 프로필을 확인하고 비동기 `spawn`으로 시작하며, 직속 자식의 `status`·`wait`·`reply`·`steer`·`stop`을 관리한다. 루트 깊이는 0, 최대 자손 깊이는 3, 전체 트리의 동시 실행은 5개, 보관은 128개다. 초기화·질문 대기·감독·정리 중인 실행도 한도에 포함하고, 초과 시 숨은 대기열 없이 명시적으로 거부한다. 조율자는 자손 정리를 끝내기 전에 최종 답을 내지 않는다. 분기 중단은 그 자손만, 루트 종료·교체·중단은 전체 자손을 정리한다. 재시작은 기록만 복원하고 실행을 재개하지 않는다.

협업 원칙은 [subagent 스킬](skills/subagent/SKILL.md)을 따른다. 이 스킬 자체가 권한을 부여하지는 않는다. 실제 호출법·소유권·한도·계획 제한은 Radian 호스트 지침과 도구 스키마가 제공한다. 기존 implementer·investigator·planner·reviewer는 새 구성 검증과 진행 작업·설정 참조 이관 후 제거했다. 기존 실행 기록은 유지한다.

`skills` frontmatter는 필수 스킬의 본문을 Radian 자식에게 자동 주입하는 목록이지 다른 스킬의 허용 목록이 아니다. 작업에 필요한 조건부 스킬·참조 문서는 별도로 읽는다. 스킬은 `~/.pi/agent/skills/`에서 로드하고, `/skill:write-good-code`처럼 명시 호출할 수 있다. 공용 `~/.agents/skills/` 경로의 중복 자동 로딩은 Pi 설정에서 제외한다. Radian 자식도 부모 전용 항목을 제외한 스킬 목록에서 필요한 스킬을 선택하며, 프로필에서 지정한 필수 스킬 본문은 자동 주입받는다. 에이전트와 스킬은 이 저장소의 `pi/` 원본을 수정한다.

Engineer는 `tools`를 생략해 SDK 기본 도구를 사용한다. Product/Tech Lead는 조회·웹 조사와 호스트 위임 도구를, UI/UX Lead와 Designer는 명시한 Figma·Spline 서버 프록시를 사용한다. 범용 `mcp` 설정 게이트웨이는 디자인 프로필에 주지 않는다. 서버 프록시는 해당 서버 안의 읽기 전용을 강제하지 않으므로 Lead의 리뷰 전용 동작은 업무 계약이다. 부족한 도구 스키마나 다른 서버 자료는 부모에게 요청한다.

QA는 조회·승인된 검증 명령과 기존 `mcp__browser_use` 서버 프록시를 사용한다. MCP 서버 설정이나 `directTools` 노출을 변경할 필요는 없다. 서버 프록시는 기술적으로 browser-use의 모든 도구를 호출할 수 있으므로, `browser_extract_content`(별도 모델 호출), `retry_with_browser_use_agent`, `browser_close_all` 금지는 강제 필터가 아닌 운영 지침이다. 범용 `mcp` 게이트웨이나 다른 서버 프록시는 QA에 주지 않는다. 도구 스키마가 필요하면 부모에게 요청하며, 서버 접근·인증이 없으면 검증을 차단 상태로 보고한다. browser-use가 있다고 desktop/computer-use도 있다고 가정하지 않는다.

모든 역할은 공유 브라우저·데스크톱 조작 권한을 부모와 조율해 한 번에 하나만 사용하고 명시적으로 인계·반납한다. 이는 런타임 잠금이나 강제 격리가 아니다. SDK 직접·중첩 도구 호출의 허용 목록은 운영체제 샌드박스가 아니며, 내부 MCP 프록시가 SDK 도구 호출을 통하지 않고 실행하는 개별 도구까지 필터링하지 않는다. 외부 CLI나 숨은 에이전트 helper로 제한을 우회하지 않는다.

`home.nix`가 `pi/agents/` 디렉터리 전체를 심볼릭 링크로 연결하므로 프로필 추가·삭제·수정에는 Nix 변경이나 `nxr`이 필요 없다. 새 `list`·`spawn`은 변경된 정의를 읽는다. 부모 프롬프트의 역할 목록은 다시 로드해 갱신하며, 이미 실행 중인 자식에는 변경이 소급 적용되지 않으므로 새로 실행한다.

Radian은 내장 MCP 기능으로 Context7, Figma, Spline, Vercel, browser-use, Obsidian 등을 연결한다. 서버 목록은 기존 `mcp-adapter.json`에 보관한다. 독립 실행 Pi에는 기존 MCP 어댑터가 없으므로 이 설정만으로 MCP 도구나 `/mcp-adapter` 명령이 제공되지 않는다. Radian의 `mcp` 도구에서 필요한 서버 도구를 검색·호출한다.

Browser Use runs through the dotfiles-owned `browser-use-mcp` launcher: headless Google Chrome, a fresh SDK-managed temporary profile per browser session, and cleanup on client disconnect. The upstream MCP tools remain unchanged. Build and activate the Nix package before reloading Radian; see [the launcher documentation](../packages/python/browser-use/README.md) for lifecycle, authentication, and verification details.

Figma는 `figma-remote`(`https://mcp.figma.com/mcp`)를 사용한다. 최초 로그인이나 재인증은 Radian의 `mcp({ action: "auth-start", server: "figma-remote" })`로 시작하고 브라우저에서 접근을 승인한다. OAuth 인증은 macOS Keychain에 저장되며 저장소에 포함하지 않는다.

원격 OAuth의 `clientName`은 `Codex`로 설정했다. 이 이름은 모델 설정과 별개인 OAuth 클라이언트 표시 이름이다. 2026-09-27 기존 pi-mcp-adapter에서 `Pi Coding Agent`는 등록 단계의 HTTP 403으로 거절됐고, `Codex`는 인증과 원격 연결에 성공해 도구 40개·리소스 116개를 확인했다. [당시 관련 이슈](https://github.com/nicobailon/pi-mcp-adapter/issues/49)의 클라이언트 메타데이터 변경 방식을 이용했다. 이는 Radian 내장 MCP의 OAuth 연결 검증을 대체하지 않으므로 별도 확인이 필요하다.

Vercel은 공식 원격 서버 `https://mcp.vercel.com/`를 사용한다. 최초 로그인이나 재인증은 Radian의 `mcp({ action: "auth-start", server: "vercel" })`로 시작하고 브라우저에서 접근을 승인한다. OAuth 인증은 macOS Keychain에 저장되며 저장소에 포함하지 않는다. 설정 파일은 심볼릭 링크로 연결되어 있으므로 `nxr` 없이 반영되며, 기존 세션은 다시 로드해야 한다.

### Google Workspace

Google 공식 원격 MCP의 `gmail`, `drive`, `docs`를 `mcp-adapter.json`에 설정한다. `home.nix`가 이 원본을 `~/.pi/agent/mcp-adapter.json`에 연결하므로 저장소 원본 수정은 별도 `nxr` 없이 반영된다. Radian에서 새 연결 설정을 읽으려면 해당 런타임을 다시 로드한다. Developer Preview Program에서 Workspace 계정과 Google Cloud 프로젝트 등록을 완료하고, 사용할 Gmail·Drive·Docs API와 각 MCP API를 활성화해야 한다.

Google Auth Platform에서 웹 애플리케이션 OAuth 클라이언트를 만들고 **Use this client for an AI-powered agent**를 선택한다. 승인된 리디렉션 URI는 `http://localhost:19876/callback`로 등록한다. Client ID는 공개 식별자로 설정에 기록하며, Client Secret은 `!python3` 명령이 저장소 밖의 `~/.config/mcp/credentials/google-workspace-oauth.json`에서 실행 시 읽는다. 이 파일은 Google에서 다운로드한 `web` 형식의 OAuth JSON이며, 부모 credentials 디렉터리는 권한 `700`, 파일은 `600`으로 유지한다. JSON 원문과 비밀값은 dotfiles나 Nix store에 넣지 않는다. Python은 기존 mise 환경을 사용한다.

현재는 읽기 전용 OAuth scope와 도구만 노출한다. Gmail은 메일 검색·조회, Drive는 파일 검색·조회·다운로드, Docs는 문서 읽기를 지원하며 생성·편집·발송·공유 도구는 노출하지 않는다. 인증 요청에 `access_type=offline`, `prompt=consent`를 넣어 refresh token을 요청한다. 발급된 인증 토큰은 MCP 런타임이 macOS Keychain에 보관하며 저장소에 포함하지 않는다.

Radian에서 설정을 다시 로드한 뒤 `gmail`, `drive`, `docs` 각각에 `mcp({ action: "auth-start", server: "gmail" })` 형식으로 인증을 시작하고, 브라우저에서 프리뷰 승인을 받은 Workspace 계정으로 접근을 승인한다. 동일한 콜백 포트를 사용하므로 한 인증을 마친 뒤 다음 인증을 진행한다. 설정과 공개 도구 목록 확인은 사용자 데이터 접근 검증을 대신하지 않으며, 실제 조회는 OAuth 로그인 후 별도로 확인한다.

### Spline

Spline은 `flake.nix`의 Homebrew cask `spline`으로 설치한다. [공식 데스크톱 MCP](https://docs.spline.design/generate/spline-mcp-server)는 앱에 내장되어 있으므로 별도 npm 서버를 설치하지 않는다.

설정된 `spline` 서버는 `/Applications/Spline.app/Contents/MacOS/Spline`을 `ELECTRON_RUN_AS_NODE=1`로 실행하고, `/Applications/Spline.app/Contents/Resources/spline-mcp.cjs`를 인수로 전달하는 stdio 연결을 사용한다. 앱의 로컬 편집기와 통신하며 MCP용 OAuth나 API 키는 필요하지 않다.

Spline 앱에서 로그인하고 **Settings → MCP**의 전역 스위치가 켜져 있는지 확인한 뒤 앱을 실행해 둔다. 도구 목록이 비어 있으면 앱에서 편집기를 열고 다시 연결한다. Radian은 설정을 다시 로드한 후 `mcp({ connect: "spline" })`로 확인한다. 앱을 이동하면 `mcp-adapter.json`의 실행 파일·스크립트 경로도 함께 갱신해야 한다.

### Obsidian

Obsidian의 `~/projects/obsidian` Vault에 커뮤니티 플러그인 [Local REST API with MCP](https://github.com/coddingtonbear/obsidian-local-rest-api) 5.4.0을 설치해 내장 MCP 서버를 사용한다. Obsidian이 실행 중이고 플러그인이 활성화되어 있어야 한다. 플러그인 설치·활성화는 Obsidian에서 관리하며, 별도의 npm MCP 서버는 설치하지 않는다.

`obsidian` 서버는 `https://127.0.0.1:27124/mcp/`에 연결한다. HTTP 서버는 비활성화하고 기본 루프백 주소로만 수신한다. 플러그인이 생성한 CA 인증서는 저장소 밖의 `~/.config/obsidian-mcp/ca.crt`에 보관하고 `caFile`로 해당 연결에만 적용한다. 전역 인증서 검증을 끄거나 시스템 신뢰 저장소를 변경하지 않는다. 인증서를 재발급하면 이 CA 파일도 갱신해야 한다.

Obsidian API 키는 `auth: "bearer"`, `bearerTokenStore: true`로 설정하고 macOS Keychain의 기존 인증 정보는 유지한다. 저장소에 키를 기록하지 않는다. 기존 `pi-mcp-adapter/cli.js` 토큰 설정·상태 확인 명령은 더 이상 설치되지 않으므로, 키를 변경할 때는 Radian 내장 MCP의 토큰 관리 방법을 확인해야 한다. 원본 API 키와 인증서 개인 키가 있는 Vault의 `.obsidian/`은 Git에서 제외한다.

노트 읽기·작성·검색 도구를 사용하며, 설정에서 범용 명령 실행 도구 `command_execute`를 제외한다. 플러그인의 설정 디렉터리 접근 차단은 기본값 그대로 유지한다. 새 연결 설정을 적용하려면 Radian에서 설정을 다시 로드한 뒤 `mcp({ connect: "obsidian" })`로 확인한다.

`~/.pi/agent/` 자체는 실제 디렉터리로 유지하고 설정 파일만 home-manager로 연결한다. `packages/`와 옛 `extensions/subagent/config.json`에 대한 Nix 관리 링크는 제거한다. 기존 사용자 소유 파일·인증 정보·세션은 삭제하지 않는다. 설정을 수정한 뒤에는 해당 런타임에서 다시 로드한다.

## 웹 검색

Radian은 내장 웹 접근 기능으로 `web_search`, `fetch_content`, `get_search_content`, `source_check`를 제공한다. 부모와 각 도메인 역할은 프로필에서 허용한 경우 `web_enable`로 도구를 활성화하고 다음 모델 요청에서 사용한다. QA는 제공된 근거와 직접 검증 도구를 우선 사용한다. 독립 실행 Pi에는 기존 웹 접근 확장을 설치하지 않는다. 현재 OpenAI 모델을 사용하는 검색 경로가 Claude 프로필에서 지원되지 않으면 실패를 보고하고 부모에게 자료를 요청한다.

`web-search.json`의 `searchRouting`은 `providers: ["openai"]`, `useCurrentModel: true`, `fallbackOn: ["unsupported"]`로 설정했다. 각 에이전트가 사용하는 OpenAI/Codex 모델과 현재 인증으로 별도의 검색 요청을 실행한다. OpenAI 외 검색 제공자로 자동 전환하지 않는다. 현재 모델이 이 검색 경로를 지원하지 않으면 실패를 보고한다.

검색 경로 설정은 자동 선택에 적용되므로 `web_search` 호출의 `provider` 인수를 생략한다. 명시적인 `provider` 인수나 최상위 `provider` 설정은 검색 경로를 우회할 수 있다. URL 본문은 `fetch_content`로 읽는다. Codex 인증을 재사용하므로 별도 OpenAI API 키를 설정하지 않는다. 설정 변경 후 Radian에서 다시 로드한다.

## TUI 구현 기준

새 Node.js/TypeScript 기반 TUI에는 [Ink](https://github.com/vadimdemedes/ink)를 기본으로 사용한다. 탭뿐 아니라 선택·검색창, 설정 화면, 상태 표시 등의 UI 구성에 적용한다. 해당 프로젝트의 기존 UI 스택과 사용자 요구사항을 먼저 확인한다.

Pi 확장 안에서는 Ink로 구성한 화면을 Pi의 `render(width)`·입력 처리·수명 주기에 연결한다. `renderToString`은 터미널에 직접 출력하지 않는 화면 생성에 사용할 수 있으며, 이 모드의 입력·포커스 훅은 동작하지 않으므로 입력과 상태 갱신은 어댑터에서 처리한다. 별도의 Ink 앱에서는 Ink가 터미널 입출력을 관리한다.

현재 구성에는 개인 Pi UI 확장이 없으며, 새로운 확장을 추가할 때 해당 프로젝트의 기존 UI 스택과 호환성을 확인한다.

## 과거 확장 선택 기록

아래 표는 2026-09-27 당시 GitHub API 조회와 기존 확장 선택 근거의 기록이다. 이 확장들은 현재 Nix/Pi 설정에서 설치하지 않는다. 당시 기능이 유사한 후보 중 저장소 스타 수가 높은 패키지를 선택했다. 모노레포의 스타 수는 개별 패키지의 스타 수와 구분한다.

| 기능 | 패키지 | GitHub 스타 | 비교 후보 |
| --- | --- | ---: | --- |
| 하위 에이전트 | [pi-subagents](https://github.com/nicobailon/pi-subagents) | 3,773 | tintinweb/pi-subagents: 1,218 |
| MCP 연결 | [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) | 1,551 | pi-mcp-adapter-v2: 2 |
| 웹 검색·본문 읽기 | [pi-web-access](https://github.com/nicobailon/pi-web-access) | 1,544 | ttttmr/pi-web-search: 30, Evizero/pi-codex-web-search: 1 |
