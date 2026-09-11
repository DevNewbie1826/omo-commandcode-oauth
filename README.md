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

### 개발

bun이 별칭 의존성을 중첩 복사하면 `#private` 타입 정체성이 깨질 수 있습니다. `postinstall`이 중복된 중첩 `@earendil-works` 스코프를 자동으로 정리합니다.

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

- **시작 순서**: 활성 계정 중 `monthly + free > 0`이고 `periodEnd`가 앞으로 `COMMANDCODE_EXPIRY_WINDOW_MS`(기본 24시간) 안에 있는 계정을 먼저 `periodEnd` 오름차순으로 둡니다(Tier 0). 나머지는 파일 순서를 유지합니다. 빌링 조회 결과는 메모리에만 보관하며, 파일에 이미 있는 `credits`는 시작 힌트로만 읽습니다.
- **스테이트리스 링**: 모든 요청은 항상 정렬된 1번 계정부터 시작합니다. 첫 출력 전에 429, `RATE_LIMITED`, `rate_limit_error`, 5xx 또는 네트워크 오류가 나면 다음 계정으로 이동합니다.
- **마지막 한 번**: 마지막 계정까지 실패하면 1번 계정을 정확히 한 번 더 시도합니다. 이 시도도 실패하면 그 시도의 HTTP 상태와 본문을 수정하거나 감싸지 않고 원문 그대로 전달합니다. N개 계정이 모두 실패할 때 시도 순서는 `[1, 2, ..., N, 1]`입니다.
- **인증 오류 즉시 전파**: 401/403 인증 오류는 어느 계정에서 발생하든 다른 계정을 시도하지 않고 원문 그대로 즉시 전달합니다.
- **출력 후 재시도 금지**: 첫 출력 이벤트가 전달된 뒤의 실패는 재생하거나 재시도하지 않고 그대로 전달합니다.
- **요청 간 상태 없음**: 커서, 세션 고정, 격리 쿨다운, 리셋 시각을 저장하지 않습니다. 다음 요청은 다시 1번 계정에서 시작합니다.

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `COMMANDCODE_API_BASE` | `https://api.commandcode.ai` | API 베이스 URL. whoami 검증, 빌링 조회, 모델 카탈로그 주소의 기준이 됩니다. |
| `COMMANDCODE_AUTH_TIMEOUT_MS` | `120000` | 브라우저 로그인 대기 시간(ms). 지나면 API 키 붙여넣기 프롬프트로 전환됩니다. |
| `COMMANDCODE_ACCOUNTS_FILE` | `~/.commandcode/omo-accounts.json` | 멀티 계정 자격 증명 파일 경로. |
| `COMMANDCODE_EXPIRY_WINDOW_MS` | `86400000` (24시간) | Tier 0로 분류할 과금 주기 종료 임박 창(ms). 양의 정수가 아니면 에러를 던집니다. |
| `COMMANDCODE_BILLING_TTL_MS` | `3600000` (1시간) | 계정별 크레딧 스냅샷의 인메모리 캐시 TTL(ms). |

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
      "createdAt": "2026-09-10T10:00:00.000Z"
    }
  ]
}
```

- 계정 파일 쓰기는 로그인/로그아웃 및 명시적인 계정 활성화 관리에서만 발생합니다. 요청 처리와 빌링 폴링은 파일을 쓰지 않습니다.
- 이전 버전 파일의 `credits`는 시작 정렬 힌트로 읽고, 폐기된 쿨다운 필드는 호환성을 위해 무시합니다.
- 파일이 깨져 있으면 부분 복구 없이 에러를 던집니다. 중복 `id`나 중복 `token`도 거부됩니다.

## 문제 해결

| 메시지 | 원인과 해결 |
|---|---|
| `No available Command Code callback port after 10 attempts starting at 5959` | 콜백 서버가 띄울 포트(5959~5968)가 모두 점유되어 있습니다. 해당 포트를 쓰는 프로세스를 종료하세요. |
| `Command Code callback state did not match the pending login` | 이전 로그인 시도의 콜백이 도착했습니다. `/login commandcode`를 다시 실행하세요. |
| `Command Code browser login timed out after 120000ms` | 브라우저 로그인이 시간 초과됐습니다. 이어지는 프롬프트에 API 키를 직접 붙여넣거나, `COMMANDCODE_AUTH_TIMEOUT_MS`를 늘리세요. |
| `Command Code rejected the API key (whoami returned 401)` | 키가 무효합니다. Command Code 스튜디오에서 키를 다시 발급받아 로그인하세요. |
| `Command Code whoami request failed with status 5xx` | Command Code 서버 측 오류입니다. 재시도 가능한 오류이니 잠시 후 다시 로그인하세요. |
| `No Command Code accounts` | 활성 Command Code 계정이 없습니다. `/login commandcode`로 계정을 추가하세요. |
| `Account credential already exists` | 같은 API 키로 이미 추가된 계정입니다. 다른 계정으로 로그인하세요. |
| `Accounts file at ... is not valid JSON` | 계정 파일이 손상됐습니다. 백업 후 파일을 지우고 다시 로그인하세요. |

## 모델 카탈로그

모델 목록은 프로세스 메모리에서만 관리됩니다.

- **동적 조회**: 시작할 때 `GET https://api.commandcode.ai/provider/v1/models`(OpenAI 스타일 `list` 응답)에서 최신 목록을 가져옵니다. 디스크에는 기록하지 않습니다.
- **정적 폴백**: 라이브 조회가 실패하면 내장된 정적 목록(`claude-sonnet-4-6`, `gpt-5.5`, `deepseek/deepseek-v4-flash`, `zai-org/GLM-5.1`)을 노출해 모델이 0개가 되는 일이 없습니다.

## 동작 원리

Command Code 공식 CLI(1.53.0)의 로그인 플로우를 재현합니다. 최종적으로 Command Code API 키를 발급받아 문서화된 provider 엔드포인트(`POST /provider/v1/messages`, Anthropic Messages 와이어 포맷)에서 사용합니다.

1. **로컬 콜백 서버**: `127.0.0.1`의 5959번 포트부터 최대 10개를 시도해 일회용 HTTP 서버를 띄웁니다.
2. **브라우저 로그인**: `https://commandcode.ai/studio/auth/cli?callback=<콜백 URL>&state=<랜덤 토큰>&mode=redirect`를 엽니다. `state`는 32바이트 랜덤(base64url)으로, 콜백 시 일치하지 않으면 403으로 거부합니다(CSRF 방어).
3. **키 수신**: 로그인 완료 후 스튜디오가 `GET /callback?apiKey=...&state=...&userId=...&userName=...&keyName=...`으로 리다이렉트하고, 서버는 "Authentication complete" 페이지를 보여준 뒤 약 500ms 후 닫힙니다.
4. **검증**: 받은 키로 `GET /alpha/whoami`를 호출해 유효성을 확인합니다. 401이면 무효 키, 네트워크/5xx는 재시도 가능한 오류로 구분합니다.
5. **저장과 회전**: 로그인/로그아웃만 계정 파일을 바꿉니다. 요청마다 정렬된 1번부터 스테이트리스 링을 돌며, 회전 가능한 오류면 다음 계정으로 갑니다. 마지막 계정 뒤에는 1번을 한 번만 더 시도하고, 실패 시 그 원문 오류를 그대로 전달합니다. 401/403 인증 오류와 첫 출력 뒤 오류는 즉시 전파합니다.

자세한 근거는 [`docs/research/commandcode-reverse-engineering.md`](docs/research/commandcode-reverse-engineering.md)를 참고하세요.

## 제거

```bash
omo remove git:github.com/DevNewbie1826/omo-commandcode-oauth
```

계정 파일(`~/.commandcode/omo-accounts.json`)은 남습니다. 완전히 지우려면 직접 삭제하세요.

## 라이선스

MIT
