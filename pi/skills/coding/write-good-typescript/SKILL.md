---
name: write-good-typescript
description: TypeScript의 언어 기능과 타입 시스템을 적절히 활용해 읽기 쉽고 유지보수하기 좋은 코드를 작성·수정·리뷰하기 위한 지침이다.
---

# 좋은 TypeScript 작성

## 목표와 역할

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

## 객체 타입을 구체적으로 표현하기

임의의 객체를 나타내기 위해 `Object`나 `{}`를 사용하지 않는다. 두 타입은 문자열과 숫자 같은 원시값도 허용하므로 객체의 키와 값에 관한 계약을 표현하지 못한다.

키는 문자열이지만 값의 타입을 아직 알 수 없는 객체라면 `Record<string, unknown>`을 사용하고, 프로퍼티를 사용하기 전에 타입을 좁힌다.

```ts
function getDisplayName(metadata: Record<string, unknown>): string | undefined {
  const displayName = metadata["displayName"];

  return typeof displayName === "string" ? displayName : undefined;
}
```

프로퍼티 구조를 알고 있다면 `Record<string, unknown>`보다 필요한 프로퍼티를 명시한 타입을 정의한다.

`object`도 사용하지 않는다. `object`는 원시값만 제외할 뿐 어떤 프로퍼티가 있는지 표현하지 못한다. `WeakMap`의 키처럼 객체의 참조만 필요한 경우에도 실제로 다루는 타입을 사용한다.

```ts
const sessionCache = new WeakMap<User, Session>();
```

## 타입 선언의 기본 선택

저장소에 별도의 규칙이 없다면 객체 타입은 `interface`로 선언한다. 유니온, 튜플, 함수 타입, mapped·conditional 타입처럼 `interface`로 표현할 수 없는 타입에만 `type` alias를 사용한다.

```ts
interface User {
  id: string;
  name: string;
}

type Result<T> =
  | { success: true; value: T }
  | { success: false; error: Error };
```

객체 타입을 확장할 때는 `&` 대신 `interface`의 `extends`를 사용한다. `extends`는 충돌하는 프로퍼티를 오류로 알려 주지만, `&`는 충돌한 프로퍼티를 조용히 `never`로 만든다. 타입 매개변수나 유니온처럼 `interface`가 확장할 수 없는 타입에만 `&`를 사용한다.

```ts
interface Admin extends User {
  level: number;
}

type WithId<T> = T & { id: string };
```

같은 범위에서 하나의 이름을 두 번 선언하지 않는다. 같은 이름의 `interface`는 자동으로 병합되어 멤버가 여러 곳에 흩어지고, 타입과 값이 같은 이름을 쓰면 식별자가 무엇을 가리키는지 알기 어렵다. 스키마와 추론 타입처럼 짝을 이루는 값과 타입에도 서로 다른 이름을 사용한다.

```ts
const userSchema = z.object({ id: z.string() });
type User = z.infer<typeof userSchema>;
```

declaration merging은 `declare global`이나 `declare module`로 외부 선언을 확장하는 module augmentation에만 사용한다. 기존 코드가 `type`을 일관되게 사용하고 있다면 선호만을 이유로 `interface`로 변경하지 않고 저장소의 관례를 따른다.

## 조건 분기 선택하기

함수의 나머지 로직을 진행할 수 없는 조건, 유효하지 않은 입력, 예외적인 상태는 guard clause와 early return으로 먼저 처리한다. 조건을 만족하지 않는 경로를 일찍 종료해 정상 흐름의 중첩을 줄이고, 앞선 분기가 항상 반환하거나 예외를 던진다면 불필요한 `else`를 사용하지 않는다.

```ts
interface DiscountUser {
  isPremium: boolean;
}

function calculateDiscount(user: DiscountUser, amount: number): number {
  if (!user.isPremium) {
    return 0;
  }
  if (amount < 100) {
    return 0;
  }

  return amount * 0.1;
}
```

하나의 판별값에 따라 여러 개의 상호 배타적인 경로 중 하나를 선택한다면 연속된 `if`/`else if`보다 `switch`를 사용한다. 리터럴 유니온이나 판별 가능한 유니온을 분기할 때 각 케이스의 의도와 처리 범위를 한곳에서 확인하기 좋고, exhaustive check와 함께 처리 누락도 검사할 수 있다.

```ts
type UserRole = "admin" | "member" | "guest";

function getRoleLabel(role: UserRole): string {
  switch (role) {
    case "admin":
      return "관리자";
    case "member":
      return "회원";
    case "guest":
      return "게스트";
    default: {
      const _: never = role;
      return _;
    }
  }
}
```

서로 다른 조건식이나 범위 검사처럼 하나의 판별값으로 설명할 수 없는 분기는 guard clause나 `if`를 사용한다. 같은 판별값을 기준으로 한 `switch`가 여러 곳에서 반복된다면 분기를 무조건 제거하기보다 동작의 변경 이유와 확장 가능성을 확인하고, 필요할 때 전략 객체나 다형성으로 책임을 분리한다. Factory처럼 구현 선택을 한곳에 모으는 코드에서는 `switch`가 자연스러운 선택일 수 있다.

## `satisfies`와 `as` 선택하기

직접 선언하는 값이 특정 타입의 조건을 만족하는지 검사하면서 값의 구체적인 추론 타입을 유지하려면 `satisfies`를 사용한다. 객체 리터럴에 `as Config`처럼 단언하면 누락된 프로퍼티도 검사하지 않으므로 사용하지 않는다.

```ts
interface Config {
  mode: "development" | "production";
  port: number;
}

const config = {
  mode: "production",
  port: 3000,
} satisfies Config;
```

`as`는 타입을 검사하지 않으므로 타입 오류를 없애거나 값의 타입을 좁히기 위해 사용하지 않는다. 타입 가드나 검증 로직으로 런타임에 확인해 좁힌다.

```ts
const canvas = document.getElementById("main-canvas");

if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error("main-canvas element is missing");
}

const context = canvas.getContext("2d");
```

`as const`처럼 값의 타입을 좁히지 않는 단언은 사용할 수 있다. 외부 라이브러리의 잘못된 타입처럼 단언이 불가피하다면 가능한 한 좁은 범위에 두고 이유를 주석으로 남긴다.

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
