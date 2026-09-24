---
name: create-figma-shader
description: Figma의 shader effect나 procedural fill을 MCP의 create_shader 또는 update_shader로 만들거나 수정할 때 사용한다. 현재 소스·shader 종류·런타임 계약을 확인하며, 기존 shader를 단순 조회하거나 적용하는 작업과 구분한다.
---

# Figma shader 작성

## 목표와 역할

사용자가 조절할 수 있는 속성과 요청한 시각 효과를 가진 Figma shader를 만든다. 결과는 저장된 shader ID, 종류·컨트롤과 시험 링크다.

## 종류와 현재 소스

- `effect`는 아래 레이어의 래스터를 입력으로 변형한다. `fill`은 입력 래스터 없이 픽셀을 생성한다.
- 수정 시 `get_shader`의 기존 `type`과 같은 `kind`를 사용한다. 종류를 임의로 바꾸지 않는다.
- 새 자산의 `planKey`는 기존 지시 또는 `whoami` 결과에서 정한다. 여러 대상 중 근거가 없을 때만 확인한다.

## 생성과 수정

1. 새 shader는 `create_shader`로 만들고 반환된 ID로 `get_shader`를 호출한다. 기본 예제가 만들어진 것만으로 완료하지 않는다.
2. 반환된 모든 소스 URI를 읽는다. MCP 리소스를 읽을 수 없으면 `includeSource: true`로 조회한다.
3. [공식 작성 계약](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-shaders/references/authoring.md)을 읽어 module 형태, WebGPU 수명주기, 속성 schema와 alpha 처리를 확인한다.
4. `main.ts`의 완전한 대체 내용을 작성하고 같은 `kind`로 `update_shader`에 전달한다. 이름·설명만 바꾸는 경우에만 빈 `files`를 사용한다.
5. 소스가 시간 입력을 쓰면 `metadata.isAnimated`, 마우스 위치를 쓰면 `metadata.usesMouse`를 맞춘다. 마지막 사용을 제거하면 해당 값을 다시 `false`로 바꾼다. `features.json`을 직접 교체하지 않는다.

## 동작과 검증

- 시간 기반 효과에는 절대 시간인 `frame.time`을 검토한다. 밀리초를 초로 쓸 때 변환하고 건너뛴 프레임 수에 따라 결과가 달라지지 않게 한다.
- 레이어마다 조절할 값은 bounded control로 노출하고, `fill`에서 입력 래스터가 있다고 가정하지 않는다.
- 빌드 오류는 원인에 맞춰 최소 수정 후 한 번 재시도한다. animation·mouse 기능이 제공되지 않는다는 오류는 반복 우회하지 않는다. 정적 대안이 요청을 충족할지 설명한다.
- 저장 성공과 실제 렌더링 확인을 구분한다. 반환된 버전만 기록하고 이름·종류·ID와 컨트롤을 보고한다.

시험 링크는 `https://www.figma.com/file/new`에 실제 ID를 `try-tool-resource-content-id`로 넣고, `try-tool-resource-type`은 effect일 때 `gen_effect`, fill일 때 `gen_fill`을 사용한다. `type=design`, `mode=design`도 포함한다. 기존 파일 링크는 사용자가 제공한 URL을 사용한다.

출처: [Figma의 figma-shaders 원본](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-shaders/SKILL.md).
