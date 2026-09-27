---
name: create-figma-plugin
description: Figma Design 안에서 실행할 플러그인을 MCP의 create_generative_plugin 또는 update_generative_plugin으로 만들거나 수정할 때 사용한다. 실제 기능과 UI를 완성하며, Codex·Claude 플러그인 설치나 일반 MCP 설정에는 사용하지 않는다.
---

# Figma 플러그인 작성

## 목표와 역할

Figma Design에서 사용자가 조작할 수 있는 UI와 요청한 기능을 가진 플러그인을 만든다. 결과는 저장된 플러그인 ID, 기능 설명과 실행해 볼 수 있는 링크다.

## 준비

핵심 동작, 입력·선택 조건과 필요한 컨트롤을 정한다. 플러그인 소스는 접근 가능한 사람에게 노출되므로 인증 키·토큰·서명 URL을 소스에 넣지 않는다. 인증이 필요한 외부 연동이라면 공개 데이터나 별도 서버 등 적절한 구조를 정한다.

사용자가 지정한 `planKey`를 사용하고, 없으면 `whoami`로 확인한다. 여러 저장 위치 중 결정할 근거가 없을 때만 선택을 요청한다.

## 생성과 수정

1. 새 플러그인은 `create_generative_plugin`으로 만든다. 반환된 기본 사각형 예제는 시작점이며 요청한 기능의 완료가 아니다.
2. `get_generative_plugin`으로 소스 URI를 받고 모든 현재 파일을 읽는다. 기존 플러그인을 수정할 때도 현재 소스를 먼저 읽는다.
3. [공식 소스 작성 계약](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-generative-plugins/references/authoring.md)을 읽고 UI 메시지 수명주기, 지원 API와 파일 교체 범위를 확인한다.
4. `code.ts`와 필요한 `ui.html`의 완전한 대체 내용을 작성한다. 핵심 실행 버튼, 잘못된 입력·선택에 대한 피드백을 포함하고 기존 기능은 요청한 범위에서만 바꾼다.
5. `update_generative_plugin`에 변경 파일 전체와 구체적인 `commitMessage`를 전달한다. `manifest.json` 교체나 새 파일 생성을 지원한다고 가정하지 않는다. `figma.showUI(__html__, ...)`와 비동기 완료 순서를 유지한다.

## 검증과 전달

빌드 오류가 나면 컴파일러 출력에 근거해 최소 수정으로 한 번 재시도한다. 계속 실패하면 오류와 남은 작업을 보고한다. 성공 응답과 실제 UI 실행 확인을 구분하며 버전은 반환된 경우에만 적는다.

이름·ID·핵심 동작과 시험 링크를 전달한다. 새 Design 파일의 링크는 `https://www.figma.com/file/new`에 `try-tool-resource-content-id=<실제 ID>`, `try-tool-resource-type=gen_tool`, `type=design`, `mode=design`을 query로 넣는다. 사용자가 제공한 기존 파일에서 실행하려면 그 URL에 해당 도구 query를 적용한다. 파일 URL을 추측하지 않는다.

출처: [Figma의 figma-generative-plugins 원본](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-generative-plugins/SKILL.md).
