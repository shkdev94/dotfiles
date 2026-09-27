# Figma MCP 실행과 Plugin API 제약

## API 확인

[공식 타입 정의](plugin-api-standalone.d.ts)는 도입 시점의 API 스냅샷이다. `rg`로 사용할 메서드·속성·열거형을 검색하고 해당 타입 주변만 읽는다. 전체 파일을 매번 로드하지 않는다. 실제 도구 응답이 기능 미지원이라고 알리면 스냅샷만 믿고 재시도하지 않는다.

## 노드와 페이지

- `use_figma`의 호출 사이에는 JavaScript 변수나 현재 페이지가 유지되지 않는다. 이전 응답의 정확한 ID로 노드를 다시 조회한다.
- `figma.currentPage = page` 대신 `await figma.setCurrentPageAsync(page)`를 사용한다. 한 호출은 하나의 페이지를 다룬다.
- 속성을 읽기 전에 `node.type` 또는 기능 지원 여부로 타입을 좁힌다. 선택적 체이닝은 지원하지 않는 getter의 예외를 막지 않는다.
- `componentPropertyDefinitions`는 컴포넌트 세트 또는 독립 컴포넌트에서 읽는다. variant 컴포넌트라면 부모 세트에서 읽는다.
- `node.description`에 컴포넌트의 용도를 기록할 수 있지만 프레임이나 인스턴스의 작업 상태 저장소로 쓰지 않는다.
- 새 최상위 노드는 기존 노드의 경계를 확인해 빈 공간에 배치한다. 모두 `(0, 0)`에 생성하지 않는다.
- `figma.createPage()`는 Design 전용이다. FigJam은 섹션, Slides는 슬라이드 그리드로 구성한다.

## 글꼴과 텍스트

텍스트 변경은 **현재 글꼴 확인 → 로딩 완료 → 수정 → 변경 ID 반환** 순서로 진행한다. 혼합 글꼴은 `getStyledTextSegments(["fontName"])`으로 모두 확인한다. 정확한 style 이름을 모르면 `listAvailableFontsAsync()`로 조회한다.

```js
const text = await figma.getNodeByIdAsync("12:34");
if (!text || text.type !== "TEXT") throw new Error("대상 텍스트가 없습니다.");
const fonts = new Map();
for (const segment of text.getStyledTextSegments(["fontName"])) {
  fonts.set(JSON.stringify(segment.fontName), segment.fontName);
}
await Promise.all([...fonts.values()].map(font => figma.loadFontAsync(font)));
text.characters = "변경할 내용";
return { mutatedNodeIds: [text.id] };
```

이 규칙은 `characters` 변경 외에도 글꼴 변수 바인딩과 모드 변경에 적용된다. `FONT_FAMILY` 변수는 관련 모드의 모든 글꼴을 먼저 로드한다. `lineHeight`와 `letterSpacing`은 `{ unit, value }` 형태를 사용한다.

## 색상과 변수

- RGB는 `0–1` 범위다. paint의 `color`에는 `r`, `g`, `b`만 넣고 투명도는 paint의 `opacity`에 둔다.
- `fills`와 `strokes` 배열은 복사해 수정한 뒤 재할당한다. `setBoundVariableForPaint()`가 반환한 새 paint도 다시 할당한다.
- 변수 생성 시 실제 용도의 `scopes`를 지정한다. 예를 들어 배경은 `FRAME_FILL`·`SHAPE_FILL`, 텍스트는 `TEXT_FILL`, 간격은 `GAP`이다.
- 로컬 변수 목록이 비어 있어도 원격 라이브러리 변수가 없다는 뜻은 아니다. 라이브러리 탐색과 검색 결과를 함께 확인한다.

## 레이아웃

- 관련 자식을 담는 컨테이너는 auto-layout을 사용한다. 외부 캔버스 위치와 컨테이너 내부 자식 배치를 구분한다.
- `layoutSizingHorizontal/Vertical`은 `FIXED`, `HUG`, `FILL`을 사용한다. `primaryAxisSizingMode/counterAxisSizingMode`는 `FIXED`, `AUTO`를 사용한다.
- `HUG`는 auto-layout 프레임 자체 또는 해당 부모의 텍스트 자식에서 사용한다. `FILL`은 적절한 auto-layout 부모에 추가된 자식에서 사용한다.
- `appendChild()` 후 크기 모드를 지정한다. `resize()`는 크기 모드를 `FIXED`로 되돌리므로 `resize()` 다음에 `HUG`·`FILL`을 설정한다.
- 여러 줄 텍스트는 고정 너비와 `textAutoResize = "HEIGHT"`를 설정하고 실제 너비·높이를 확인한다.
- Slides에서는 최종 부모에 `appendChild()`한 뒤 `x`, `y`를 설정한다. 숨은 원점 오프셋을 좌표 보정으로 덮지 않는다.

## 검색과 반환

범위를 아는 경우 해당 노드의 `query()`나 `findAllWithCriteria()`를 사용한다. `node.query()`는 노드 하위 검색이며 전역 `figma.query()`로 바꾸지 않는다. 쓰기 결과에는 모든 생성·수정 ID와 검증에 필요한 수치만 반환한다.

출처: [공식 실행 지침](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-use/SKILL.md), [API 참고 자료](https://github.com/figma/mcp-server-guide/tree/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-use/references).
