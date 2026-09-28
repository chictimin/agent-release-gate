import {
  END,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { computeSignals, formatEffect, parseDiff } from "./checks.js";
import type { Applier } from "./appliers.js";
import type { CaseSource } from "./sources.js";
import { GateState } from "./state.js";
import type { Decision, FinalStatus, GateStateType } from "./state.js";

/** human_gate interrupt에 올리는 값. 부수효과 없이 값만 올린다. */
export interface GateInterrupt {
  case_id: string;
  stop_reasons: string[];
  signals: string[];
  rationale: string[];
  risk_score: number;
  effect_on_approve: string;
}

/** 재개 시 Command resume로 받는 값. */
export interface GateResume {
  decision: "approve" | "reject";
  note?: string;
}

export interface BuildGateArgs {
  source: CaseSource;
  applier: Applier;
  checkpointer: BaseCheckpointSaver;
}

/**
 * 게이트 그래프 조립.
 * START → intake → generate → verify → review → route
 * route ─┬ (stop_reasons 비었음) → apply → END            (auto_applied)
 *        └ (있음) → human_gate ─┬ approve → apply → END   (approved_applied)
 *                               └ reject → record_reject → END (rejected)
 */
export function buildGate(args: BuildGateArgs) {
  const { source, applier, checkpointer } = args;

  const builder = new StateGraph(GateState)
    .addNode("intake", (state: GateStateType) => {
      const c = source.load(state.case_id);
      return { request: c.request, diff: c.diff, test_passed: c.test_passed };
    })
    .addNode("generate", (state: GateStateType) => {
      // POC: 소스에서 diff 로드済. diff를 직접 파싱해 files·lines_changed 계산.
      const parsed = parseDiff(state.diff);
      return { files: parsed.files, lines_changed: parsed.linesChanged };
    })
    .addNode("verify", (state: GateStateType) => {
      // POC: fixture의 test_passed를 그대로 기록 (intake에서 적재済).
      return { test_passed: state.test_passed };
    })
    .addNode("review", (state: GateStateType) => {
      // 신호 계산 중 예외가 나면 멈춤으로 보낸다 (fail-closed).
      try {
        const parsed = parseDiff(state.diff);
        const r = computeSignals({
          files: parsed.files,
          linesChanged: parsed.linesChanged,
          addedLines: parsed.addedLines,
          testPassed: state.test_passed,
        });
        return {
          signals: r.signals,
          rationale: r.rationale,
          risk_score: r.riskScore,
          stop_reasons: r.stopReasons,
          effect_on_approve: formatEffect({
            files: parsed.files,
            added: parsed.added,
            removed: parsed.removed,
          }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          signals: ["review_error"],
          rationale: [`신호 계산 중 예외 발생: ${msg}`],
          risk_score: 100,
          stop_reasons: ["review_error"],
          effect_on_approve:
            "신호 계산에 실패해 승인 시 영향을 알 수 없습니다. 되돌리기: git revert <sha>",
        };
      }
    })
    .addNode("human_gate", (state: GateStateType) => {
      // 부수효과 금지. interrupt 값만 올리고 재개 시 노드를 처음부터 다시 실행한다.
      const payload: GateInterrupt = {
        case_id: state.case_id,
        stop_reasons: state.stop_reasons,
        signals: state.signals,
        rationale: state.rationale,
        risk_score: state.risk_score,
        effect_on_approve: state.effect_on_approve,
      };
      const resumed = interrupt<GateInterrupt, GateResume>(payload);
      const decision: Decision =
        resumed.decision === "approve" ? "approve" : "reject";
      return { decision, reviewer_note: resumed.note ?? "" };
    })
    .addNode("apply", (state: GateStateType) => {
      // 실제 git 반영은 이 노드에서만 일어난다.
      const { commit_sha } = applier.apply({
        caseId: state.case_id,
        request: state.request,
        diff: state.diff,
        files: state.files,
      });
      const final_status: FinalStatus =
        state.decision === "approve" ? "approved_applied" : "auto_applied";
      return { commit_sha, final_status };
    })
    .addNode("record_reject", () => {
      return { final_status: "rejected" as FinalStatus, commit_sha: "" };
    })
    .addEdge(START, "intake")
    .addEdge("intake", "generate")
    .addEdge("generate", "verify")
    .addEdge("verify", "review")
    // route는 별도 노드가 아니라 review 뒤의 조건 분기다.
    .addConditionalEdges("review", (state) =>
      state.stop_reasons.length === 0 ? "apply" : "human_gate",
    )
    .addConditionalEdges("human_gate", (state) =>
      state.decision === "approve" ? "apply" : "record_reject",
    )
    .addEdge("apply", END)
    .addEdge("record_reject", END);

  return builder.compile({ checkpointer });
}
