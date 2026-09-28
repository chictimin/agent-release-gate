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
  type GateHandles,
} from "./gate/runner.js";

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

/** GET /api/tree: sandbox main HEAD 추적 파일 + pending 건이 새로 만드는 파일. gate 코어는 건드리지 않는다. */
export async function listTree(
  h: GateHandles,
): Promise<{ path: string; exists_on_main: boolean; pending_cases: string[] }[]> {
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
  for (const s of await listSummaries(h)) {
    if (s.status !== "pending") continue;
    const d = await getDetail(h, s.case_id);
    for (const f of d?.files ?? []) {
      const arr = pendingFiles.get(f) ?? [];
      arr.push(s.case_id);
      pendingFiles.set(f, arr);
    }
  }
  const all = new Set<string>([...onMain, ...pendingFiles.keys()]);
  return [...all].sort().map((path) => ({
    path,
    exists_on_main: onMain.has(path),
    pending_cases: pendingFiles.get(path) ?? [],
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
        sendJson(res, 200, await listSummaries(handles));
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
          const detail = await getDetail(handles, caseId);
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
          const detail = await resumeCase(
            handles,
            caseId,
            parts[3] as "approve" | "reject",
            note,
          );
          sendJson(res, 200, detail);
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
