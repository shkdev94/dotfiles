# 정적 transform과 애니메이션의 결합

## 중첩 구조

`data-motion-wrapper-for`, `data-motion-keys`, `data-motion-transform-template`가 있으면 정적 배치와 움직임이 분리돼 있다는 뜻이다. 바깥 wrapper·정적 transform 요소·안쪽 노드의 구조를 임의로 합치지 않는다.

- wrapper와 안쪽 요소에 지정된 `data-motion-keys`에 따라 트랙을 배치한다.
- 정적 transform template을 유지하고 애니메이션 transform과 합성한다.
- motion 값에 정적 회전이 이미 포함돼 있다면 중복 적용하지 않는다. 예를 들어 정적 45도 위에서 절대 45→125도라면 추가 회전은 0→80도다.
- CSS의 가운데 정렬 transform과 motion 라이브러리의 transform이 같은 속성을 덮지 않게 wrapper를 나누거나 layout offset을 명시적으로 포함한다.
- 회전·확대의 `transformOrigin`은 각 요소의 값이다. 바깥 요소 하나에만 지정하지 않는다.

## SVG 경로 애니메이션

정적 자산은 디자인 구현 규칙대로 로컬에 보관한다. SVG 내부 path를 움직여야 할 때는 이미지 태그 안에 숨겨 둔 채 path를 조작할 수 있다고 가정하지 않는다. 해당 자산을 읽어 실제 path에 animation을 적용하고 원래의 wrapper와 path 관계를 보존한다.

이 예외는 일반적인 정적 자산을 다시 그리라는 뜻이 아니다. 애니메이션에 필요한 path만 다루고 디자인에서 사용한 자산과 기하 구조를 유지한다. asset URL을 읽는 도구는 SVG를 지원하는 텍스트·네트워크 경로를 사용한다.

## 시간과 대체 구현

`HOLD` 같은 불연속 easing을 linear로 바꾸지 않는다. 스니펫이 없을 때만 keyframe·summary·cohort의 시간과 반복 정보를 조합한다. 서로 다른 API의 ms·초 단위를 확인한다. 특정 효과를 구현할 수 없으면 도구가 제공한 fallback과 시각적 차이를 확인하며 임의의 움직임을 추가하지 않는다.

세부 사례는 [공식 예제](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-implement-motion/references/examples-and-anti-examples.md), [SVG 처리](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-implement-motion/references/svg-and-path-motion.md), [지원 범위](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-implement-motion/references/unsupported-and-fallbacks.md)의 해당 부분을 읽는다.
