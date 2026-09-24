---
name: implement-figma-motion
description: Figma의 애니메이션을 애플리케이션 코드로 구현할 때 사용한다. get_motion_context의 시간·keyframe·easing을 디자인 노드와 대응시켜 기존 프로젝트의 motion 방식으로 옮기며, Figma 캔버스 자체의 편집과 구분한다.
---

# Figma 애니메이션 구현

## 목표와 역할

Figma에 정의된 움직임을 실제 앱의 구조와 상호작용에 통합한다. 결과는 프로젝트의 기존 라이브러리·접근성 설정을 따르는 애니메이션 코드와 재생 검증 결과다.

## 두 컨텍스트의 결합

1. [implement-figma-design](../implement-figma-design/SKILL.md)으로 정적 구조·자산·스크린샷을 확보한다.
2. `get_motion_context`에서 애니메이션 노드, `codeSnippets`, `keyframeBindings`와 `timelineCohorts`를 읽는다. 이 응답이 움직이는 노드와 시간 정보의 근거다.
3. 디자인의 `data-node-id`와 motion의 `nodeId`를 정확히 대응시킨다. 정확한 ID가 없을 때만 응답의 `fallbackNodeId`를 검토한다.
4. 노드별 시간·값·easing·`transformOrigin`을 보존한다. 스니펫이 있으면 불필요하게 keyframe에서 다시 계산하지 않는다. 없는 노드에 움직임을 추측해 추가하지 않는다.

## 프로젝트에 적용

- 기존 컴포넌트의 motion import와 주변 구현을 먼저 읽는다. 이미 사용하는 라이브러리로 옮기며 의존성을 임의로 교체하지 않는다.
- 적절한 기존 방식이 없으면 React에서는 응답의 motion 코드, 일반 웹에서는 CSS keyframes를 검토한다. SwiftUI는 실제 지원 API로 값을 옮긴다.
- 같은 패턴은 하나의 컴포넌트나 parameterized transition으로 재사용한다. 값의 정확성을 유지하면서 코드 중복을 줄인다.
- `prefers-reduced-motion` 또는 플랫폼의 해당 접근성 설정에서 움직임을 줄이거나 해제한다.
- 정적 transform과 애니메이션 transform이 함께 있는 경우 [transform과 SVG 규칙](references/transforms-and-svg.md)을 읽는다.

## 검증

대표 애니메이션 하나를 처음부터 끝까지 실제로 재생해 등장 순서·반복·easing·기준점을 확인한 뒤 다른 노드에 적용한다. 정지 화면이 표시되는 것만으로 재생이 맞다고 보고하지 않는다. 지원하지 않는 기능이나 근사한 부분은 정확히 구분한다.

출처: [Figma의 figma-implement-motion 원본](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-implement-motion/SKILL.md).
