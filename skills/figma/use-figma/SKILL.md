---
name: use-figma
description: Figma MCP의 use_figma로 파일 구조를 조사하거나 노드·레이아웃·변수·스타일을 편집할 때 사용한다. Figma 파일 안에서 JavaScript를 실행하기 전에 읽는 공통 지침이며, 디자인을 애플리케이션 코드로 구현하는 작업은 implement-figma-design을 사용한다.
---

# Figma 파일 조사와 편집

## 목표와 역할

Figma 파일의 기존 구조와 디자인 시스템을 확인하고, 요청한 범위의 편집 가능한 노드를 만든다. 실행 결과에는 변경한 노드 ID와 검증 결과를 남긴다. 이 스킬은 `use_figma` 실행 규칙을 담당하며, 작업별 구성은 아래의 관련 스킬에서 다룬다.

## 실행 전 확인

- Figma MCP 도구가 연결돼 있는지 확인한다. 도구가 없으면 연결 문제를 알리고 문서를 변경한 것처럼 보고하지 않는다.
- URL에서 파일 키와 대상 노드를 추출한다. `node-id=12-34`는 `12:34`로 변환하며, 브랜치 URL에서는 브랜치 키를 사용한다.
- `/design/`, `/board/`, `/slides/`로 편집기 종류를 구분한다. 편집기마다 지원 API가 다르다.
- 기존 노드, 글꼴, 변수, 스타일과 배치를 먼저 읽는다. 이름이 비슷하다는 이유로 새 컴포넌트나 토큰을 중복 생성하지 않는다.
- Plugin API 코드를 작성하기 전에 [실행과 API 제약](references/plugin-api.md)을 읽는다. 정확한 메서드·타입은 같은 폴더의 타입 정의에서 필요한 부분만 검색한다.

## 실행과 복구

1. 한 번의 호출이 다룰 페이지와 변경 범위를 정한다. 의존하는 변경은 순서대로 실행하고, 재시도 시 중복 생성되는 큰 작업은 나눈다.
2. `use_figma`에는 일반 JavaScript를 전달한다. 최상위 `await`와 `return`을 사용하며 IIFE, `figma.closePlugin()`, `figma.notify()`를 넣지 않는다. `console.log()`는 반환 채널이 아니다.
3. 페이지 컨텍스트는 호출마다 초기화된다. 대상 페이지를 `await figma.setCurrentPageAsync(page)`로 지정하고 한 호출에서 여러 페이지를 오가지 않는다.
4. 글꼴 로딩을 포함한 비동기 작업을 모두 기다린다. 생성·수정한 노드 ID 전체와 필요한 이름·개수·크기를 구조화해 반환한다. 다음 호출에는 반환된 ID를 전달한다.
5. 오류의 `safeToRetryWithoutCanvasRead`가 `true`일 때만 원인을 고쳐 바로 재시도한다. `false`이거나 확인할 수 없으면 현재 캔버스를 읽고 부분 적용 범위를 확인한다.
6. 구조와 최종 화면을 확인한다. 관련 변경이 없으면 통과한 검증을 반복하지 않는다. 작업 표시용 `placeholder`를 사용했다면 완료 시 해제한다.

도구 스키마에 `skillNames`가 있으면 실제로 읽은 로컬 스킬 이름을 전달한다. 이 값은 사용 기록용이며 도구의 실행 인자를 대신하지 않는다.

## 작업별 연결

| 작업 | 함께 읽을 스킬 |
| --- | --- |
| 새 파일 생성 | [create-figma-file](../create-figma-file/SKILL.md) |
| 화면·모달·패널 구성 | [build-figma-design](../build-figma-design/SKILL.md) |
| 컴포넌트·변수·디자인 시스템 구축 | [build-figma-library](../build-figma-library/SKILL.md) |
| FigJam 보드 편집 | [edit-figjam](../edit-figjam/SKILL.md) |
| Slides 편집 | [edit-figma-slides](../edit-figma-slides/SKILL.md) |
| Figma 안에서 애니메이션 편집 | [edit-figma-motion](../edit-figma-motion/SKILL.md) |

작업에 필요한 스킬만 읽는다. 그룹 폴더에 함께 있다는 이유로 다른 스킬이 자동 적용되지는 않는다.

출처: [Figma의 figma-use 원본](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-use/SKILL.md). 이 저장소에 맞춘 한국어 지침이며 원본과의 대응은 [그룹 안내](../README.md)에 기록한다.
