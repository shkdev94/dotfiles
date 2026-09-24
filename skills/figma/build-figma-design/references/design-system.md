# 디자인 시스템 재사용

## 컴포넌트 찾기

필요한 컴포넌트의 Code Connect 파일을 먼저 찾는다. 웹에서는 `.figma.ts`, `.figma.js`, `.figma.tsx`, Kotlin에서는 `@FigmaConnect`, Swift에서는 `FigmaConnect`를 확인한다. 파일 확장자만 보고 기존 연결 방식을 변경하지 않는다.

Code Connect URL이 가리키는 라이브러리 파일에서 노드를 읽고 variant라면 부모 `COMPONENT_SET`의 key를 확인한다. 대상 화면의 파일 키와 라이브러리 파일 키를 혼동하지 않는다. 기존 화면의 인스턴스에서도 원본 컴포넌트·세트의 key를 찾을 수 있다.

## 라이브러리 검색

- `get_libraries`의 이미 추가된 목록과 추가 가능한 목록을 구분한다. 다음 offset이 있으면 필요한 라이브러리를 찾을 때까지 이어서 조회한다.
- 추가 가능한 라이브러리는 기본 검색에 포함되지 않을 수 있다. 반환된 `libraryKey`를 `includeLibraryKeys`에 전달한다.
- 결과가 비어도 파일 내부 검색은 할 수 있다. 라이브러리 키 없이 `search_design_system`을 호출해 확인한다. 조회 실패를 자산 없음으로 해석하지 않는다.
- `button icon input`처럼 여러 대안을 한 query에 섞지 않는다. 하나의 호출에 여러 query 항목으로 나눠 보낸다.

## 가져오기와 속성

확인된 key와 실제 node type에 맞춰 컴포넌트 또는 세트를 가져온다. variant 속성, TEXT·BOOLEAN·INSTANCE_SWAP 등 실제 property key를 읽고 설정한다. 임시 인스턴스로 속성을 확인했다면 그 ID를 기록하고 조사 후 제거한다.

원격 변수와 스타일은 해당 import API로 가져와 바인딩한다. `getLocalVariableCollectionsAsync()`는 현재 파일의 로컬 컬렉션만 반환하므로 원격 라이브러리 탐색을 대신하지 않는다. 색상·간격을 하드코딩하기 전에 필요한 토큰이 실제로 없는지 확인한다.

## 글꼴과 이미지

제품의 CSS·테마·기존 화면에서 글꼴을 찾고 `listAvailableFontsAsync()`로 실제 family/style을 확인한다. 존재하지 않는 이름은 임의로 교체하지 말고 제품에서 사용한 대응 관계를 확인한다.

같은 파일의 이미지 fill에서 얻은 `imageHash`를 재사용할 수 있다. 웹 캡처가 필요한 경우 도구가 안내하는 캡처 절차를 따르고, 이미지 프레임이 비어 있지 않은지 검사한다. 캡처용 임시 노드와 최종 결과 노드의 ID를 따로 기록한다.

출처: [공식 화면 구성 절차](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-generate-design/SKILL.md), [제품 글꼴 탐색](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-generate-design/references/discover-product-font.md).
