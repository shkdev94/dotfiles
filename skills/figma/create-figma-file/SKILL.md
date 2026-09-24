---
name: create-figma-file
description: Figma Design, FigJam, Slides 파일을 새로 만들 때 사용한다. create_new_file 호출 전에 대상 제품과 저장할 플랜을 확인하며, 기존 파일 편집이나 다이어그램 자동 생성만으로 새 파일을 추가하지 않는다.
---

# Figma 파일 생성

## 목표와 역할

사용자가 요청한 종류의 빈 Figma 파일을 만들고 파일 링크와 키를 후속 작업에 전달한다. 캔버스 내용 작성은 해당 작업 스킬이 담당한다.

## 생성 절차

1. 요청에서 Design·FigJam·Slides 중 제품을 정한다. 종류가 모호해 결과가 달라질 때만 확인한다.
2. 사용자가 지정한 `planKey`가 있으면 사용한다. 없으면 `whoami`의 플랜 목록을 조회한다. 사용할 플랜이 하나면 선택하고, 여러 플랜 중 저장 위치가 정해지지 않았다면 사용자에게 선택을 요청한다.
3. 도구 스키마에 맞춰 `create_new_file`을 호출한다. 이름이 없으면 작업을 나타내는 짧은 이름을 사용한다.
4. 응답의 실제 `file_key`와 링크를 기록한다. 이름이나 URL에서 임의의 키를 만들어 쓰지 않는다.

Slides의 새 그리드는 비어 있을 수 있다. `getSlideGrid()`의 첫 요소를 읽기 전에 확인하고, 필요한 경우 `createSlide()`로 첫 슬라이드를 만든다.

`generate_diagram`은 새 파일을 직접 만들 수 있으므로 다이어그램 생성에 앞서 빈 파일을 불필요하게 만들지 않는다. 재시도 전에 생성 결과를 확인해 같은 파일을 중복 생성하지 않는다.

## 후속 작업

캔버스에 쓸 때는 [use-figma](../use-figma/SKILL.md)를 읽고 반환된 파일 키를 사용한다. 파일 생성과 내용 작성의 완료 여부를 구분해 보고한다.

출처: [Figma의 figma-create-new-file 원본](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-create-new-file/SKILL.md).
