---
name: connect-figma-code
description: Figma 컴포넌트와 실제 코드 컴포넌트를 Code Connect로 연결하거나 .figma.ts 템플릿을 수정할 때 사용한다. 컴포넌트 속성과 코드 props를 대조하고 연결 형식에 맞는 파일을 작성하며, 게시 요청이 없으면 원격 게시로 확대하지 않는다.
---

# Figma와 코드 컴포넌트 연결

## 목표와 역할

공개된 Figma 컴포넌트의 속성을 실제 코드 컴포넌트에 대응시키는 Code Connect 템플릿을 작성한다. 결과는 연결 대상과 속성 대응이 확인된 로컬 파일이다. 원격 매핑·게시까지 요청된 경우에만 해당 작업을 포함한다.

## 연결 대상 확인

1. MCP 연결, 컴포넌트의 라이브러리 게시 여부와 계정의 Code Connect 사용 가능 여부를 확인한다. 제한은 실제 도구 응답과 현재 문서로 판단한다.
2. 파일 키와 `node-id`를 확인한다. `get_code_connect_suggestions`의 `excludeMappingPrompt: true`로 연결할 컴포넌트와 실제 `mainComponentNodeId`를 찾는다.
3. 찾은 각 노드에 `get_context_for_code_connect`를 호출해 TEXT·BOOLEAN·VARIANT·INSTANCE_SWAP·SLOT 속성을 읽는다.
4. 프로젝트의 `figma.config.json`, 기존 연결 파일과 컴포넌트 구현에서 경로·import alias·실제 props를 확인한다. 여러 후보 중 요청으로 정할 수 없는 대응만 사용자에게 확인한다.

## 파일 작성

이 스킬의 신규 템플릿은 `.figma.ts`에서 `figma.code` tagged template을 반환하는 parserless 형식이다. `.figma.tsx`의 `figma.connect()` 형식과 섞지 않는다. 기존 parser 기반 연결을 수정해 달라는 요청이라면 해당 형식을 먼저 확인하고 요청 없이 변환하지 않는다.

필요한 경우 프로젝트가 `@figma/code-connect/figma-types`를 타입으로 사용하도록 기존 설정과 맞춘다. 파일은 기존 연결 파일 위치·include 규칙을 따른다. 상세 매핑과 반환 형태는 [템플릿 규칙](references/template-rules.md)을 읽는다.

## 검증과 전달

- 모든 VARIANT 값이 대응되는지, 실제 코드에 없는 props를 만들어 넣지 않았는지 확인한다.
- 아이콘·중첩 인스턴스·slot을 고정 JSX로 대체하지 않고 실제 속성과 연결한다.
- 기존 프로젝트의 타입 검사로 파일과 import를 검증한다. 사용자 요청에 포함된 원격 매핑은 반환 결과로 확인하고, 로컬 작성만 한 경우 게시했다고 보고하지 않는다.
- 연결한 컴포넌트와 파일, 대응하지 않은 속성이 있다면 그 이유를 전달한다.

출처: [Figma의 figma-code-connect 원본](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-code-connect/SKILL.md).
