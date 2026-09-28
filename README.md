# agent-release-gate

에이전트가 만든 코드 패치를 자동 반영할지 사람 승인으로 멈출지 가르는 HITL 게이트 (LangGraph JS POC)

## 요구 환경

- Node 24
- pnpm

## 실행 순서

깨끗한 clone에서 아래 순서대로 실행한다.

```sh
pnpm install
pnpm init-sandbox
pnpm batch
pnpm serve
```

1. `pnpm install` — 의존성을 설치한다.
2. `pnpm init-sandbox` — `sandbox/` git 저장소를 만들고 초기 커밋 1개를 찍는다.
   `data/gate.sqlite`가 있으면 삭제한다 (리셋 겸용).
3. `pnpm batch` — 14건 fixture를 차례로 실행한다.
   멈춘 건은 interrupt 상태로 둔 채 다음 건으로 넘어간다.
   출력 예 (별도 clone에서 실행한 실제 출력):
   ```
   case_id | expected | actual | stop_reasons | risk | final_status | commit_sha | match
   case-01 | auto | auto | [] | 0 | auto_applied | 4e786d6 | O
   case-02 | auto | auto | [] | 0 | auto_applied | bbe388d | O
   case-03 | auto | auto | [] | 0 | auto_applied | d94f4a3 | O
   case-04 | auto | auto | [] | 0 | auto_applied | 096b5a0 | O
   case-05 | auto | auto | [] | 0 | auto_applied | 5140290 | O
   case-06 | stop:[size] | stop | [size] | 25 | (pending) | - | O
   case-07 | stop:[size] | stop | [size] | 25 | (pending) | - | O
   case-08 | stop:[protected_path] | stop | [protected_path] | 40 | (pending) | - | O
   case-09 | stop:[protected_path] | stop | [protected_path] | 40 | (pending) | - | O
   case-10 | stop:[secret] | stop | [secret] | 50 | (pending) | - | O
   case-11 | stop:[test_failed] | stop | [test_failed] | 30 | (pending) | - | O
   case-12 | stop:[test_failed] | stop | [test_failed] | 30 | (pending) | - | O
   case-13 | stop:[size,test_failed] | stop | [size,test_failed] | 55 | (pending) | - | O
   case-14 | stop:[protected_path,secret] | stop | [protected_path,secret] | 90 | (pending) | - | O
   auto 5 / stop 9 / mismatch 0
   sandbox commits: 6
   ```
4. `pnpm serve` — 서버를 띄운다.
5. 브라우저에서 `http://127.0.0.1:7788` 을 연다.

## 멈춘 건 재개 (CLI)

```sh
pnpm batch resume <case_id> approve|reject [note]
```

- `approve` — 대기 건을 적용하고 커밋한다. 출력 예 (별도 clone에서 `case-06`에 실행한 실제 출력):
  ```json
  {
    "final_status": "approved_applied",
    "commit_sha": "3d8290671ca1692c8af8c0f168a1e39b1cda23b2"
  }
  ```
- `reject` — 반영 없이 `rejected`로 기록한다. 서버 API에서는 `note`가 필수다
  (빈 문자열이면 400).

## API

`GET /`는 `src/ui.html`을 서빙한다. API 응답은 전부 JSON이며,
에러는 `{ "error": "..." }` 형태와 상태코드로 돌려준다
(`.roster/api-contract.md`가 정본).

| 메서드·경로 | 응답 |
|---|---|
| `GET /api/cases` | 200, 전체 14건 요약(`case_id` 오름차순). 항목: `case_id`, `request`, `status`(`not_run`/`pending`/`auto_applied`/`approved_applied`/`rejected`), `stop_reasons`, `risk_score`(`not_run`이면 `null`) |
| `GET /api/cases/:id` | 200 상세. 요약 항목에 `diff`, `files`, `lines_changed`, `test_passed`, `rationale`, `effect_on_approve`, `decision`, `reviewer_note`, `commit_sha` 추가. 모르는 id면 404 |
| `GET /api/stats` | 200, `auto`·`pending`·`approved`·`rejected`·`not_run` 수와 `sandbox_commits` |
| `POST /api/run-all` | 200, 아직 실행 안 된 건만 일괄 실행하고 통계 돌려줌 |
| `POST /api/cases/:id/approve` | body `{ "note"?: string }` → 200 상세. pending이 아니면 409, 모르는 id면 404 |
| `POST /api/cases/:id/reject` | body `{ "note": string }` 필수 → 200 상세. `note`가 비었으면 400, pending이 아니면 409, 모르는 id면 404 |

## 리셋 방법

```sh
pnpm init-sandbox
```

`sandbox/`를 지우고 다시 만들고, `data/gate.sqlite`를 삭제한다.
처음부터 다시 하려면 `pnpm init-sandbox` 후 `pnpm batch`를 실행한다.

## 디렉토리 구조

```
src/gate/        게이트 코어
  graph.ts       그래프 조립 (intake → generate → verify → review → route → apply/human_gate → record_reject)
  state.ts       그래프 상태 정의
  checks.ts      diff 파싱·신호 계산 (순수 함수)
  rules.ts       임계값·보호 경로·비밀 패턴·위험 가중치 상수
  sources.ts     케이스 제공 경계 (FixtureSource)
  appliers.ts    저장소 반영 경계 (SandboxApplier)
src/server.ts    웹 서버 (작성 중)
src/ui.html      승인 화면 (작성 중)
scripts/         init-sandbox.ts, run-batch.ts, threshold-dist.ts
fixtures/        14건 케이스 (case-01.json … case-14.json)
data/            gate.sqlite (생성물, git 제외)
sandbox/         패치가 적용되는 git 저장소 (생성물, git 제외)
```

## 확장 경계

- 새 케이스 출처로 바꾸려면 `sources.ts`의 `CaseSource`를 구현한다
  (이후 `GitBranchSource` 등으로 교체되는 지점).
  그래프는 `case_id`·`request`·`diff`·`test_passed`만 받으므로
  fixture 형식을 알지 못한다.
- 실제 저장소 반영으로 바꾸려면 `appliers.ts`의 `Applier`를 구현한다
  (이후 실제 저장소 merge로 교체되는 지점).
  커밋을 만드는 쪽은 `apply` 노드 한 곳뿐이므로 교체 범위가 거기로 묶인다.
