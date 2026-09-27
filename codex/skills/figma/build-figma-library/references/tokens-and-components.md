# 토큰과 컴포넌트 규칙

## 변수

- 기존 컬렉션과 모드를 재사용한다. 새 구성이 필요하면 원시 값과 semantic alias를 구분하고 Light/Dark 등의 실제 요구 모드만 만든다.
- semantic 값은 `{ type: "VARIABLE_ALIAS", id: primitive.id }`로 연결한다. 이름만 다른 원시 값을 중복 저장하지 않는다.
- 배경은 `FRAME_FILL`·`SHAPE_FILL`, 텍스트 색은 `TEXT_FILL`, 테두리는 `STROKE_COLOR`, 간격은 `GAP`, 반경은 `CORNER_RADIUS`처럼 용도에 맞는 scope를 지정한다. 모든 선택기에 노출되는 기본값을 무심코 유지하지 않는다.
- 웹 code syntax는 실제 CSS 변수의 `var(--token-name)` 형태다. Android·iOS는 해당 플랫폼 표현을 사용하며 웹 wrapper를 붙이지 않는다.
- 색상·간격·반경 등 시각적 속성에 변수를 바인딩한다. 고정 픽셀 아이콘처럼 의도적으로 고정한 기하 구조는 구분한다.

## 컴포넌트와 variant

- 재사용 순서는 기존 로컬 컴포넌트, 적합한 라이브러리, 새 컴포넌트다. 시각적 결과는 맞지만 속성 계약이 다르면 wrapper를 검토한다.
- `combineAsVariants()` 이후에는 variant가 겹치지 않게 위치와 세트 크기를 다시 계산한다.
- 아이콘 교체는 `INSTANCE_SWAP`을 우선한다. 아이콘 종류마다 variant를 늘리지 않는다. 곱으로 커지는 상태 조합은 실제 요구에 맞게 분리한다.
- `addComponentProperty()`가 반환한 실제 key를 사용해 자식의 `componentPropertyReferences`를 연결한다. key 접미사를 추측하지 않는다.
- variant 컴포넌트의 속성 정의는 부모 `COMPONENT_SET`에서 읽는다. 독립 컴포넌트와 세트의 소유 관계를 먼저 확인한다.
- 컴포넌트 설명에는 사람이 읽는 용도와 사용법을 쓴다. 내부 실행 기록은 로컬 파일에서 관리한다.

## 검증

요구한 상태 조합과 실제 variant 수, 빠진 바인딩, 노드 겹침, 텍스트 잘림과 의미 있는 이름을 확인한다. Code Connect가 요청됐다면 실제 코드 컴포넌트와 매핑을 대조한다. 예상하지 않은 하드코딩과 잘못된 alias를 수정한 뒤 최종 화면을 확인한다.

출처: [토큰 생성](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-generate-library/references/token-creation.md), [컴포넌트 생성](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-generate-library/references/component-creation.md).
