# OpenAI 웹 검색

OpenCode V2의 OpenAI Responses 요청에 서버에서 실행하는 `web_search` 도구를 추가한다.
OpenCode에 연결된 OpenAI 인증을 그대로 사용하며 별도 검색 업체의 키가 필요하지 않다.
OpenCode 2.0.18에서 기존 ChatGPT/Codex 연결로 실제 검색과 출처 반환을 확인했다.

`opencode/opencode.jsonc`의 최상위 `plugins` 배열에 다음 경로를 등록한다.

```json
{
  "plugins": [
    "/Users/sanghyeon/.dotfiles/opencode/plugins/openai-web-search"
  ]
}
```

파일을 변경한 뒤 `opencode reload`를 실행하고, OpenAI 모델을 선택한 세션에서
“OpenAI의 네이티브 web_search로 최신 Bun 릴리스를 검색하고 출처를 알려줘”라고 요청한다.
실행 기록에 `web_search`와 `providerCall.executed: true`가 나타나면 OpenAI가 검색한 것이다.
OpenCode의 별도 검색 업체를 호출하는 `websearch`와 구분된다.

기존 파일·셸·MCP 도구를 유지하며 검색을 매번 강제하지 않는다.
제목 생성과 컨텍스트 요약에는 검색을 추가하지 않는다.
HTTP와 WebSocket 전송을 지원한다. HTTP는 공식 OpenAI 및 Codex Responses 경로에만 적용한다.
OpenCode의 내장 `websearch` 설정·권한은 별도 도구에 적용되므로 이 플러그인을 끄려면
`plugins`에서 해당 경로를 제거한다.

이 플러그인은 OpenCode V2 전용이다. 검색 사용량은 사용한 OpenAI 인증과 서비스의 정책을 따른다.
WebSocket 훅은 실험적 API이므로 OpenCode 버전을 변경할 때 동작을 다시 확인한다.

```sh
node --test opencode/plugins/openai-web-search/index.test.js
```
