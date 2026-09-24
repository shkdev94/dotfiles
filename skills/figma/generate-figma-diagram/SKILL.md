---
name: generate-figma-diagram
description: FigJam에 흐름도·아키텍처·시퀀스·ERD·상태도·간트 차트를 생성할 때 사용한다. generate_diagram 호출 전에 지원하는 Mermaid 문법과 대상 파일을 확인한다. 일반 Markdown 다이어그램 요청만으로 FigJam 파일을 만들지 않는다.
---

# FigJam 다이어그램 생성

## 목표와 역할

코드·명세·사용자 설명에서 확인한 관계를 편집 가능한 FigJam 다이어그램으로 만든다. 결과물은 다이어그램 링크이며, 불명확한 관계는 지어내지 않는다.

## 유형과 근거

`generate_diagram`은 `flowchart`, `sequenceDiagram`, `stateDiagram`·`stateDiagram-v2`, `gantt`, `erDiagram`을 지원한다. 파이 차트·마인드맵·클래스 다이어그램 등은 그대로 전달하지 말고 적합한 표현이나 FigJam 직접 작성을 선택한다.

서비스·저장소·큐의 구성은 아키텍처 흐름도, 순서가 있는 호출은 시퀀스, 테이블과 관계는 ERD로 표현한다. 코드나 자료에서 실제 이름·방향·조건을 확인하고 [유형별 문법](references/diagram-syntax.md)의 해당 유형을 읽는다.

## 생성

1. 특수문자는 따옴표로 감싸고 node ID는 공백 없는 camelCase로 짓는다. ID로 `end`, `subgraph`, `graph`를 사용하지 않는다.
2. Mermaid 소스에 emoji, HTML 태그, 라벨의 리터럴 `\n`을 넣지 않는다.
3. 이름과 `mermaidSyntax`를 전달한다. 기존 보드에 추가하거나 같은 작업을 반복할 때는 `fileKey`를 재사용한다.
4. 새 다이어그램은 도구가 파일을 생성할 수 있으므로 먼저 `create_new_file`을 호출하지 않는다.
5. 반환된 링크를 제공하고 내용과 관계를 확인한다. 같은 접근이 반복해서 실패하면 피드백이나 오류를 확인한 뒤 원인을 바꿔 해결한다.

## 주석·스타일과 수정

Mermaid가 표현하지 못하는 주석이나 색상은 필요한 경우 [edit-figjam](../edit-figjam/SKILL.md)으로 보완한다. 생성된 파일은 FigJam이므로 Design 전용 API를 쓰지 않는다.

`generate_diagram`의 재호출은 기존 노드의 부분 편집을 뜻하지 않는다. 기존 파일에 새 다이어그램을 추가하거나, 사용자가 교체를 요청한 기존 노드의 정확한 ID를 확인해 수정한다. 이전 결과를 임의로 삭제하지 않는다.

출처: [Figma의 figma-generate-diagram 원본](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-generate-diagram/SKILL.md).
