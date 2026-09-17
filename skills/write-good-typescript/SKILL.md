---
name: write-good-typescript
description: TypeScript의 언어 기능과 타입 시스템을 적절히 활용해 읽기 쉽고 유지보수하기 좋은 코드를 작성·수정·리뷰하기 위한 지침이다.
---

# 좋은 TypeScript 작성

TypeScript를 활용하여 읽기 쉬우며 유지보수하기 좋은 코드를 작성한다.

## `any` 사용 최소화하기

구체적인 타입을 표현할 수 있다면 `any`를 사용하지 않는다. `any`는 해당 값에 대한 타입 검사를 비활성화하며, 잘못된 프로퍼티 접근이나 함수 호출도 컴파일 오류 없이 허용한다.

값의 타입을 아직 알 수 없다면 `any` 대신 `unknown`으로 받고, 사용하기 전에 타입 가드나 검증 로직으로 타입을 좁힌다.

```ts
function getLength(value: unknown): number {
  if (typeof value === "string" || Array.isArray(value)) {
    return value.length;
  }

  throw new TypeError("Expected a string or an array");
}
```

JavaScript에서 TypeScript로 점진적으로 마이그레이션하거나 서드파티 라이브러리의 타입이 제공되지 않는 등 `any` 사용이 불가피하다면 가능한 한 좁은 경계에 격리하고, 내부 코드와 공개 인터페이스로 전파되지 않게 한다.

## 타입 선언의 기본 선택

저장소에 별도의 규칙이 없다면 객체 타입을 포함한 새로운 타입 선언에는 `type` alias를 기본으로 사용한다. `type`은 객체뿐 아니라 유니온, 튜플, 교차 타입 등을 표현할 수 있어 타입 선언의 일관성을 유지하기 좋다.

```ts
type User = {
  id: string;
  name: string;
};

type Result<T> =
  | { success: true; value: T }
  | { success: false; error: Error };
```

기존 선언을 다시 열어 확장해야 하는 declaration merging이나 module augmentation에는 `interface`를 사용한다. 기존 코드가 `interface`를 일관되게 사용하고 있다면 선호만을 이유로 `type`으로 변경하지 않고 저장소의 관례를 따른다.

## `satisfies`와 `as` 선택하기

직접 선언하는 값이 특정 타입의 조건을 만족하는지 검사하면서 값의 구체적인 추론 타입을 유지하려면 `satisfies`를 사용한다.

```ts
type Config = {
  mode: "development" | "production";
  port: number;
};

const config = {
  mode: "production",
  port: 3000,
} satisfies Config;
```

값이 특정 타입이라는 사실을 컴파일러보다 개발자가 더 잘 알고 있고, 그 사실이 외부 계약으로 보장될 때는 `as`를 사용한다. `as`는 타입을 검사하지 않으므로 타입 오류를 없애기 위한 목적으로 사용하지 않는다.

```ts
// 정적 HTML에서 해당 id의 요소가 canvas임을 보장한다.
const canvas = document.getElementById("main-canvas") as HTMLCanvasElement;
const context = canvas.getContext("2d");
```

값의 타입을 런타임에 보장할 수 없다면 `as`로 단언하지 않고 타입 가드나 검증 로직으로 확인한다.

## Exhaustive Check

유니온 타입에 새로운 케이스가 추가됐을 때 기존 분기문의 처리 누락을 런타임 이전인 컴파일 타임에 발견할 수 있도록 `never` 기반 exhaustive check를 사용한다.

`never`는 가능한 값이 없는 타입이다. TypeScript의 control flow analysis는 `switch`의 각 분기를 거치며 유니온 타입을 좁힌다. 모든 케이스를 처리했다면 `default`에 도달한 값의 타입은 `never`가 된다.

```ts
type PaymentMethod =
  | { type: "card"; cardNumber: string }
  | { type: "bank"; accountNumber: string };

function getPaymentInfo(method: PaymentMethod): string {
  switch (method.type) {
    case "card":
      return `카드: ${method.cardNumber}`;
    case "bank":
      return `계좌: ${method.accountNumber}`;
    default: {
      const _: never = method;
      throw new Error("Unknown payment method");
    }
  }
}
```

다음과 같이 `crypto` 케이스를 추가하고 `switch`에 해당 분기를 추가하지 않으면 `default`에서 `method`를 `never`에 할당할 수 없으므로 컴파일 오류가 발생한다.

```ts
type PaymentMethod =
  | { type: "card"; cardNumber: string }
  | { type: "bank"; accountNumber: string }
  | { type: "crypto"; walletAddress: string };
```
