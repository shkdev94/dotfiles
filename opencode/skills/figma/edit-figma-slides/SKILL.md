---
name: edit-figma-slides
description: Figma Slides 문서를 만들거나 슬라이드·레이아웃·발표자 노트·구역을 편집할 때 사용한다. use_figma와 슬라이드 전용 API로 작업하며, 일반 PowerPoint나 Google Slides 요청만으로 Figma 문서를 만들지 않는다.
---

# Figma Slides 편집

## 목표와 역할

요청한 내용과 기존 디자인 언어에 맞춰 Figma Slides를 구성하거나 수정한다. 결과는 편집 가능한 슬라이드와 확인된 레이아웃, 요청에 포함된 발표자 노트다.

## 읽기와 작업 방식

- [use-figma](../use-figma/SKILL.md)를 읽는다. Slides의 구조는 읽기 전용 `use_figma`와 스크린샷으로 확인하며 `get_metadata`를 사용하지 않는다.
- 새 파일이 필요한 경우 [create-figma-file](../create-figma-file/SKILL.md)로 만들고 빈 그리드를 처리한다.
- 기존 문구·색상 수정은 해당 부분만 바꾼다. 구조를 추가할 때는 기존 글꼴·색상·공간 사용을 따른다. 새 문서는 목적·독자·브랜드에서 시각적 방향을 정한다.
- 템플릿 중심의 빠른 전체 생성에 `generate_deck`를 사용할 수 있는 환경이라면 요청에 맞춰 한 방식을 선택한다. 같은 요청으로 두 개의 덱을 만들지 않는다.

## 구성과 편집

1. 여러 슬라이드를 만들 때는 각 장의 메시지·공간 구성과 공통 글꼴·색상부터 정한다. 같은 배치를 기계적으로 반복하지 않는다.
2. 기존 슬라이드의 개선은 그 슬라이드에서 수행한다. 다시 만들기 위해 기존 슬라이드를 먼저 삭제하지 않는다.
3. 노드를 최종 부모에 `appendChild()`한 뒤 `x`, `y`를 설정한다. 순서가 틀려 생긴 오프셋을 상수 보정으로 숨기지 않는다.
4. `SLIDE_GRID`·`SLIDE_ROW`에는 일반 프레임의 fills·effects·layout 속성을 적용하지 않는다. 시각적 내용은 `SLIDE` 내부에 작성한다.
5. `getSlideGrid()`의 행은 배열이다. 구역 이름은 실제 `SLIDE_ROW.name`을 수정한다. `createPage()`는 사용하지 않는다.
6. 발표자 노트는 요청되었거나 발표 준비 범위에 포함될 때 작성한다. 슬라이드 문구를 되풀이하기보다 설명·전환·타이밍을 보완한다.

행 이동·삭제·노트 형식처럼 세부 API가 필요한 경우 [공식 Slides 참고 자료](https://github.com/figma/mcp-server-guide/tree/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-use-slides/references)에서 해당 파일을 읽는다.

## 검증

생성·수정 ID와 경계를 반환하고 겹침·텍스트 잘림·슬라이드 바깥 요소를 확인한다. 첫 구성에서 시각적 방향을 확인하고 관련 수정 후 최종 결과를 확인한다. 변경하지 않은 모든 슬라이드를 반복 캡처하지 않는다. 결과 링크와 변경한 장을 보고한다.

출처: [Figma의 figma-use-slides 원본](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-use-slides/SKILL.md).
