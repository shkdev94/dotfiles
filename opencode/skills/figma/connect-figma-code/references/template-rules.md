# Code Connect 템플릿 규칙

## 속성 대응

| Figma 속성 | 메서드 | 확인할 점 |
| --- | --- | --- |
| TEXT | `getString(name)` | 실제 텍스트 prop과 대응시킨다. |
| BOOLEAN | `getBoolean(name, mapping?)` | boolean 또는 실제 코드의 대안 값으로 바꾼다. |
| VARIANT | `getEnum(name, mapping)` | 반환된 모든 값을 매핑한다. |
| INSTANCE_SWAP | `getInstanceSwap(name)` | 반환값이 `INSTANCE`인지 확인하고 연결된 템플릿을 실행한다. |
| SLOT | `getSlot(name)` | 실제 속성 타입이 SLOT일 때만 사용하며 snippet section으로 삽입한다. |
| 이름으로 찾을 자식 | `findInstance()`·`findText()` | 실패 시 truthy한 오류 핸들일 수 있으므로 타입을 확인한다. |

중첩 인스턴스를 탐색해야 한다면 `traverseInstances: true`와 필요한 `path`로 범위를 정한다. 설정 가능한 자식은 자체 템플릿을 만들어 재사용한다. 부모가 자식의 props를 전달하는 경우와 단순히 자식을 포함하는 경우를 구분한다.

## 반환과 보간

템플릿의 기본 export에는 `example: figma.code\`...\``와 식별자 `id`를 둔다. 필요할 때 `imports`와 `metadata`를 추가한다. 파일 상단의 `url`, `source`, `component` 정보는 실제 대상과 일치시킨다.

- 문자열 prop은 따옴표로 감싼다.
- `executeTemplate().example`은 문자열이 아닌 section 배열이다. `+`나 `.join()`으로 합치지 않고 `figma.code` 안에 보간한다.
- SLOT의 section 배열은 자식 위치에 직접 삽입한다. INSTANCE_SWAP을 SLOT으로 읽거나 SLOT에 `executeTemplate()`을 호출하지 않는다.
- 반환 핸들의 `type === "INSTANCE"`를 확인한 뒤 템플릿을 실행한다. 실패를 숨기는 조건문으로 누락된 출력을 정상 처리하지 않는다.
- 여러 variant가 결과에 함께 영향을 주면 모든 조합을 처리한다. 단순히 prop으로 전달되는 값은 불필요한 조합 분기를 만들지 않는다.

정확한 API나 복잡한 중첩이 필요하면 [공식 API](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-code-connect/references/api.md)와 [중첩 패턴](https://github.com/figma/mcp-server-guide/blob/172920731eedf414e9b22ae60017d9a5b6c9f81f/skills/figma-code-connect/references/advanced-patterns.md)의 해당 부분을 읽는다.
