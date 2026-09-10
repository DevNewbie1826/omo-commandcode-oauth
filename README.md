# omo-commandcode-oauth

[omo](https://github.com/code-yeongyu/omo) CLI용 비공식 Command Code(commandcode.ai) OAuth 확장입니다. Command Code 로그인을 `commandcode` provider로 등록하고, 여러 계정을 레이트리밋 기반으로 자동 회전시켜 줍니다.

> **경고**
>
> 이 프로젝트는 Command Code 공식 CLI(1.53.0)의 로그인 플로우를 재현한 **비공식** 구현입니다.
>
> - Command Code의 공식 OAuth 클라이언트가 아닙니다.
> - 서비스 이용약관(ToS) 위반으로 간주될 수 있습니다.
> - Command Code 측 변경에 따라 언제든 예고 없이 동작이 중단될 수 있습니다.
> - 로그인 시 API 키가 `http://127.0.0.1` 로컬 콜백 URL의 **쿼리 문자열**로 전달되는 구조입니다. `state` 토큰으로 CSRF는 방어하지만, 브라우저 히스토리나 로컬 프록시 로그에 키가 남을 수 있습니다.
>
> 사용에 따른 모든 책임은 사용자 본인에게 있습니다.

## 사전 준비

- [omo CLI](https://github.com/code-yeongyu/omo)가 설치되어 있어야 합니다.

## 설치

GitHub에서 바로 설치:

```bash
omo install git:github.com/DevNewbie1826/omo-commandcode-oauth
```

로컬 경로에서 설치:

```bash
omo install ./local/path
```

## 사용법

1. omo를 실행하고 `/login commandcode`를 입력합니다.
2. 브라우저에서 Command Code 로그인 페이지가 열립니다. 로그인을 완료합니다.
3. 로그인이 끝나면 API 키가 로컬 콜백 서버로 자동 전달되고, `whoami` 검증 후 계정 풀에 추가됩니다.
4. 끝. 터미널에 아무것도 붙여넣을 필요가 없습니다.

**계정을 여러 개 추가하려면 `/login commandcode`를 반복하면 됩니다.** 로그인할 때마다 새 계정이 풀에 쌓이고, 이후 요청은 아래 회전 규칙에 따라 자동으로 분산됩니다. 같은 키를 중복 추가하면 거부됩니다.

브라우저 로그인이 시간 안에 끝나지 않으면(기본 120초) 터미널 프롬프트에 API 키를 직접 붙여넣는 폴백으로 전환됩니다.

Command Code API 키는 만료되지 않습니다. 내부적으로는 10년짜리 자격 증명으로 모델링되고, `refreshToken`은 아무 일도 하지 않습니다.

## 멀티 계정 회전 규칙

계정 풀은 티어와 세션 고정(sticky)을 조합해 계정을 고릅니다.

- **건강한 계정**: 활성화(`enabled`)되어 있고, 쿨다운(`retryAt`)이 지났거나 없는 계정.
- **Tier 0 (만료 임박 크레딧 우선)**: 크레딧 스냅샷이 있고, `monthly + free` 크레딧이 남아 있으며, 과금 주기 종료(`periodEnd`)가 `COMMANDCODE_EXPIRY_WINDOW_MS`(기본 24시간) 이내로 다가온 계정. `periodEnd` 오름차순으로 정렬되어 **가장 먼저 소멸하는 크레딧부터** 소진합니다. 월간/무료 크레딧은 주기가 끝나면 사라지는(use-it-or-lose-it) 크레딧이라, 버려지기 전에 먼저 씁니다.
- **Tier 1**: 그 외 건강한 계정 전부. 계정 파일에 적힌 순서(추가 순서)대로 사용합니다.
- **Sticky**: 세션 ID에 한번 바인딩된 계정은 건강한 동안 계속 유지됩니다. 대화 도중 계정이 바뀌어 컨텍스트가 흔들리는 일이 없습니다.
- **429 / RATE_LIMITED**: 응답이 레이트리밋이면 해당 계정을 리셋 시각까지 쿨다운(격리)하고 **다음 계정으로 즉시 재시도**합니다. 쿨다운 시각은 `rateLimit.reset`(unix 초), 메시지의 `resets at <ISO>`, `Retry-After` 헤더 순으로 해석합니다. 쿨다운은 올리기만 하고 내리지 않으며, 격리된 계정의 세션 바인딩은 해제됩니다.
- **전부 쿨다운**: 건강한 계정이 하나도 없으면 재시도하지 않고 레이트리밋 에러를 그대로 반환합니다. 회전 커서는 없어서, 쿨다운이 풀리면 자연스럽게 티어 순서의 첫 계정(크레딧 정보가 없으면 1번 계정)으로 돌아갑니다.
- **출력 후 재시도 금지**: 스트림이 첫 이벤트를 내보낸 뒤 실패하면 다른 계정으로 재시도하지 않습니다. 이미 사용자에게 출력이 시작된 응답을 다른 계정으로 이어 쓰면 내용이 섞이기 때문입니다.

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `COMMANDCODE_API_BASE` | `https://api.commandcode.ai` | API 베이스 URL. whoami 검증, 빌링 조회, 모델 카탈로그 주소의 기준이 됩니다. |
| `COMMANDCODE_AUTH_TIMEOUT_MS` | `120000` | 브라우저 로그인 대기 시간(ms). 지나면 API 키 붙여넣기 프롬프트로 전환됩니다. |
| `COMMANDCODE_ACCOUNTS_FILE` | `~/.commandcode/omo-accounts.json` | 멀티 계정 자격 증명 파일 경로. |
| `COMMANDCODE_EXPIRY_WINDOW_MS` | `86400000` (24시간) | Tier 0로 분류할 과금 주기 종료 임박 창(ms). 양의 정수가 아니면 에러를 던집니다. |
| `COMMANDCODE_BILLING_TTL_MS` | `3600000` (1시간) | 계정별 크레딧 스냅샷의 인메모리 캐시 TTL(ms). |
| `COMMANDCODE_MODELS_CACHE` | `~/.commandcode/omo-models.json` | 모델 카탈로그 캐시 파일 경로. |

## 계정 파일

기본 경로는 `~/.commandcode/omo-accounts.json`이며, `0600` 권한으로 원자적으로(임시 파일 + rename) 기록됩니다. 형태:

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "work",
      "token": "cc-api-key-...",
      "userId": "user_123",
      "userName": "mirage",
      "keyName": "cli-key",
      "enabled": true,
      "retryAt": 1758000000000,
      "createdAt": "2026-09-10T10:00:00.000Z",
      "credits": {
        "monthly": 12.5,
        "purchased": 3.0,
        "free": 0.5,
        "periodEnd": 1758000000000
      }
    }
  ]
}
```

- `retryAt`: 쿨다운 해제 시각(ms epoch). 격리된 계정에만 존재합니다.
- `credits`: 빌링 API에서 가져온 스냅샷(USD). `periodEnd`는 ms epoch이며, 이 시각에 `monthly`와 `free`가 리셋됩니다. `purchased`는 만료되지 않습니다.
- 파일이 깨져 있으면 부분 복구 없이 에러를 던집니다. 중복 `id`나 중복 `token`도 거부됩니다.

## 문제 해결

| 메시지 | 원인과 해결 |
|---|---|
| `No available Command Code callback port after 10 attempts starting at 5959` | 콜백 서버가 띄울 포트(5959~5968)가 모두 점유되어 있습니다. 해당 포트를 쓰는 프로세스를 종료하세요. |
| `Command Code callback state did not match the pending login` | 이전 로그인 시도의 콜백이 도착했습니다. `/login commandcode`를 다시 실행하세요. |
| `Command Code browser login timed out after 120000ms` | 브라우저 로그인이 시간 초과됐습니다. 이어지는 프롬프트에 API 키를 직접 붙여넣거나, `COMMANDCODE_AUTH_TIMEOUT_MS`를 늘리세요. |
| `Command Code rejected the API key (whoami returned 401)` | 키가 무효합니다. Command Code 스튜디오에서 키를 다시 발급받아 로그인하세요. |
| `Command Code whoami request failed with status 5xx` | Command Code 서버 측 오류입니다. 재시도 가능한 오류이니 잠시 후 다시 로그인하세요. |
| `No healthy Command Code accounts available; next retry at 2026-09-16T...` | 모든 계정이 레이트리밋 쿨다운 중입니다. 메시지의 시각(가장 빠른 리셋 시각) 이후에 다시 시도하거나 `/login commandcode`로 계정을 추가하세요. |
| `Account credential already exists` | 같은 API 키로 이미 추가된 계정입니다. 다른 계정으로 로그인하세요. |
| `Accounts file at ... is not valid JSON` | 계정 파일이 손상됐습니다. 백업 후 파일을 지우고 다시 로그인하세요. |

## 모델 카탈로그

모델 목록은 하드코딩되어 있지 않고 다음과 같이 관리됩니다.

- **동적 조회**: `GET https://api.commandcode.ai/provider/v1/models`(OpenAI 스타일 `list` 응답)에서 최신 목록을 가져옵니다.
- **로컬 캐시**: 가져온 목록은 `~/.commandcode/omo-models.json`에 24시간 TTL로 캐시됩니다. 오프라인으로 재시작해도 마지막 목록을 그대로 씁니다.
- **정적 폴백**: 라이브 조회와 캐시가 모두 실패하면 내장된 정적 목록(`claude-sonnet-4-6`, `gpt-5.5`, `deepseek/deepseek-v4-flash`, `zai-org/GLM-5.1`)을 노출해 모델이 0개가 되는 일이 없습니다.

## 동작 원리

Command Code 공식 CLI(1.53.0)의 로그인 플로우를 재현합니다. 최종적으로 Command Code API 키를 발급받아 문서화된 provider 엔드포인트(`POST /provider/v1/messages`, Anthropic Messages 와이어 포맷)에서 사용합니다.

1. **로컬 콜백 서버**: `127.0.0.1`의 5959번 포트부터 최대 10개를 시도해 일회용 HTTP 서버를 띄웁니다.
2. **브라우저 로그인**: `https://commandcode.ai/studio/auth/cli?callback=<콜백 URL>&state=<랜덤 토큰>&mode=redirect`를 엽니다. `state`는 32바이트 랜덤(base64url)으로, 콜백 시 일치하지 않으면 403으로 거부합니다(CSRF 방어).
3. **키 수신**: 로그인 완료 후 스튜디오가 `GET /callback?apiKey=...&state=...&userId=...&userName=...&keyName=...`으로 리다이렉트하고, 서버는 "Authentication complete" 페이지를 보여준 뒤 약 500ms 후 닫힙니다.
4. **검증**: 받은 키로 `GET /alpha/whoami`를 호출해 유효성을 확인합니다. 401이면 무효 키, 네트워크/5xx는 재시도 가능한 오류로 구분합니다.
5. **저장과 회전**: 키는 계정 풀 파일에 추가되고, 요청마다 티어 규칙으로 계정을 골라 Anthropic Messages 형식 그대로 `/provider/v1/messages`에 전송합니다. 429가 오면 리셋 시각까지 격리하고 다음 계정으로 넘어갑니다.

자세한 근거는 [`docs/research/commandcode-reverse-engineering.md`](docs/research/commandcode-reverse-engineering.md)를 참고하세요.

## 제거

```bash
omo remove git:github.com/DevNewbie1826/omo-commandcode-oauth
```

계정 파일(`~/.commandcode/omo-accounts.json`)과 모델 캐시(`~/.commandcode/omo-models.json`)는 남습니다. 완전히 지우려면 직접 삭제하세요.

## 라이선스

MIT
