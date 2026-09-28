import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { SandboxApplier } from "../src/gate/appliers.js";
import { buildGate } from "../src/gate/graph.js";
import { FixtureSource } from "../src/gate/sources.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixturesDir = join(root, "fixtures");
const sandboxDir = join(root, "sandbox");
const dbPath = join(root, "data", "gate.sqlite");

function openGate() {
  return buildGate({
    source: new FixtureSource(fixturesDir),
    applier: new SandboxApplier(sandboxDir),
    checkpointer: SqliteSaver.fromConnString(dbPath),
  });
}

interface Expected {
  route: "auto" | "stop";
  stop_reasons: string[];
}

function readExpected(caseId: string): Expected {
  const raw = readFileSync(join(fixturesDir, `${caseId}.json`), "utf8");
  return (JSON.parse(raw) as { expected: Expected }).expected;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

/**
 * 14건을 차례로 invoke한다. 멈춘 건은 interrupt 상태로 둔 채 넘어간다(재개하지 않는다).
 * 표: case_id | expected | actual route | stop_reasons | risk | final_status | commit_sha | match(O/X)
 */
async function runBatch(): Promise<void> {
  const graph = openGate();
  const source = new FixtureSource(fixturesDir);
  let auto = 0;
  let stopped = 0;
  let mismatch = 0;

  console.log(
    "case_id | expected | actual | stop_reasons | risk | final_status | commit_sha | match",
  );
  for (const caseId of source.list()) {
    const expected = readExpected(caseId);
    const config: RunnableConfig = { configurable: { thread_id: caseId } };
    await graph.invoke({ case_id: caseId }, config);
    const snap = await graph.getState(config);
    const pending = snap.tasks.flatMap((t) => t.interrupts ?? []);
    const v = snap.values as Record<string, unknown>;
    const stopReasons = (v["stop_reasons"] as string[]) ?? [];
    const risk = (v["risk_score"] as number) ?? 0;
    const finalStatus = (v["final_status"] as string) ?? "";
    const commitSha = ((v["commit_sha"] as string) ?? "") as string;

    let actual: "auto" | "stop";
    if (pending.length > 0) {
      actual = "stop";
      stopped += 1;
    } else {
      actual = "auto";
      auto += 1;
    }
    const ok = expected.route === actual && sameSet(expected.stop_reasons, stopReasons);
    if (!ok) mismatch += 1;
    const expStr =
      expected.route === "auto" ? "auto" : `stop:[${expected.stop_reasons.join(",")}]`;
    console.log(
      `${caseId} | ${expStr} | ${actual} | [${stopReasons.join(",")}] | ${risk} | ${finalStatus || "(pending)"} | ${commitSha.slice(0, 7) || "-"} | ${ok ? "O" : "X"}`,
    );
  }

  let commits = "?";
  try {
    commits = execFileSync("git", ["rev-list", "--count", "main"], {
      cwd: sandboxDir,
      encoding: "utf8",
    }).trim();
  } catch {
    // sandbox가 없으면 개수를 모른다. 표는 그대로 둔다.
  }
  console.log(`auto ${auto} / stop ${stopped} / mismatch ${mismatch}`);
  console.log(`sandbox commits: ${commits}`);
}

/** 다른 프로세스에서 interrupt를 재개하는 CLI. 2차 서버가 같은 경로를 쓴다. */
async function resume(args: string[]): Promise<void> {
  const [caseId, decision, note] = args;
  if (!caseId || (decision !== "approve" && decision !== "reject")) {
    console.error("usage: run-batch resume <case_id> approve|reject [note]");
    process.exit(1);
  }
  const graph = openGate();
  const config: RunnableConfig = { configurable: { thread_id: caseId } };
  const result = (await graph.invoke(
    new Command({ resume: { decision, note } }),
    config,
  )) as Record<string, unknown>;
  console.log(
    JSON.stringify(
      { final_status: result["final_status"], commit_sha: result["commit_sha"] },
      null,
      2,
    ),
  );
}

const [, , cmd, ...rest] = process.argv;
if (cmd === "resume") {
  await resume(rest);
} else {
  await runBatch();
}
