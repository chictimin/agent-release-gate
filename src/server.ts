import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  GateHttpError,
  getDetail,
  getStats,
  listSummaries,
  openGate,
  resumeCase,
  runNotRun,
  threadConfig,
  type CaseDetail,
  type GateHandles,
} from "./gate/runner.js";
import { buildCommitMessage } from "./gate/appliers.js";

const root = process.env.GATE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const uiPath = join(root, "src", "ui.html");
const handles: GateHandles = openGate({
  fixturesDir: join(root, "fixtures"),
  sandboxDir: join(root, "sandbox"),
  dbPath: join(root, "data", "gate.sqlite"),
});

/** ui.html 읽기. 파일이 없어도 죽지 않고 404 문장을 낸다. */
export function loadUiHtml(path: string): {
  status: number;
  contentType: string;
  body: string;
} {
  if (!existsSync(path)) {
    return {
      status: 404,
      contentType: "text/plain; charset=utf-8",
      body: "ui.html이 없습니다",
    };
  }
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: readFileSync(path, "utf8"),
  };
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new GateHttpError(400, "invalid json body"));
      }
    });
    req.on("error", reject);
  });
}

/** rev3: 해당 thread 최신 체크포인트 시각 ISO 문자열. not_run이면 null. d.ts: @langchain/langgraph pregel/types.d.ts StateSnapshot.createdAt */
export async function caseUpdatedAt(
  h: GateHandles,
  caseId: string,
): Promise<string | null> {
  try {
    const snap = await h.graph.getState(threadConfig(caseId));
    const v = snap.values as Record<string, unknown>;
    const ran =
      typeof v === "object" &&
      v !== null &&
      typeof v["request"] === "string" &&
      v["request"] !== "";
    if (!ran) return null;
    return typeof snap.createdAt === "string" ? snap.createdAt : null;
  } catch {
    return null;
  }
}

/** rev3: CaseSummary + files + updated_at */
export async function listEnrichedSummaries(h: GateHandles): Promise<
  {
    case_id: string;
    request: string;
    status: string;
    stop_reasons: string[];
    risk_score: number | null;
    files: string[];
    updated_at: string | null;
  }[]
> {
  const out: {
    case_id: string;
    request: string;
    status: string;
    stop_reasons: string[];
    risk_score: number | null;
    files: string[];
    updated_at: string | null;
  }[] = [];
  for (const s of await listSummaries(h)) {
    if (s.status === "not_run") {
      out.push({ ...s, files: [], updated_at: null });
      continue;
    }
    const d = await getDetail(h, s.case_id);
    out.push({
      ...s,
      files: d?.files ?? [],
      updated_at: await caseUpdatedAt(h, s.case_id),
    });
  }
  return out;
}

/** rev4: CaseDetail + commit_message. pending은 승인 시 남을 메시지, 처리 건은 commit_sha의 실제 메시지, rejected·커밋 없음은 "" */
export async function getEnrichedDetail(
  h: GateHandles,
  caseId: string,
): Promise<(CaseDetail & { commit_message: string }) | null> {
  const d = await getDetail(h, caseId);
  if (d === null) return null;
  let commit_message = "";
  if (d.status === "pending") {
    commit_message = buildCommitMessage(d.case_id, d.request);
  } else if (d.commit_sha) {
    try {
      commit_message = execFileSync(
        "git",
        ["log", "-1", "--format=%B", d.commit_sha],
        { cwd: h.sandboxDir, encoding: "utf8" },
      ).trim();
    } catch {
      commit_message = "";
    }
  }
  return { ...d, commit_message };
}

/** rev4: sandbox main에서 그 경로의 마지막 커밋. main에 없는 파일은 null */
export function lastCommitFor(
  h: GateHandles,
  path: string,
): { sha: string; subject: string; date: string } | null {
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%H%n%s%n%cI", "main", "--", path],
      { cwd: h.sandboxDir, encoding: "utf8" },
    ).trim();
    if (out === "") return null;
    const lines = out.split("\n");
    const sha = lines[0] ?? "";
    if (sha === "") return null;
    return { sha, subject: lines[1] ?? "", date: lines[2] ?? "" };
  } catch {
    return null;
  }
}

/** GET /api/tree: sandbox main HEAD 추적 파일 + pending 건이 새로 만드는 파일. gate 코어는 건드리지 않는다. */
export async function listTree(h: GateHandles): Promise<
  {
    path: string;
    exists_on_main: boolean;
    pending_cases: string[];
    history_cases: string[];
    last_commit: { sha: string; subject: string; date: string } | null;
  }[]
> {
  let tracked: string[] = [];
  try {
    tracked = execFileSync("git", ["ls-files"], { cwd: h.sandboxDir, encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
  } catch {
    tracked = [];
  }
  const onMain = new Set(tracked);
  const pendingFiles = new Map<string, string[]>();
  const historyFiles = new Map<string, { id: string; at: string }[]>();
  for (const s of await listEnrichedSummaries(h)) {
    if (s.status === "not_run") continue;
    for (const f of s.files) {
      if (s.status === "pending") {
        const arr = pendingFiles.get(f) ?? [];
        arr.push(s.case_id);
        pendingFiles.set(f, arr);
      } else {
        const arr = historyFiles.get(f) ?? [];
        arr.push({ id: s.case_id, at: s.updated_at ?? "" });
        historyFiles.set(f, arr);
      }
    }
  }
  for (const arr of historyFiles.values()) {
    arr.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }
  const all = new Set<string>([
    ...onMain,
    ...pendingFiles.keys(),
    ...historyFiles.keys(),
  ]);
  return [...all].sort().map((path) => ({
    path,
    exists_on_main: onMain.has(path),
    pending_cases: pendingFiles.get(path) ?? [],
    history_cases: (historyFiles.get(path) ?? []).map((e) => e.id),
    last_commit: onMain.has(path) ? lastCommitFor(h, path) : null,
  }));
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter((p) => p !== "");

      if (method === "GET" && parts.length === 0) {
        const ui = loadUiHtml(uiPath);
        res.writeHead(ui.status, { "content-type": ui.contentType });
        res.end(ui.body);
        return;
      }
      if (method === "GET" && parts.join("/") === "api/cases") {
        sendJson(res, 200, await listEnrichedSummaries(handles));
        return;
      }
      if (method === "GET" && parts.join("/") === "api/stats") {
        sendJson(res, 200, await getStats(handles));
        return;
      }
      if (method === "GET" && parts.join("/") === "api/tree") {
        sendJson(res, 200, await listTree(handles));
        return;
      }
      if (method === "POST" && parts.join("/") === "api/run-all") {
        await runNotRun(handles);
        sendJson(res, 200, await getStats(handles));
        return;
      }
      if (
        parts.length === 3 &&
        parts[0] === "api" &&
        parts[1] === "cases"
      ) {
        const caseId = decodeURIComponent(parts[2]);
        if (method === "GET") {
          const detail = await getEnrichedDetail(handles, caseId);
          if (detail === null) throw new GateHttpError(404, `unknown case: ${caseId}`);
          sendJson(res, 200, detail);
          return;
        }
      }
      if (
        parts.length === 4 &&
        parts[0] === "api" &&
        parts[1] === "cases" &&
        (parts[3] === "approve" || parts[3] === "reject")
      ) {
        const caseId = decodeURIComponent(parts[2]);
        if (method === "POST") {
          const body = (await readBody(req)) as { note?: unknown };
          const note = typeof body.note === "string" ? body.note : undefined;
          if (parts[3] === "reject" && (note === undefined || note.trim() === "")) {
            throw new GateHttpError(400, "note is required");
          }
          await resumeCase(
            handles,
            caseId,
            parts[3] as "approve" | "reject",
            note,
          );
          sendJson(
            res,
            200,
            (await getEnrichedDetail(handles, caseId)) ?? { error: "unreachable" },
          );
          return;
        }
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof GateHttpError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        console.error(err);
        sendJson(res, 500, { error: "internal error" });
      }
    }
  })();
});

// 직접 실행할 때만 바인딩한다. import(테스트 등) 시에는 바인딩하지 않는다.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  server.listen(7788, "127.0.0.1", () => {
    console.log("gate server on http://127.0.0.1:7788");
  });
}
