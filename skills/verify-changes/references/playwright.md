# Playwright 검증 설정

설치된 Playwright 버전과 기존 설정을 먼저 확인한다. 아래는 필요한 설정을 보여주는 예시이며 기존 프로젝트·인증·webServer·reporter 설정을 통째로 교체하지 않는다. 임시 설정을 사용하면 기존 설정을 바탕으로 필요한 필드만 조정하고, 사용자 프로필이나 인증 파일을 결과물에 포함하지 않는다.

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  workers: 1,
  use: {
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
    video: 'off',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
});
```

`video: 'off'`는 테스트 화면 녹화를 끄는 옵션이며 페이지의 동영상 재생을 차단하지 않는다. 실패 스크린샷 설정은 디자인 확인용 캡처를 대신하지 않는다. 프로젝트별 `use`가 전역 설정을 덮어쓸 수 있으므로 실행할 프로젝트의 실제 값을 확인한다. 사용자 지정 launch 플래그로 GPU나 브라우저 보호 기능을 무작정 끄지 않는다.

## 필요한 화면 캡처

테스트에서 대상 페이지로 이동하고 관련 상호작용과 화면 준비 조건을 충족한 뒤 촬영한다. `SCREENSHOT_PATH`는 이번 실행의 고유 임시 파일 경로다.

```ts
await page.screenshot({
  path: SCREENSHOT_PATH,
  fullPage: true,
});
```

캡처 이미지는 실제로 열어 기준 자료와 대조한다. 비교할 영역과 상태에 따라 전체 화면 또는 요소 캡처를 선택한다. 필요한 viewport는 요구사항에서 정하고 브라우저 크기를 줄여 레이아웃 검증을 왜곡하지 않는다.

승인된 기준 이미지가 이미 있는 Playwright Test에서는:

```ts
await expect(page).toHaveScreenshot('expected-page.png');
```

이는 예시 이름이다. 기존 테스트의 실제 snapshot과 조건을 사용한다. `--update-snapshots`로 현재 화면을 새 기대값으로 덮어쓰고 검증을 통과시키지 않는다. 디자인 시안과의 의미 있는 일치 판단은 픽셀 비교 통과만으로 대체되지 않는다.

## 실행과 종료

```bash
# 실제 존재하며 Chrome channel을 사용하는 프로젝트를 선택
pnpm exec playwright test "$TEST_FILE" --project="$CHROME_PROJECT" --workers=1
# 임시 설정이 필요한 경우
pnpm exec playwright test --config="$TEMP_CONFIG" --workers=1
```

테스트 파일 인자는 러너의 필터 규칙에 따라 매칭되므로 실제 실행된 테스트 목록·개수를 확인한다. 불필요한 프로젝트는 실행하지 않되 저장소의 필수 검증은 유지한다. 재시도 횟수를 늘려 실패를 감추지 않는다.

Playwright Test의 fixture 정리를 사용한다. 직접 작성한 임시 스크립트에서는 `try/finally`로 context와 브라우저를 닫고 자신이 시작한 서버만 종료한다. 종료 후 본문의 기준에 따라 임시 캡처·설정을 정리한다. headless와 단일 worker는 자원 사용을 줄이기 위한 기본값이며 실제 메모리 상한이나 특정 절감률을 보장하지 않는다.

## 공식 문서

- [브라우저와 Chrome channel](https://playwright.dev/docs/browsers)
- [병렬 실행](https://playwright.dev/docs/test-parallel)
- [실행 옵션](https://playwright.dev/docs/api/class-testoptions)
- [스크린샷](https://playwright.dev/docs/screenshots)
- [시각적 비교](https://playwright.dev/docs/test-snapshots)
