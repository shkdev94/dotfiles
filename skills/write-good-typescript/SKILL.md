---
name: write-good-typescript
description: TypeScript의 언어 기능과 타입 시스템을 적절히 활용해 읽기 쉽고 유지보수하기 좋은 코드를 작성·수정·리뷰하기 위한 지침이다. 판별 가능한 유니온의 처리 누락을 컴파일 타임에 찾는 exhaustive check 등 TypeScript에 특화된 구현 판단이 필요한 작업에 사용한다.
---

# 좋은 TypeScript 작성

TypeScript를 활용하여 읽기 쉬우며 유지보수하기 좋은 코드를 작성한다.

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
