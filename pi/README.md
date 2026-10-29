# Pi 설정

Pi 에이전트 4개와 스킬 32개를 관리한다.

Pi CLI는 `flake.lock`의 nixpkgs가 제공하는 `pi-coding-agent`로 관리하고, 확장은 `packages/node/pi-extensions/package-lock.json`으로 고정한다. `nix build .#pi`로 빌드하고 `nxr`로 적용한다. `pi` 명령으로 실행한다.

초기 셋업에서는 sudo 없이 실행할 수 있도록 Nix 사용자 프로필에 Pi를 설치하고 아래 home-manager 설정과 같은 경로로 연결했다. 새 파일이 Git 추적에 포함되기 전에는 `nix build path:.#pi`로 빌드하고, 시스템 전체 적용은 `sudo darwin-rebuild switch --flake "path:$HOME/.dotfiles#mbp"`를 사용한다. 이후 시스템 적용이 완료되면 사용자 프로필의 중복 설치는 `nix profile remove pi`로 제거할 수 있다.

## Pi 화면과 Neovim 연동

Pi는 기본 입력창·하단 상태 표시·출력 탐색을 사용한다. 개인 UI 확장과 외부 Neovim 연동용 Pi 소켓 서버 확장은 제거했다. 기존 Pi 세션에 로드된 확장은 `/reload`하거나 세션을 다시 시작해야 해제된다.

`nvim/lua/pi/`와 `nvim/plugin/pi.lua`의 클라이언트 설정은 별도로 남아 있지만, 현재 Pi 구성은 전송 대상 소켓을 제공하지 않는다. 이 클라이언트는 Radian의 내장 Neovim을 실행하는 데 필요하지 않다.

Pi TUI는 [hasit/pi-community-themes의 Atom One Dark](https://github.com/hasit/pi-community-themes/blob/a6d7731fd46db4721654bf45161fb2cd1e8cbc1e/themes/atom-one-dark.json) 원본을 `themes/atom-one-dark.json`에 보관하고 사용한다. 원본의 MIT 라이선스는 `themes/LICENSE`에 포함한다. `settings.json`에서 `atom-one-dark`를 선택하며, home-manager는 테마 파일을 `~/.pi/agent/themes/`에 연결한다.

## 모델과 계정

- 기본 모델: `settings.json`의 `defaultModel`을 사용하며, 현재 `openai-codex/gpt-6-sol`, 추론 수준 `xhigh`.
- implementer·review_fixer: `openai-codex/gpt-6-sol`.
- reviewer·issue_writer: `openai-codex/gpt-6-astra`.
- Pi의 기본 Codex 구독 로그인을 사용하므로 모델 인증용 확장은 별도로 필요하지 않다.

고정된 Pi 0.86.1의 기본 모델 목록에는 `gpt-6-sol`이 없어 `models.json`에서 Codex의 기본 전송·OAuth를 이용하는 모델로 추가했다. Sol·Astra의 컨텍스트 예산은 872,000으로 맞췄다. 모델 자체의 지원 범위는 [OpenAI Sol 문서](https://developers.openai.com/api/docs/models/gpt-6-sol)와 [Astra 문서](https://developers.openai.com/api/docs/models/gpt-6-astra)를 확인했다. 실제 구독 계정의 모델 접근 권한은 로그인 후 확인한다.

Pi 안에서 `/accounts`를 실행하고 OpenAI Codex 계정에 로그인해 이름을 붙인다. 다른 계정도 같은 메뉴에서 추가한다. **Switch … account**로 현재 세션의 계정을 전환하고, **Set default account**로 새 세션의 기본 계정을 선택한다. 기존 세션은 자신의 계정 선택을 유지한다. 기본 Pi 로그인은 `/login`에서도 가능하다.

인증 정보는 `~/.pi/agent/auth.json`과 `~/.pi/agent/pi-accounts.json`에 저장되며 dotfiles에 연결하거나 커밋하지 않는다. Pi가 인증과 계정 전환을 직접 관리한다.

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

`pi-subagents`의 `subagents_enable`·`subagent` 도구로 implementer, reviewer, review_fixer, issue_writer에게 위임한다. 예: “reviewer에게 현재 diff 리뷰를 맡겨줘”. 최대 동시 실행은 5개로 설정했다. reviewer의 코드 수정 금지 지침을 유지한다.

스킬은 `~/.pi/agent/skills/`에서 로드하고, `/skill:write-good-code`처럼 명시 호출할 수 있다. 공용 `~/.agents/skills/` 경로의 중복 자동 로딩은 Pi 설정에서 제외한다. 하위 에이전트에도 저장소 지침과 스킬 목록을 전달한다. 에이전트와 스킬은 이 저장소의 `pi/` 원본을 수정한다.

Context7, Figma, Spline, Vercel, browser-use, Obsidian은 `pi-mcp-adapter`로 연결한다. `/mcp-adapter`에서 확인하고, 모델은 `mcp` 도구로 필요한 서버 도구를 검색·호출한다. 서버는 필요할 때 연결된다.

Browser Use runs through the dotfiles-owned `browser-use-mcp` launcher: headless Google Chrome, a fresh SDK-managed temporary profile per browser session, and cleanup on client disconnect. The upstream MCP tools remain unchanged. Build and activate the Nix package before reloading Pi; see [the launcher documentation](../packages/python/browser-use/README.md) for lifecycle, authentication, and verification details.

Figma는 `figma-remote`(`https://mcp.figma.com/mcp`)를 사용한다. 최초 로그인이나 재인증은 `/mcp-auth figma-remote`로 진행하고, 브라우저에서 Figma 접근을 승인한다. OAuth 인증은 macOS Keychain에 저장되며 저장소에 포함하지 않는다.

원격 OAuth의 `clientName`은 `Codex`로 설정했다. 이 이름은 모델 설정과 별개인 OAuth 클라이언트 표시 이름이다. 2026-09-27 실제 연결 검증에서 `Pi Coding Agent`는 등록 단계의 HTTP 403으로 거절됐고, `Codex`는 인증과 원격 연결에 성공해 도구 40개·리소스 116개를 확인했다. [관련 이슈](https://github.com/nicobailon/pi-mcp-adapter/issues/49)의 클라이언트 메타데이터 변경 방식을 이용한다. Figma의 클라이언트 허용 정책이 바뀌면 재확인이 필요하다.

Vercel은 공식 원격 서버 `https://mcp.vercel.com/`를 사용한다. 최초 로그인이나 재인증은 `/mcp-auth vercel`로 진행하고 브라우저에서 접근을 승인한다. OAuth 인증은 macOS Keychain에 저장되며 저장소에 포함하지 않는다. 설정 파일은 심볼릭 링크로 연결되어 있으므로 `nxr` 없이 반영되며, 기존 Pi 세션에는 `/reload`가 필요하다.

### Google Workspace

Google 공식 원격 MCP의 `gmail`, `drive`, `docs`를 `mcp-adapter.json`에 설정한다. `home.nix`가 이 원본을 `~/.pi/agent/mcp-adapter.json`에 연결하므로 별도 전역 MCP 설정이나 `nxr` 없이 Pi의 `/reload`로 반영된다. Developer Preview Program에서 Workspace 계정과 Google Cloud 프로젝트 등록을 완료하고, 사용할 Gmail·Drive·Docs API와 각 MCP API를 활성화해야 한다.

Google Auth Platform에서 웹 애플리케이션 OAuth 클라이언트를 만들고 **Use this client for an AI-powered agent**를 선택한다. 승인된 리디렉션 URI는 `http://localhost:19876/callback`로 등록한다. Client ID는 공개 식별자로 설정에 기록하며, Client Secret은 `!python3` 명령이 저장소 밖의 `~/.config/mcp/credentials/google-workspace-oauth.json`에서 실행 시 읽는다. 이 파일은 Google에서 다운로드한 `web` 형식의 OAuth JSON이며, 부모 credentials 디렉터리는 권한 `700`, 파일은 `600`으로 유지한다. JSON 원문과 비밀값은 dotfiles나 Nix store에 넣지 않는다. Python은 기존 mise 환경을 사용한다.

현재는 읽기 전용 OAuth scope와 도구만 노출한다. Gmail은 메일 검색·조회, Drive는 파일 검색·조회·다운로드, Docs는 문서 읽기를 지원하며 생성·편집·발송·공유 도구는 노출하지 않는다. 인증 요청에 `access_type=offline`, `prompt=consent`를 넣어 refresh token을 요청한다. 발급된 인증 토큰은 어댑터가 macOS Keychain에 보관하며 저장소에 포함하지 않는다.

Pi에서 `/reload`한 뒤 `/mcp-auth gmail`, `/mcp-auth drive`, `/mcp-auth docs`를 하나씩 실행하고, 각각 브라우저에서 프리뷰 승인을 받은 Workspace 계정으로 접근을 승인한다. 동일한 콜백 포트를 사용하므로 한 인증을 마친 뒤 다음 인증을 진행한다. 설정과 공개 도구 목록 확인은 사용자 데이터 접근 검증을 대신하지 않으며, 실제 조회는 OAuth 로그인 후 별도로 확인한다.

### Spline

Spline은 `flake.nix`의 Homebrew cask `spline`으로 설치한다. [공식 데스크톱 MCP](https://docs.spline.design/generate/spline-mcp-server)는 앱에 내장되어 있으므로 별도 npm 서버를 설치하지 않는다.

Pi의 `spline` 서버는 `/Applications/Spline.app/Contents/MacOS/Spline`을 `ELECTRON_RUN_AS_NODE=1`로 실행하고, `/Applications/Spline.app/Contents/Resources/spline-mcp.cjs`를 인수로 전달하는 stdio 연결을 사용한다. 앱의 로컬 편집기와 통신하며 MCP용 OAuth나 API 키는 필요하지 않다.

Spline 앱에서 로그인하고 **Settings → MCP**의 전역 스위치가 켜져 있는지 확인한 뒤 앱을 실행해 둔다. 도구 목록이 비어 있으면 앱에서 편집기를 열고 다시 연결한다. Pi는 `/reload` 후 `mcp({ connect: "spline" })`로 확인한다. 앱을 이동하면 `mcp-adapter.json`의 실행 파일·스크립트 경로도 함께 갱신해야 한다.

### Obsidian

Obsidian의 `~/projects/obsidian` Vault에 커뮤니티 플러그인 [Local REST API with MCP](https://github.com/coddingtonbear/obsidian-local-rest-api) 5.4.0을 설치해 내장 MCP 서버를 사용한다. Obsidian이 실행 중이고 플러그인이 활성화되어 있어야 한다. 플러그인 설치·활성화는 Obsidian에서 관리하며, 별도의 npm MCP 서버는 설치하지 않는다.

`obsidian` 서버는 `https://127.0.0.1:27124/mcp/`에 연결한다. HTTP 서버는 비활성화하고 기본 루프백 주소로만 수신한다. 플러그인이 생성한 CA 인증서는 저장소 밖의 `~/.config/obsidian-mcp/ca.crt`에 보관하고 `caFile`로 해당 연결에만 적용한다. 전역 인증서 검증을 끄거나 시스템 신뢰 저장소를 변경하지 않는다. 인증서를 재발급하면 이 CA 파일도 갱신해야 한다.

Pi의 API 키는 `auth: "bearer"`, `bearerTokenStore: true`로 macOS Keychain에 저장한다. 저장소에 키를 기록하지 않는다. 키를 변경할 때는 `~/.pi/agent/packages/pi-mcp-adapter/cli.js token set obsidian`의 숨김 입력을 사용하고, 같은 CLI의 `token status obsidian`으로 저장 상태를 확인한다. 원본 API 키와 인증서 개인 키가 있는 Vault의 `.obsidian/`은 Git에서 제외한다.

노트 읽기·작성·검색 도구를 사용하며, Pi에서는 범용 명령 실행 도구 `command_execute`를 제외한다. 플러그인의 설정 디렉터리 접근 차단은 기본값 그대로 유지한다. 새 연결 설정을 적용하려면 Pi에서 `/reload` 후 `mcp({ connect: "obsidian" })`로 확인한다.

`~/.pi/agent/` 자체는 실제 디렉터리로 유지하고 설정 파일만 home-manager로 연결한다. `packages/`는 Nix가 빌드한 확장 디렉터리에 연결한다. 설정을 수정한 뒤에는 `/reload`로 다시 로드한다.

## 웹 검색

`pi-web-access` 0.32.0으로 `web_search`, `fetch_content`, `get_search_content`, `source_check`를 제공한다. 주 에이전트와 커스텀 하위 에이전트 4개 모두 이 확장을 로드한다. 모델은 필요할 때 `web_enable`로 도구를 활성화하고 다음 요청에서 사용한다.

`web-search.json`의 `searchRouting`은 `providers: ["openai"]`, `useCurrentModel: true`, `fallbackOn: ["unsupported"]`로 설정했다. 각 에이전트가 사용하는 OpenAI/Codex 모델과 현재 인증으로 별도의 검색 요청을 실행한다. OpenAI 외 검색 제공자로 자동 전환하지 않는다. 현재 모델이 이 검색 경로를 지원하지 않으면 실패를 보고한다.

검색 경로 설정은 자동 선택에 적용되므로 `web_search` 호출의 `provider` 인수를 생략한다. 명시적인 `provider` 인수나 최상위 `provider` 설정은 검색 경로를 우회할 수 있다. URL 본문은 `fetch_content`로 읽는다. Codex 인증을 재사용하므로 별도 OpenAI API 키를 설정하지 않는다. 설정 변경 후 `/reload`로 적용한다.

## TUI 구현 기준

새 Node.js/TypeScript 기반 TUI에는 [Ink](https://github.com/vadimdemedes/ink)를 기본으로 사용한다. 탭뿐 아니라 선택·검색창, 설정 화면, 상태 표시 등의 UI 구성에 적용한다. 해당 프로젝트의 기존 UI 스택과 사용자 요구사항을 먼저 확인한다.

Pi 확장 안에서는 Ink로 구성한 화면을 Pi의 `render(width)`·입력 처리·수명 주기에 연결한다. `renderToString`은 터미널에 직접 출력하지 않는 화면 생성에 사용할 수 있으며, 이 모드의 입력·포커스 훅은 동작하지 않으므로 입력과 상태 갱신은 어댑터에서 처리한다. 별도의 Ink 앱에서는 Ink가 터미널 입출력을 관리한다.

현재 구성에는 개인 Pi UI 확장이 없으며, 새로운 확장을 추가할 때 해당 프로젝트의 기존 UI 스택과 호환성을 확인한다.

## 확장 선택

2026-09-27 GitHub API 조회 시점에 확인한 기능이 유사한 후보 중 저장소 스타 수가 높은 패키지를 선택했다. 모노레포의 스타 수는 개별 패키지의 스타 수와 구분한다.

| 기능 | 패키지 | GitHub 스타 | 비교 후보 |
| --- | --- | ---: | --- |
| 하위 에이전트 | [pi-subagents](https://github.com/nicobailon/pi-subagents) | 3,773 | tintinweb/pi-subagents: 1,218 |
| MCP 연결 | [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) | 1,551 | pi-mcp-adapter-v2: 2 |
| 계정 전환 | [@narumitw/pi-accounts](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-accounts) | 소속 모노레포 625 | pi-multi-pass: 507, pi-multi-account: 24, pi-codex-account: 11 |
| 웹 검색·본문 읽기 | [pi-web-access](https://github.com/nicobailon/pi-web-access) | 1,544 | ttttmr/pi-web-search: 30, Evizero/pi-codex-web-search: 1 |

계정 전환에는 수동 선택과 세션별 계정 유지 기능을 사용한다. 사용량에 따른 자동 계정 순환은 포함하지 않는다.
