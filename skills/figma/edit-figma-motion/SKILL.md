---
name: edit-figma-motion
description: Figma 파일 안에서 노드의 keyframe·animation style·easing·timeline을 만들거나 수정할 때 사용한다. use_figma의 Motion API를 다루며, 애플리케이션 코드로 애니메이션을 구현하는 요청은 implement-figma-motion을 사용한다.
---

# Figma 애니메이션 편집

## 목표와 역할

대상 노드에 의도한 시간·순서·완급의 애니메이션을 적용하고 검증한다. 결과는 편집 가능한 트랙·스타일과 변경한 노드 ID다.

## 준비와 지원 범위

[use-figma](../use-figma/SKILL.md)를 함께 읽고 기존 노드와 motion 상태를 확인한다. Motion API는 계정 기능에 따라 제공되지 않을 수 있다. 지원되지 않는 API라는 오류가 나면 반복 호출하거나 우회하지 말고 사용할 수 없는 기능을 알린다.

대상은 페이지 직속 최상위 프레임의 하위 노드다. 최상위 프레임 자체를 애니메이션 대상으로 삼지 않는다. 커스텀 `figma:motion` preset 소스 작성과 공개된 기존 animation style의 적용을 구분한다.

## 편집 절차

1. 기존 `manualKeyframeTracks`, `animationStyles`, 타임라인을 읽고 바꿀 속성과 시간 범위를 정한다.
2. 수동 트랙은 `applyManualKeyframeTrack()`·`removeManualKeyframeTrack()`, 스타일은 조회한 ID와 `applyAnimationStyle()`·`removeAnimationStyle()`로 다룬다. 스타일 제거에는 적용된 인스턴스의 실제 ID를 쓴다.
3. 시간은 공개 Plugin API의 초 단위를 따른다. `setTimelineDuration()`으로 필요한 길이를 설정하고 요청 없이 기존 타임라인을 줄이지 않는다.
4. `TRANSLATION_X`, `ROTATION`, `SCALE_X` 같은 공개 필드와 easing enum을 타입 정의에서 확인한다. 예를 들어 `EASE_IN_AND_OUT`을 임의의 `EASE_IN_OUT`으로 바꾸지 않는다.
5. 변경한 모든 노드 ID를 반환하고 트랙·지속 시간·적용 스타일을 다시 확인한다.

키프레임 작성 전 [공식 motion 패턴](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-use-motion/references/motion-patterns.md)을 읽고, easing을 수정할 때는 [easing 계약](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-use-motion/references/motion-easing.md)을 확인한다.

## 움직임 검증

`get_screenshot`은 정지 상태이므로 애니메이션 검증을 대신하지 않는다. 시간·순서가 불명확하면 최상위 프레임을 `export_video`로 내보내 주요 시점의 프레임을 비교한다. 한 번의 내보내기에서 필요한 시점을 함께 확인하도록 해상도·fps를 정한다.

응답이 처리 중이면 반환된 `jobId`로 상태를 조회하고, 매번 새 작업을 만들지 않는다. 단순한 변경이거나 프레임 추출 도구가 없어 영상을 확인하지 못했다면 실제 검증한 범위를 구분해 보고한다.

출처: [Figma의 figma-use-motion 원본](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-use-motion/SKILL.md).
