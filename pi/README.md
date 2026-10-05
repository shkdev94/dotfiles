# Pi 설정

Pi 에이전트 4개와 스킬 32개를 관리한다.

Pi CLI는 `flake.lock`의 nixpkgs가 제공하는 `pi-coding-agent`로 관리하고, 확장은 `packages/node/pi-extensions/package-lock.json`으로 고정한다. `nix build .#pi`로 빌드하고 `nxr`로 적용한다. `pi` 명령으로 실행한다.

초기 셋업에서는 sudo 없이 실행할 수 있도록 Nix 사용자 프로필에 Pi를 설치하고 아래 home-manager 설정과 같은 경로로 연결했다. 새 파일이 Git 추적에 포함되기 전에는 `nix build path:.#pi`로 빌드하고, 시스템 전체 적용은 `sudo darwin-rebuild switch --flake "path:$HOME/.dotfiles#mbp"`를 사용한다. 이후 시스템 적용이 완료되면 사용자 프로필의 중복 설치는 `nix profile remove pi`로 제거할 수 있다.

## Neovim 통합

`nvim/plugin/pi.lua`가 작업 디렉터리마다 Pi 세션 목록을 관리한다. 하나의 **Session** float 윗선에 세션 번호·제목·상태를 표시하고, 선택한 세션의 Pi TUI를 안쪽에 띄운다. 세션이 많으면 선택한 항목이 보이도록 제목 목록의 표시 범위를 옮긴다. float를 숨기거나 다른 세션을 선택해도 각 Pi 프로세스는 계속 실행된다. Neovim을 종료한 뒤에는 Pi의 세션 파일로 대화를 복원한다.

Neovim에서 실행하는 Pi는 `--tui-mode fullscreen`을 사용해 대화가 짧아도 입력창과 상태 영역을 터미널 아래쪽에 고정한다. 대화 내용은 그 위의 영역에서 스크롤한다.

Pi TUI는 [hasit/pi-community-themes의 Atom One Dark](https://github.com/hasit/pi-community-themes/blob/a6d7731fd46db4721654bf45161fb2cd1e8cbc1e/themes/atom-one-dark.json) 원본을 `themes/atom-one-dark.json`에 보관하고 사용한다. 원본의 MIT 라이선스는 `themes/LICENSE`에 포함한다. `settings.json`에서 `atom-one-dark`를 선택하며, home-manager는 테마 파일을 `~/.pi/agent/themes/`에 연결한다. Neovim float의 테두리·제목 색은 Neovim 테마가 관리한다.

- `<leader>pt` 또는 `:Pi`: float 열기·숨기기
- `<leader>pn` 또는 `:PiNew`: 새 세션
- `<leader>ps` 또는 `:PiSessions`: 세션 선택 메뉴
- `<leader>p[`·`<leader>p]`: 이전·다음 세션
- `<leader>pl`: Pi 세션 창으로 이동
- `<leader>pa` 또는 `:PiAsk`: Pi 화면을 열지 않고 질문 입력창만 띄운다. Enter를 누르면 일반 모드에서는 현재 위치를, Visual 모드에서는 선택한 코드를 선택 중인 세션으로 전송한다. 진단은 포함하지 않는다.
- `<leader>pd`: `<leader>pa`와 같은 내용에 해당 위치의 오류·경고를 더해 전송한다. 일반 모드에서는 커서가 있는 줄, Visual 모드에서는 선택 범위와 겹치는 진단을 포함한다. 진단이 없으면 생략한다. 두 키 모두 세션이 아직 실행 중이지 않다면 백그라운드에서 시작하며, Visual 모드와 `multicursor.nvim`의 다중 선택을 지원한다.
- Pi 터미널에서 `<C-\>s`: 세션 선택 메뉴, `<C-\>[`·`<C-\>]`: 이전·다음 세션, `<C-\>q`: float 숨기기

`extensions/nvim.ts`가 Neovim의 로컬 소켓으로 질문과 작업 상태를 주고받는다. 소켓과 플러그인 세션 목록은 `stdpath("state")/pi/`에, 대화는 Pi의 기본 세션 디렉터리에 저장된다. home-manager 적용 전에는 플러그인이 저장소의 `nvim.ts`를 Pi에 직접 넘긴다.

float 윗선에는 `1. 제목 ○` 형식으로 세션 번호·제목·상태 아이콘을 표시한다. 선택한 세션은 제목 색으로 구분한다. Pi에서 이름을 지정하지 않은 기존 세션은 첫 사용자 요청을 제목으로 사용한다.

상태 아이콘은 `○` 대기, `…` 시작 중, 움직이는 점자 아이콘은 작업 중, `⚙`+점자는 도구 실행, `◌`+점자는 정리 중, `↻`+점자는 재시도, `◉`는 입력 필요, `✓`는 결과 확인, `!`는 오류, `□`는 종료를 뜻한다. 취소된 작업은 새 결과로 표시하지 않는다. 자동 재시도 이벤트가 전달되지 않는 경우에는 일반 작업 중 아이콘으로 표시한다.

## 모델과 계정

- 기본 모델: `settings.json`의 `defaultModel`을 사용하며, 현재 `openai-codex/gpt-6-sol`, 추론 수준 `xhigh`.
- implementer·review_fixer: `openai-codex/gpt-6-sol`.
- reviewer·issue_writer: `openai-codex/gpt-6-astra`.
- Pi의 기본 Codex 구독 로그인을 사용하므로 모델 인증용 확장은 별도로 필요하지 않다.

고정된 Pi 0.86.1의 기본 모델 목록에는 `gpt-6-sol`이 없어 `models.json`에서 Codex의 기본 전송·OAuth를 이용하는 모델로 추가했다. Sol·Astra의 컨텍스트 예산은 872,000으로 맞췄다. 모델 자체의 지원 범위는 [OpenAI Sol 문서](https://developers.openai.com/api/docs/models/gpt-6-sol)와 [Astra 문서](https://developers.openai.com/api/docs/models/gpt-6-astra)를 확인했다. 실제 구독 계정의 모델 접근 권한은 로그인 후 확인한다.

Pi 안에서 `/accounts`를 실행하고 OpenAI Codex 계정에 로그인해 이름을 붙인다. 다른 계정도 같은 메뉴에서 추가한다. **Switch … account**로 현재 세션의 계정을 전환하고, **Set default account**로 새 세션의 기본 계정을 선택한다. 기존 세션은 자신의 계정 선택을 유지한다. 기본 Pi 로그인은 `/login`에서도 가능하다.

인증 정보는 `~/.pi/agent/auth.json`과 `~/.pi/agent/pi-accounts.json`에 저장되며 dotfiles에 연결하거나 커밋하지 않는다. 기존 Codex CLI의 계정 전환과는 별도로 관리한다.

## 에이전트·스킬·MCP

`pi-subagents`의 `subagents_enable`·`subagent` 도구로 implementer, reviewer, review_fixer, issue_writer에게 위임한다. 예: “reviewer에게 현재 diff 리뷰를 맡겨줘”. 최대 동시 실행은 5개로 설정했다. reviewer의 코드 수정 금지 지침을 유지한다.

스킬은 `~/.pi/agent/skills/`에서 로드하고, `/skill:write-good-code`처럼 명시 호출할 수 있다. Codex용 `~/.agents/skills/`의 중복 자동 로딩은 Pi 설정에서 제외한다. 하위 에이전트에도 저장소 지침과 스킬 목록을 전달한다. 에이전트와 스킬은 이 저장소의 `pi/` 원본을 수정한다.

Context7, Figma, browser-use는 `pi-mcp-adapter`로 연결한다. `/mcp-adapter`에서 확인하고, 모델은 `mcp` 도구로 필요한 서버 도구를 검색·호출한다. 서버는 필요할 때 연결된다.

Figma는 `figma-remote`(`https://mcp.figma.com/mcp`)를 사용한다. 최초 로그인이나 재인증은 `/mcp-auth figma-remote`로 진행하고, 브라우저에서 Figma 접근을 승인한다. OAuth 인증은 macOS Keychain에 저장되며 저장소에 포함하지 않는다.

원격 OAuth의 `clientName`은 `Codex`로 설정했다. 이 이름은 모델 설정과 별개인 OAuth 클라이언트 표시 이름이다. 2026-09-27 실제 연결 검증에서 `Pi Coding Agent`는 등록 단계의 HTTP 403으로 거절됐고, `Codex`는 인증과 원격 연결에 성공해 도구 40개·리소스 116개를 확인했다. [관련 이슈](https://github.com/nicobailon/pi-mcp-adapter/issues/49)의 클라이언트 메타데이터 변경 방식을 이용한다. Figma의 클라이언트 허용 정책이 바뀌면 재확인이 필요하다.

`~/.pi/agent/` 자체는 실제 디렉터리로 유지하고 설정 파일만 home-manager로 연결한다. `packages/`는 Nix가 빌드한 확장 디렉터리에 연결한다. 설정을 수정한 뒤에는 `/reload`로 다시 로드한다.

## 웹 검색

`pi-web-access` 0.32.0으로 `web_search`, `fetch_content`, `get_search_content`, `source_check`를 제공한다. 주 에이전트와 커스텀 하위 에이전트 4개 모두 이 확장을 로드한다. 모델은 필요할 때 `web_enable`로 도구를 활성화하고 다음 요청에서 사용한다.

`web-search.json`의 `searchRouting`은 `providers: ["openai"]`, `useCurrentModel: true`, `fallbackOn: ["unsupported"]`로 설정했다. 각 에이전트가 사용하는 OpenAI/Codex 모델과 현재 인증으로 별도의 검색 요청을 실행한다. OpenAI 외 검색 제공자로 자동 전환하지 않는다. 현재 모델이 이 검색 경로를 지원하지 않으면 실패를 보고한다.

검색 경로 설정은 자동 선택에 적용되므로 `web_search` 호출의 `provider` 인수를 생략한다. 명시적인 `provider` 인수나 최상위 `provider` 설정은 검색 경로를 우회할 수 있다. URL 본문은 `fetch_content`로 읽는다. Codex 인증을 재사용하므로 별도 OpenAI API 키를 설정하지 않는다. 설정 변경 후 `/reload`로 적용한다.

## 하단 상태 표시

`extensions/footer.ts`가 하단에 모델·추론 수준, 작업 경로, Git 브랜치·변경 수, 컨텍스트 잔량, Codex 주간 잔량을 한 줄로 표시한다.

```text
GPT-6-Sol xhigh · ~/.dotfiles · main · No changes · Context 52% left · weekly 66% left
```

위 숫자는 표시 예시다. 실제 값은 현재 세션과 계정에서 읽는다. Git 상태는 5초마다 갱신하고, 계정 변경도 5초마다 확인한다. 같은 계정의 주간 잔량은 최대 1분 동안 캐시한다. 진행 중 계정이 바뀐 조회 결과는 표시하지 않는다. API 토큰은 Pi의 현재 모델 인증으로 해결하고 저장하거나 출력하지 않는다.

주간 잔량은 `https://chatgpt.com/backend-api/wham/usage`에서 조회하며, 이 비공개 API가 실패하거나 주간 사용량을 제공하지 않으면 `?`로 표시한다. 컨텍스트도 계산할 수 없으면 `?`로 표시한다. 좁은 터미널에서는 경로·Git 정보부터 생략해 모델과 잔량을 우선 표시한다. 다른 확장의 상태 메시지는 공간이 있을 때 뒤에 이어 표시한다.

`changes`는 Git의 미커밋 변경 항목 수이며 대화 수가 아니다. 수정·추가·삭제된 파일과 미추적 파일/폴더가 포함되고, 깨끗한 저장소에서는 `No changes`로 표시한다.

입력창과 footer는 좌우 한 칸 여백을 사용한다. `extensions/editor.ts`는 위 테두리와 아래 테두리를 각 행의 바깥 가장자리에 그려 입력칸 높이를 확보하고 텍스트를 중앙에 배치하며, 기본 입력·단축키·이미지 붙여넣기와 자동 완성을 유지한다. MCP 아이콘은 `mcp-adapter.json`의 `settings.showStatusIcon = false`로 숨긴다.

별도의 footer 패키지나 추가 로그인이 필요하지 않다. 설정과 확장을 수정한 뒤에는 `/reload`로 적용한다.

## TUI 구현 기준

새 Node.js/TypeScript 기반 TUI에는 [Ink](https://github.com/vadimdemedes/ink)를 기본으로 사용한다. 탭뿐 아니라 선택·검색창, 설정 화면, 상태 표시 등의 UI 구성에 적용한다. 해당 프로젝트의 기존 UI 스택과 사용자 요구사항을 먼저 확인한다.

Pi 확장 안에서는 Ink로 구성한 화면을 Pi의 `render(width)`·입력 처리·수명 주기에 연결한다. `renderToString`은 터미널에 직접 출력하지 않는 화면 생성에 사용할 수 있으며, 이 모드의 입력·포커스 훅은 동작하지 않으므로 입력과 상태 갱신은 어댑터에서 처리한다. 별도의 Ink 앱에서는 Ink가 터미널 입출력을 관리한다.

이 기준은 `AGENTS.md`에 기록했다. 현재 footer와 입력창은 Pi의 기본 TUI API를 사용한다.

## 확장 선택

2026-09-27 GitHub API 조회 시점에 확인한 기능이 유사한 후보 중 저장소 스타 수가 높은 패키지를 선택했다. 모노레포의 스타 수는 개별 패키지의 스타 수와 구분한다.

| 기능 | 패키지 | GitHub 스타 | 비교 후보 |
| --- | --- | ---: | --- |
| 하위 에이전트 | [pi-subagents](https://github.com/nicobailon/pi-subagents) | 3,773 | tintinweb/pi-subagents: 1,218 |
| MCP 연결 | [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) | 1,551 | pi-mcp-adapter-v2: 2 |
| 계정 전환 | [@narumitw/pi-accounts](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-accounts) | 소속 모노레포 625 | pi-multi-pass: 507, pi-multi-account: 24, pi-codex-account: 11 |
| 웹 검색·본문 읽기 | [pi-web-access](https://github.com/nicobailon/pi-web-access) | 1,544 | ttttmr/pi-web-search: 30, Evizero/pi-codex-web-search: 1 |

계정 전환에는 수동 선택과 세션별 계정 유지 기능을 사용한다. 사용량에 따른 자동 계정 순환은 포함하지 않는다.
