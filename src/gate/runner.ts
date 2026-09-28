import { execFileSync } from "node:child_process";
import { Command } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { SandboxApplier } from "./appliers.js";
import { buildGate } from "./graph.js";
import { FixtureSource } from "./sources.js";

/**
 * 서버·스크립트가 공유하는 실행 도우미.
 * run-batch.ts와 같은 함수(buildGate·FixtureSource·SandboxApplier)를 쓴다.
 * 1차 코드의 공개 인터페이스를 그대로 쓰며 gate 코어는 고치지 않는다.
 */

export type Status =
  | "not_run"
  | "pending"
  | "auto_applied"
  | "approved_applied"
  | "rejected";

export interface CaseSummary {
  case_id: string;
  request: string;
  status: Status;
  stop_reasons: string[];
  risk_score: number | null;
}

export interface CaseDetail extends CaseSummary {
  diff: string;
  files: string[];
  lines_changed: number;
  test_passed: boolean;
  rationale: string[];
  effect_on_approve: string | null;
  decision: "approve" | "reject" | null;
  reviewer_note: string | null;
  commit_sha: string | null;
}

export interface Stats {
  auto: number;
  pending: number;
  approved: number;
  rejected: number;
  not_run: number;
  sandbox_commits: number;
}

export interface GatePaths {
  fixturesDir: string;
  sandboxDir: string;
  dbPath: string;
}

export interface GateHandles {
  graph: ReturnType<typeof buildGate>;
  source: FixtureSource;
  sandboxDir: string;
}

export function openGate(paths: GatePaths): GateHandles {
  return {
    graph: buildGate({
      source: new FixtureSource(paths.fixturesDir),
      applier: new SandboxApplier(paths.sandboxDir),
      checkpointer: SqliteSaver.fromConnString(paths.dbPath),
    }),
    source: new FixtureSource(paths.fixturesDir),
    sandboxDir: paths.sandboxDir,
  };
}

export function threadConfig(caseId: string): RunnableConfig {
  return { configurable: { thread_id: caseId } };
}

/** HTTP 상태코드를 함께 나르는 에러. 서버가 {error}로 변환한다. */
export class GateHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asNullableString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * 케이스 상세를 읽는다. 모르는 id면 null.
 * 실행 전(not_run)이면 fixture의 request·diff·test_passed만 채운다.
 */
export async function getDetail(
  h: GateHandles,
  caseId: string,
): Promise<CaseDetail | null> {
  if (!h.source.list().includes(caseId)) return null;
  const fixture = h.source.load(caseId);
  const snap = await h.graph.getState(threadConfig(caseId));
  const v = snap.values as Record<string, unknown>;
  const ran =
    typeof v === "object" &&
    v !== null &&
    typeof v["request"] === "string" &&
    v["request"] !== "";

  if (!ran) {
    return {
      case_id: caseId,
      request: fixture.request,
      status: "not_run",
      stop_reasons: [],
      risk_score: null,
      diff: fixture.diff,
      files: [],
      lines_changed: 0,
      test_passed: fixture.test_passed,
      rationale: [],
      effect_on_approve: null,
      decision: null,
      reviewer_note: null,
      commit_sha: null,
    };
  }

  const pending = snap.tasks.flatMap((t) => t.interrupts ?? []).length > 0;
  const finalStatus = v["final_status"] as string;
  const status: Status = pending
    ? "pending"
    : finalStatus === "auto_applied" ||
        finalStatus === "approved_applied" ||
        finalStatus === "rejected"
      ? finalStatus
      : "pending";
  const decisionRaw = v["decision"] as string;
  return {
    case_id: caseId,
    request: (v["request"] as string) ?? fixture.request,
    status,
    stop_reasons: asStringArray(v["stop_reasons"]),
    risk_score: typeof v["risk_score"] === "number" ? v["risk_score"] : 0,
    diff: (v["diff"] as string) ?? fixture.diff,
    files: asStringArray(v["files"]),
    lines_changed: typeof v["lines_changed"] === "number" ? v["lines_changed"] : 0,
    test_passed: v["test_passed"] === true,
    rationale: asStringArray(v["rationale"]),
    effect_on_approve: asNullableString(v["effect_on_approve"]),
    decision: decisionRaw === "approve" || decisionRaw === "reject" ? decisionRaw : null,
    reviewer_note: asNullableString(v["reviewer_note"]),
    commit_sha: asNullableString(v["commit_sha"]),
  };
}

export async function listSummaries(h: GateHandles): Promise<CaseSummary[]> {
  const out: CaseSummary[] = [];
  for (const caseId of h.source.list()) {
    const d = (await getDetail(h, caseId)) as CaseDetail;
    out.push({
      case_id: d.case_id,
      request: d.request,
      status: d.status,
      stop_reasons: d.stop_reasons,
      risk_score: d.risk_score,
    });
  }
  return out;
}

export async function getStats(h: GateHandles): Promise<Stats> {
  const summaries = await listSummaries(h);
  let sandbox_commits = 0;
  try {
    sandbox_commits = Number(
      execFileSync("git", ["rev-list", "--count", "main"], {
        cwd: h.sandboxDir,
        encoding: "utf8",
      }).trim(),
    );
  } catch {
    // sandbox가 없으면 0으로 둔다.
  }
  return {
    auto: summaries.filter((s) => s.status === "auto_applied").length,
    pending: summaries.filter((s) => s.status === "pending").length,
    approved: summaries.filter((s) => s.status === "approved_applied").length,
    rejected: summaries.filter((s) => s.status === "rejected").length,
    not_run: summaries.filter((s) => s.status === "not_run").length,
    sandbox_commits,
  };
}

/** 아직 실행 안 된 건만 일괄 실행한다. 실행한 case_id 목록을 돌려준다. */
export async function runNotRun(h: GateHandles): Promise<string[]> {
  const ran: string[] = [];
  for (const caseId of h.source.list()) {
    const snap = await h.graph.getState(threadConfig(caseId));
    const v = snap.values as Record<string, unknown>;
    if (typeof v?.["request"] === "string" && v["request"] !== "") continue;
    await h.graph.invoke({ case_id: caseId }, threadConfig(caseId));
    ran.push(caseId);
  }
  return ran;
}

/** interrupt 재개. 모르는 id면 404, pending이 아니면 409 에러를 던진다. */
export async function resumeCase(
  h: GateHandles,
  caseId: string,
  decision: "approve" | "reject",
  note?: string,
): Promise<CaseDetail> {
  const before = await getDetail(h, caseId);
  if (before === null) throw new GateHttpError(404, `unknown case: ${caseId}`);
  if (before.status !== "pending")
    throw new GateHttpError(409, `not pending: ${caseId} (status=${before.status})`);
  await h.graph.invoke(
    new Command({ resume: { decision, note } }),
    threadConfig(caseId),
  );
  return (await getDetail(h, caseId)) as CaseDetail;
}
