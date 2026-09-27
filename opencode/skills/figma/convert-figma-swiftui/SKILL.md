---
name: convert-figma-swiftui
description: Figma 디자인을 SwiftUI로 구현하거나 SwiftUI 화면·토큰을 Figma로 옮길 때 사용한다. 변환 방향에 맞는 공통 스킬과 iOS의 의미 기반 색상·SF Symbols·시스템 UI 규칙을 적용한다. 일반 Swift나 iOS 질문만으로 사용하지 않는다.
---

# Figma와 SwiftUI 변환

## 목표와 역할

디자인과 SwiftUI 사이에서 시각적 의도·시스템 컴포넌트·토큰의 대응을 유지한다. 결과는 요청한 방향에 따라 앱 코드 또는 편집 가능한 Figma 화면이다.

## 변환 방향

| 요청 | 함께 적용할 스킬 |
| --- | --- |
| Figma 화면을 SwiftUI로 구현 | [implement-figma-design](../implement-figma-design/SKILL.md) |
| SwiftUI 화면을 Figma에 구성 | [use-figma](../use-figma/SKILL.md), [build-figma-design](../build-figma-design/SKILL.md) |
| SwiftUI 토큰·컴포넌트를 라이브러리로 구성 | [build-figma-library](../build-figma-library/SKILL.md) |

파일이나 링크만 있고 방향이 정해지지 않았다면 두 방향 중 필요한 결과를 확인한다. 두 작업을 동시에 수행한다고 추정하지 않는다.

## 공통 변환 기준

- `get_design_context`를 읽을 때 스키마에 맞춰 Swift와 SwiftUI를 지정한다. 반환된 React·Tailwind 표현은 구조 자료이며 절대 좌표·혼합 효과를 그대로 옮기는 목표가 아니다.
- 큰 제목과 뒤로 가기, 탭, 반복 목록은 각각 `NavigationStack`, `TabView`, `List` 같은 시스템 패턴과 대응시킨다. 단순 도형으로 운영체제 UI를 다시 만들지 않는다.
- 의미 기반 색상은 `Color(.systemBackground)`, `Color.secondary` 등과 디자인 변수의 의미를 연결한다. 동적 색상을 하나의 RGBA로 고정하지 않는다.
- SF Symbols는 이름으로 대응시킨다. Figma에서 코드로 옮길 때 반환된 `Image(systemName: ...)`의 이름을 유지한다. 반대 방향에서는 `figma.util.getSfSymbolCharacter(name)`을 사용하고 codepoint를 추측하지 않는다.
- 화면 방향·크기, safe area와 동적 글꼴에서 배치가 맞는지 확인한다. 시각적 참조와 실제 플랫폼 동작을 함께 검증한다.

방향별 세부 변환이 필요하면 공식 [디자인에서 코드로](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-swiftui/references/design-to-code.md) 또는 [코드에서 디자인으로](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-swiftui/references/code-to-design.md) 중 해당 문서를 읽는다. 실제 SDK에 없는 modifier를 만들어 쓰지 않는다.

출처: [Figma의 figma-swiftui 원본](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-swiftui/SKILL.md).
