# Command Code 리버스 엔지니어링 근거

이 문서는 `omo-commandcode-oauth`의 구현 근거를 정리합니다. 주요 출처는 Command Code 공식 CLI 1.53.0 번들(`cli.mjs`, 난독화 해제 판독), 커뮤니티 구현(`opencode-commandcode`), 그리고 이 확장의 전신인 `pi-commandcode-provider`입니다.

## OAuth 흐름 (공식 CLI 1.53.0 기준)

공식 CLI는 브라우저 리다이렉트 방식의 로컬 콜백 플로우를 씁니다.

1. **로컬 서버**: `node:http`로 `127.0.0.1`에 바인딩합니다. 포트는 5959부터 최대 10개(5959~5968)를 순서대로 시도합니다.
2. **인증 URL**: `https://commandcode.ai/studio/auth/cli?callback=<urlencode된 http://127.0.0.1:PORT/callback>&state=<randomBytes(32).toString("base64url")>&mode=redirect`를 엽니다. `mode=redirect`가 GET 콜백 방식을 선택하는 파라미터입니다.
3. **콜백**: 로그인 완료 후 스튜디오가 `GET /callback`으로 리다이렉트하며 쿼리에 `apiKey`, `state`, `userId`, `userName`, `keyName`을 담습니다(전부 비어 있지 않은 문자열). 실패 시에는 `error`(예: `access_denied`), `error_description`, `state`가 옵니다.
4. **state 검증**: 콜백의 `state`가 기대값과 다르면 403을 응답하고 로그인을 거부합니다. CSRF 방어용입니다.
5. **성공 처리**: "Authentication complete"라는 최소 HTML 페이지를 200으로 응답하고, 약 500ms의 랜딩 유예 후 서버를 닫습니다. 첫 유효 콜백 이후에는 닫히는 일회용 서버입니다.
6. **키 검증**: 받은 키로 `GET https://api.commandcode.ai/alpha/whoami`에 `Authorization: Bearer <key>`를 붙여 호출합니다. 200과 사용자 정보 JSON(`user.id`, `user.userName`)이면 유효, 401이면 무효 키, 네트워크 오류나 5xx는 재시도 가능한 검증 오류로 구분합니다.
7. **저장**: 공식 CLI는 `auth.json`을 `0600` 권한으로 저장합니다. 이 확장도 계정 파일을 `0600`으로 씁니다(임시 파일 + rename으로 원자적 기록).

### 키 만료 모델링

Command Code API 키는 만료되지 않습니다. 호스트의 OAuth 계약을 맞추기 위해 `OAuthCredentials { access: key, refresh: key, expires: now + 10년 }`으로 모델링하고, `refreshToken`은 입력을 그대로 돌려주는 no-op입니다.

### 타임아웃 폴백

브라우저 콜백이 기본 120초(`COMMANDCODE_AUTH_TIMEOUT_MS`) 안에 도착하지 않으면, 호스트의 `onPrompt`로 사용자에게 API 키 직접 붙여넣기를 요청합니다. 붙여넣은 값은 bracketed paste 마커와 제어 문자를 제거한 뒤 동일하게 whoami 검증을 거칩니다.

## 레이트리밋 신호 스펙

다음 신호를 모두 레이트리밋으로 해석합니다.

- HTTP 상태 `429`
- 에러 본문의 `code`가 `RATE_LIMITED` 또는 `rate_limit_error`, 혹은 `error.type`이 `rate_limit_error`
- 메시지가 `/usage limit for your plan/i`에 매치

재시도 시각 해석 우선순위:

1. 본문 `error.rateLimit.reset` (unix 초 숫자). `rateLimit`은 `{ window: "fiveHour" | "daily" | "weekly", reset: <unix 초>, model?: string }` 형태입니다.
2. 메시지의 `/resets at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i` 캡처(ISO 시각).
3. `Retry-After` 응답 헤더(지연 초 정수 또는 HTTP-date).

크레딧 소진은 별도 신호입니다: HTTP `402` 또는 `code`가 `insufficient_credits` / `credits_exhausted` / `quota_exceeded`이면 `credits-exhausted`로 분류하고, 역시 `reset` 필드가 있으면 그 시각까지 쿨다운합니다.

## 크레딧 스펙

빌링 API 두 개를 조합해 계정별 크레딧 스냅샷을 만듭니다.

- `GET /alpha/billing/credits` (Bearer) -> `{ credits: { monthlyCredits, purchasedCredits, freeCredits } }` (USD)
- `GET /alpha/billing/subscriptions` (Bearer) -> `{ data: { planId, status, currentPeriodStart, currentPeriodEnd } }`. `data` 아래에 중첩되어 있어도, 최상위에 평탄하게 와도 받습니다(방어적 파싱).

규칙:

- `monthlyCredits`와 `freeCredits`는 `currentPeriodEnd`에 리셋되는 use-it-or-lose-it 크레딧입니다.
- `purchasedCredits`는 만료되지 않습니다.
- 그래서 풀은 주기 종료가 임박한(기본 24시간 이내) 계정을 Tier 0로 올려 소멸 예정 크레딧부터 먼저 소진합니다.

## 전송 경로

모델 호출은 문서화된 공개 엔드포인트를 씁니다.

- `POST /provider/v1/messages`: Anthropic Messages 와이어 포맷 그대로, `Authorization: Bearer <key>`.
- `GET /provider/v1/models`: `{ object: "list", data: [{ id, name, context_length }] }` (OpenAI 스타일).

공식 CLI의 내부 경로가 아니라 문서화된 provider 경로를 쓰는 이유는, 비공식 내부 API는 예고 없이 바뀌지만 공개 provider API는 하위 호환이 유지될 가능성이 훨씬 높기 때문입니다. Anthropic Messages 포맷을 그대로 말하므로 호스트 측 변환 계층도 필요 없습니다.

## 이전 구현(pi-commandcode-provider)과의 차이

| 항목 | pi-commandcode-provider | omo-commandcode-oauth |
|---|---|---|
| 콜백 방식 | POST 콜백 | `mode=redirect` GET 콜백(공식 CLI 1.53.0과 동일) |
| 계정 회전 | 단순 라운드로빈 | 티어(Tier 0 만료 임박 우선 / Tier 1 파일 순서) + 세션 sticky |
| 쿨다운 | 없음 또는 단순 제외 | 429/RATE_LIMITED 시 `reset`까지 격리, 전부 격리 시 리셋 시각 포함 에러 반환 |
| 스트림 중 실패 | 재시도 | 첫 이벤트 출력 후에는 재시도 금지(응답 혼합 방지) |
| 크레딧 인식 | 없음 | 빌링 스냅샷 기반 Tier 0 승격 |
