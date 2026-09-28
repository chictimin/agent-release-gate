# agent-release-gate

저장소: <GITHUB_URL>

에이전트가 만든 코드 변경을 main에 바로 반영할지, 사람 승인을 기다릴지 가르는 게이트다.
LangGraph JS의 `interrupt`로 멈추고, 사람이 답하면 멈춘 지점부터 이어서 실행한다.

## 실행

Node 24와 pnpm이 필요하다.

```sh
pnpm install
pnpm init-sandbox   # 변경을 반영할 sandbox/ 저장소를 만든다 (초기 커밋 1개)
pnpm batch          # 예시 변경 14건을 게이트에 넣는다
pnpm serve          # http://127.0.0.1:7788
```

`pnpm batch`가 끝나면 마지막에 다음 두 줄이 나온다.

```
auto 5 / stop 9 / mismatch 0
sandbox commits: 6
```

14건 중 5건은 main에 자동으로 커밋되고, 9건은 사람 승인을 기다린다.
브라우저에서 대기 건을 열어 승인·반려를 표시하고 "결정 제출"을 누르면 반영된다.

처음 상태로 되돌리려면 `pnpm init-sandbox`를 다시 실행한다. `sandbox/`와 `data/gate.sqlite`를 지운다.

### 화면 없이 처리하기

```sh
pnpm batch resume <case_id> approve|reject [note]
```

`approve`는 변경을 적용하고 커밋 1개를 만든다. `reject`는 반영하지 않고 반려로 기록한다.

```json
{ "final_status": "approved_applied", "commit_sha": "20f44f2335822dc24b681f5d96598a42e90beb7b" }
```

## 구조

```
src/gate/        게이트 코어 (화면·입력 형식을 모른다)
  graph.ts       그래프 조립
  state.ts       그래프 상태
  checks.ts      diff 파싱과 멈춤 신호 계산 (순수 함수)
  rules.ts       임계값, 핵심 설정 파일 목록, 키 패턴, 위험 가중치
  sources.ts     변경을 읽어 오는 경계 (FixtureSource)
  appliers.ts    저장소에 반영하는 경계 (SandboxApplier)
src/server.ts    웹 서버
src/ui.html      승인 화면
scripts/         init-sandbox, run-batch, threshold-dist
fixtures/        예시 변경 14건 (<agent>-<slug>.json)
data/            gate.sqlite, 대기 상태 저장 (생성물)
sandbox/         변경이 반영되는 git 저장소 (생성물)
```

`scripts/mock-server.mjs`와 `scripts/ui-smoke.mjs`는 화면 개발 초기에 쓰던 도구로, 지금은 쓰지 않는다.

실제 작업에 붙이려면 두 경계만 바꾸면 된다.
`sources.ts`에 워커 브랜치의 diff를 읽는 `CaseSource`를, `appliers.ts`에 실제 저장소로 merge하는 `Applier`를 구현한다.
그래프는 `case_id`, `request`, `diff`, `test_passed`만 받고, 커밋은 `apply` 노드 한 곳에서만 만든다.

## API

응답은 모두 JSON이다. 에러는 `{ "error": "..." }`와 상태 코드로 돌려준다.

| 메서드·경로 | 응답 |
|---|---|
| `GET /api/cases` | 14건 요약, `created_at` 오름차순. `case_id`, `agent`, `branch`, `created_at`, `request`, `status`(`not_run`/`pending`/`auto_applied`/`approved_applied`/`rejected`), `stop_reasons`, `risk_score`, `files`, `updated_at`, `commit_sha` |
| `GET /api/cases/:id` | 상세. 요약에 `diff`, `lines_changed`, `test_passed`, `rationale`, `effect_on_approve`, `decision`, `reviewer_note`, `commit_message`를 더한다. 없는 id면 404 |
| `GET /api/stats` | `auto`, `pending`, `approved`, `rejected`, `not_run` 건수와 `sandbox_commits` |
| `GET /api/tree` | 워크스페이스 파일 목록. `path`, `exists_on_main`, `pending_cases`, `history_cases`, `last_commit` |
| `POST /api/run-all` | 아직 게이트에 넣지 않은 건만 실행하고 통계를 돌려준다 |
| `POST /api/cases/:id/approve` | body `{ "note"?: string }`. 대기 건이 아니면 409 |
| `POST /api/cases/:id/reject` | body `{ "note": string }`. 사유가 비면 400, 대기 건이 아니면 409 |
