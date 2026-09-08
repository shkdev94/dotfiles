# UI 컴포넌트와 훅 테스트

React에서는 기존 React Testing Library(RTL) 환경을 우선 사용한다. 아래 API는 설치된 버전과 설정을 확인해 적용한다.

## 사용자 관점과 대상 선정

- 사용자가 보는 내용과 수행하는 행동을 재현한다. 컴포넌트 인스턴스나 내부 state, CSS 클래스, DOM 중첩 구조를 구현 검증의 기본 대상으로 삼지 않는다.
- 권한에 따른 UI, 로딩·오류·빈 상태, 폼 검증과 제출, 사용자 상호작용에 따른 변화처럼 실패 영향이 있는 동작을 우선한다.
- 단순 프레젠테이셔널 컴포넌트에는 관성적으로 렌더 테스트나 스냅샷을 만들지 않는다. 스냅샷은 작고 의도가 명확하며 실제로 검토 가능한 경우에만 쓴다.
- 자식 컴포넌트를 모두 모킹하지 않는다. 관련 컴포넌트를 함께 렌더해 실제 사용자 흐름을 검증하고, 무거운 외부 경계처럼 필요한 대상만 대체한다.

## 쿼리와 사용자 입력

- 역할과 접근 가능한 이름을 사용하는 `getByRole`을 우선하고, 입력에는 `getByLabelText`, 일반 내용에는 `getByText` 등 사용자에게 드러나는 의미를 사용한다. 이미지 대체 텍스트나 현재 입력값처럼 대상에 적합한 의미 기반 쿼리도 사용한다.
- `getByTestId`는 적절한 의미 기반 쿼리가 없을 때 마지막 수단으로 사용한다. 중복 요소는 `within`으로 의미 있는 영역을 좁힌다. 테스트를 통과시키기 위해 부정확한 role을 추가하지 않는다.
- 지금 있어야 하는 요소는 `getBy`, 비동기로 나타나는 요소는 `findBy`, 없는 요소의 검증은 `queryBy`를 사용한다. 의미 기반 쿼리를 사용했다고 접근성 전체를 검증한 것은 아니다.
- 사용자 상호작용은 `userEvent.setup()`으로 테스트별 세션을 만들고 `await user.click`, `await user.type` 등을 사용한다. 지원되는 일반 동작을 `fireEvent`로 대체하지 않는다.
- `userEvent`가 지원하지 않는 저수준 이벤트를 검증해야 할 때만 이유가 명확한 `fireEvent`를 사용한다. `userEvent`가 실제 브라우저의 모든 동작을 완전히 재현한다고 가정하지 않는다.

다음은 준비 헬퍼와 컴포넌트가 있는 저장소에서의 구조 예시다.

```tsx
test('메뉴 열기 버튼을 클릭하면 메뉴 대화상자가 표시된다', async () => {
  const user = userEvent.setup();
  renderWithProviders(<Menu />);

  await user.click(screen.getByRole('button', { name: '메뉴 열기' }));

  expect(screen.getByRole('dialog')).toBeVisible();
});
```

## 비동기와 act

- 임의의 `setTimeout` 대기로 렌더 완료를 추측하지 않는다. 나타남은 `findBy`, 사라짐은 조건에 맞는 `waitForElementToBeRemoved` 또는 `waitFor`로 기다린다.
- `waitFor` 콜백에는 재시도 가능한 assertion 하나만 둔다. 클릭·입력·렌더·요청 같은 부수효과를 넣지 않는다. 추가적인 동기 검증은 대기 이후에 수행한다.
- `act` 경고를 숨기지 않는다. 누락된 await, 종료되지 않은 요청·타이머·구독을 먼저 확인한다. RTL이 감싸는 동작에 불필요한 `act`를 추가하지 않는다.
- 직접 훅의 상태 변경 API를 호출하거나 타이머를 전진시키는 등 React 업데이트를 테스트에서 직접 유발할 때는 필요한 `act`를 사용한다. 모든 경고를 `waitFor`로 해결하려 하지 않는다.
- fake timer와 userEvent를 함께 쓰면 설치 버전에 맞는 `advanceTimers` 설정을 사용한다. 타임아웃을 피하려고 의미 없이 지연을 제거하지 않는다.

## 네트워크와 providers

- HTTP가 관여하는 UI 테스트는 MSW로 네트워크 경계를 대체하는 것을 우선한다. `fetch`·axios·React Query 훅을 직접 모킹해 데이터 흐름을 제거하지 않는다. HTTP 클라이언트 자체가 테스트 대상인 경우에는 해당 경계의 계약에 맞게 판단한다.
- 기존 MSW 버전과 서버 설정을 재사용한다. 기본 핸들러는 정상 응답으로 두고 실패·빈 결과 등은 해당 테스트의 `server.use()`로 재정의한다.
- 각 테스트 후 `server.resetHandlers()`로 런타임 재정의를 정리하고, 테스트 종료 시 서버를 닫는다. 기존 전역 설정이 이미 수행하면 중복 등록하지 않는다.
- 예상하지 않은 실제 외부 요청이 나가지 않도록 미처리 요청을 감지한다. 서버 핸들러 재설정과 별개로 핸들러가 참조하는 가변 데이터도 격리한다.
- 반복 렌더 설정은 `renderWithProviders` 같은 헬퍼로 통합한다. QueryClient·스토어·라우터 상태는 테스트마다 새로 생성하고 정리한다. 요청 재시도나 캐시가 테스트 간 누출되거나 불필요하게 대기를 늘리지 않도록 설정한다.
- provider 헬퍼는 실제 환경과 관련된 동작을 보존한다. 검증하려는 권한·캐시·재시도 계약을 무조건 비활성화하지 않는다.

## 커스텀 훅과 브라우저 경계

- 독립적이고 재사용 가능한 로직의 훅은 `renderHook`으로 공개 반환값과 상태 전이를 검증한다. 얇은 UI 연결 훅은 컴포넌트 테스트와 중복되지 않는지 먼저 판단한다.
- 훅의 내부 상태 구조나 특정 데이터 라이브러리 호출을 검사하지 않는다. 공개된 동작과 결과를 확인한다.
- DOM 테스트 환경은 실제 레이아웃·페인팅·브라우저 API와 차이가 있다. 화면 배치와 실제 브라우저 통합이 중요한 시나리오는 E2E·브라우저·시각 검증 대상으로 구분한다.

## API 확인이 필요할 때

- [쿼리 선택](https://testing-library.com/docs/queries/about/)
- [userEvent](https://testing-library.com/docs/user-event/intro/)
- [타이머 옵션](https://testing-library.com/docs/user-event/options/)
- [비동기 API](https://testing-library.com/docs/dom-testing-library/api-async/)
- [MSW 문서](https://mswjs.io/docs/)
