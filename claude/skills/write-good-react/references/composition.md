# 컴포넌트 합성과 상태 계약

컴포넌트의 변형, 공개 API 또는 공유 상태의 경계를 바꿀 때 적용한다.

## 변형을 표현하는 방법

- boolean 조합마다 서로 다른 흐름과 필수 props가 생기면 허용되는 변형을 먼저 정리한다. 서로 배타적인 값은 구별된 유니온으로 표현하거나 목적별 컴포넌트로 나눈다.
- 단순한 상태 차이는 기존 props로 유지한다. 패턴을 적용하기 위해 호출자가 알아야 할 컴포넌트와 설정을 늘리지 않는다.
- 구조를 호출자가 선택하면 `children`이나 명명된 React node 슬롯을 사용한다. 부모가 계산한 항목·상태를 자식 렌더링에 전달해야 하면 `renderItem` 같은 render prop도 적절하다.
- 같은 책임의 복잡한 UI를 독립적인 부분으로 조합해야 할 때 compound component를 검토한다. 부분마다 공유할 계약이 없으면 단순한 컴포넌트 합성으로 충분하다.

예를 들어 새 작성과 수정에 필요한 값이 다르면 불가능한 조합을 타입에서 제외한다.

```tsx
type EditorProps =
  | { mode: "create"; onCreate: (body: string) => void }
  | { mode: "edit"; initialBody: string; onSave: (body: string) => void };
```

타입이 구별돼도 한 컴포넌트의 책임이 과도하면 작성·수정 화면을 나누고 실제로 같은 입력 UI만 공유한다. 같은 모양이라는 이유로 다른 업무 정책을 하나로 묶지 않는다.

## 상태의 소유자와 소비자

- 상태가 필요한 형제 컴포넌트들의 가까운 공통 부모가 소유하도록 한다. 공유할 필요가 없는 입력·포커스 상태까지 앱 전역으로 올리지 않는다.
- UI의 위치와 provider의 경계는 다를 수 있다. 별도 툴바나 미리보기도 같은 상태를 사용한다면 필요한 공통 조상에 provider를 배치한다.
- 여러 상태 구현을 실제로 교체해야 하는 경우 소비자는 필요한 값과 행동의 계약에 의존하고, provider가 데이터 조회·저장 구현을 맡는다. 모든 context에 `state/actions/meta` 구조를 강제하지 않는다.
- 공개 행동은 `submit`, `selectItem`처럼 목적을 표현한다. 호출자가 내부 상태 전체를 직접 변경해야만 사용할 수 있는 API인지 검토한다.
- provider가 필수인 컴포넌트는 누락을 식별 가능한 오류로 알린다. 실제로 선택적인 provider에만 의미 있는 기본값을 둔다.
- context 값이 바뀌면 구독자가 갱신된다. `memo`만으로 context 변경을 차단하려 하지 않는다. 소비 범위·변경 빈도를 확인하고 필요한 경우 context 분리나 기존 store의 selector를 사용한다.

## 버전과 호환성

- React 19 이상에서는 `ref`를 prop으로 받을 수 있지만, React 18 호환 라이브러리나 기존 API의 조건을 먼저 확인한다.
- `useContext`는 계속 지원되는 API다. `use`가 존재한다는 이유로 일괄 교체하지 않는다. 조건부 context 읽기 등 실제 필요와 지원 버전이 있을 때 선택한다.
- 합성 구조를 바꾸면서 DOM 구조·접근 가능한 이름·포커스·ref 전달·폼 제출 동작이 달라지는지 확인한다. 공개 API가 바뀌면 실제 호출자도 함께 반영한다.

참고 자료: [Vercel Composition Patterns](https://github.com/vercel-labs/agent-skills/tree/main/skills/composition-patterns), [React useContext](https://react.dev/reference/react/useContext), [React forwardRef](https://react.dev/reference/react/forwardRef).
