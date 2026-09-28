// 자체 확인용 목 서버. 의존성 없음(node:http만). 127.0.0.1:7789.
// GET / 에서 src/ui.html을 그대로 서빙하고, 계약(.roster/api-contract.md)
// 형태의 가짜 데이터 14건(pending 9 / auto_applied 5)으로 API를 흉내낸다.
// 실행: node scripts/mock-server.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_PATH = path.join(here, "..", "src", "ui.html");

let commitSeq = 0;
function fakeSha() {
  commitSeq += 1;
  return "deadbee" + String(commitSeq).padStart(2, "0");
}

function sampleDiff(id, file) {
  return (
    `diff --git a/${file} b/${file}\n` +
    `--- a/${file}\n+++ b/${file}\n` +
    `@@ -1,3 +1,4 @@\n` +
    ` line one\n` +
    `-old value for ${id}\n` +
    `+new value for ${id}\n` +
    `+added line for ${id}\n` +
    ` line three\n`
  );
}

const REQUESTS = [
  "버튼 문구를 수정한다",
  "로그에 요청 ID를 추가한다",
  "타임아웃 값을 30초로 올린다",
  "에러 메시지를 한국어로 바꾼다",
  "캐시 키에 버전을 포함한다",
  "설정 파일 경로를 환경변수로 읽는다",
  "재시도 횟수를 3회로 제한한다",
  "응답에 처리 시각을 포함한다",
  "임시 파일을 종료 시 삭제한다",
  "대용량 목록에 페이징을 적용한다",
  "외부 API 호출에 타임아웃을 건다",
  "비밀 키를 설정 저장소에서 읽는다",
  "결제 모듈에 감사 로그를 남긴다",
  "관리자 화면 접근을 제한한다",
];

// [stop_reasons, risk_score, test_passed]
const PENDING_META = [
  [["size"], 82, true],
  [["protected_path"], 74, true],
  [["secret"], 91, true],
  [["test_failed"], 68, false],
  [["size", "test_failed"], 88, false],
  [["protected_path", "secret"], 95, true],
  [["size"], 61, true],
  [["secret", "test_failed"], 77, false],
  [["protected_path"], 58, true],
];

const RATIONALES = [
  ["변경 범위가 한 파일로 한정된다", "기존 동작과 충돌하는 경로가 없다"],
  ["요청이 명시한 범위 안에서만 바뀐다", "되돌리기가 한 커밋으로 끝난다"],
];

const cases = new Map();
for (let i = 1; i <= 14; i++) {
  const id = "case-" + String(i).padStart(2, "0");
  const file = "src/" + (i % 2 === 0 ? "app" + i + ".ts" : "util" + i + ".ts");
  const pending = i <= 9;
  const meta = pending ? PENDING_META[i - 1] : [[], 20 + i, true];
  cases.set(id, {
    case_id: id,
    request: REQUESTS[i - 1],
    status: pending ? "pending" : "auto_applied",
    stop_reasons: meta[0],
    risk_score: meta[1],
    diff: sampleDiff(id, file),
    files: [file],
    lines_changed: 3,
    test_passed: meta[2],
    rationale: RATIONALES[i % 2],
    effect_on_approve: pending
      ? id + "의 변경이 샌드박스에 커밋된다"
      : null,
    decision: pending ? null : "approve",
    reviewer_note: null,
    commit_sha: pending ? null : fakeSha(),
  });
}

function summary(c) {
  return {
    case_id: c.case_id,
    request: c.request,
    status: c.status,
    stop_reasons: c.stop_reasons,
    risk_score: c.risk_score,
  };
}

function stats() {
  const s = { auto: 0, pending: 0, approved: 0, rejected: 0, not_run: 0, sandbox_commits: 0 };
  for (const c of cases.values()) {
    if (c.status === "auto_applied") { s.auto += 1; s.sandbox_commits += 1; }
    else if (c.status === "pending") s.pending += 1;
    else if (c.status === "approved_applied") { s.approved += 1; s.sandbox_commits += 1; }
    else if (c.status === "rejected") s.rejected += 1;
    else if (c.status === "not_run") s.not_run += 1;
  }
  return s;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (ch) => { buf += ch; });
    req.on("end", () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1:7789");
  const p = url.pathname;

  if (req.method === "GET" && p === "/") {
    try {
      const html = fs.readFileSync(UI_PATH, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      send(res, 500, { error: "ui.html을 읽을 수 없습니다" });
    }
    return;
  }
  if (req.method === "GET" && p === "/api/cases") {
    const ids = [...cases.keys()].sort();
    send(res, 200, ids.map((id) => summary(cases.get(id))));
    return;
  }
  if (req.method === "GET" && p === "/api/stats") {
    send(res, 200, stats());
    return;
  }
  if (req.method === "POST" && p === "/api/run-all") {
    for (const c of cases.values()) {
      if (c.status === "not_run") {
        if (c.stop_reasons.length === 0) {
          c.status = "auto_applied";
          c.decision = "approve";
          c.commit_sha = fakeSha();
        } else {
          c.status = "pending";
        }
      }
    }
    send(res, 200, stats());
    return;
  }

  const m = p.match(/^\/api\/cases\/([^/]+)(\/(approve|reject))?$/);
  if (m) {
    const c = cases.get(m[1]);
    if (!c) { send(res, 404, { error: "없는 case_id입니다: " + m[1] }); return; }
    if (!m[3]) {
      if (req.method !== "GET") { send(res, 404, { error: "없는 경로입니다" }); return; }
      send(res, 200, c);
      return;
    }
    if (req.method !== "POST") { send(res, 404, { error: "없는 경로입니다" }); return; }
    const body = await readBody(req);
    if (c.status !== "pending") {
      send(res, 409, { error: "이미 처리된 건입니다: " + c.case_id });
      return;
    }
    if (m[3] === "reject") {
      const note = body && typeof body.note === "string" ? body.note.trim() : "";
      if (!note) { send(res, 400, { error: "반려 사유를 입력해 주세요" }); return; }
      c.status = "rejected";
      c.decision = "reject";
      c.reviewer_note = body.note;
      send(res, 200, c);
      return;
    }
    c.status = "approved_applied";
    c.decision = "approve";
    c.reviewer_note = body && typeof body.note === "string" ? body.note : null;
    c.commit_sha = fakeSha();
    send(res, 200, c);
    return;
  }

  send(res, 404, { error: "없는 경로입니다" });
});

server.listen(7789, "127.0.0.1");
