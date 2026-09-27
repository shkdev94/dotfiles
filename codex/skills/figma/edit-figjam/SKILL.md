---
name: edit-figjam
description: FigJam 보드에 sticky·텍스트·섹션·연결선·표를 만들거나 편집할 때 사용한다. get_figjam으로 기존 구조를 확인하고 use_figma로 변경한다. Mermaid로 다이어그램을 생성하는 작업은 generate-figma-diagram을 함께 사용한다.
---

# FigJam 보드 편집

## 목표와 역할

기존 보드의 내용·읽는 순서·관계를 보존하면서 편집 가능한 FigJam 요소를 구성한다. 결과물은 변경한 노드와 검증된 보드 링크다.

## 구조 확인

[use-figma](../use-figma/SKILL.md)를 함께 읽는다. FigJam URL은 `/board/`이며, 기존 ID가 필요하면 먼저 `get_figjam`으로 트리를 확인한다. `get_metadata`는 FigJam에 사용할 수 없다. `get_screenshot`에는 조회한 유효한 노드 ID를 전달한다.

FigJam에는 하나의 암묵적 페이지가 있다. `figma.createPage()`를 호출하지 않고 section으로 영역을 구성한다. Design용 노드와 API가 모두 지원된다고 가정하지 않는다.

## 작성과 편집

1. 요청한 내용의 묶음과 읽는 방향을 정하고, 기존 영역의 경계를 확인해 작업 위치를 잡는다.
2. 짧은 메모는 sticky, 명확한 제목과 긴 설명은 text, 묶음은 section, 관계는 connector처럼 의미에 맞는 요소를 선택한다.
3. 연결선은 실제 노드 ID와 endpoint를 사용한다. 도형·sticky·텍스트의 크기에 맞춰 간격과 줄바꿈을 조정한다.
4. 텍스트는 현재 글꼴을 확인하고 로딩한 뒤 변경한다. 변경한 모든 ID를 반환하고 `console.log()`에만 결과를 남기지 않는다.
5. 기존 명명·색상 규칙을 따른다. 색상만으로 상태를 구분하지 말고 라벨도 남긴다.

노드별 속성이 필요할 때 [공식 FigJam 참고 자료](https://github.com/figma/mcp-server-guide/tree/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-use-figjam/references)에서 해당 유형의 `create-*` 문서를 읽는다. 표, 연결선 endpoint, 이미지처럼 Design과 동작이 다른 기능은 기억으로 추측하지 않는다.

## 검증

겹침·잘림·연결선 대상과 읽는 순서를 확인한다. 필요한 영역의 스크린샷으로 검증하고 결과 링크와 변경 범위를 전달한다. 다이어그램 생성 후 보완이라면 [generate-figma-diagram](../generate-figma-diagram/SKILL.md)의 파일 키를 재사용한다.

출처: [Figma의 figma-use-figjam 원본](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-use-figjam/SKILL.md).
