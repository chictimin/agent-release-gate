import { Annotation } from "@langchain/langgraph";

export type Decision = "approve" | "reject" | "";
export type FinalStatus = "" | "auto_applied" | "approved_applied" | "rejected";

/**
 * 게이트 그래프의 전체 상태.
 * 소스·적용기는 인터페이스로 주입되므로 UI·파일 경로·fixture 형식을 모른다.
 */
export const GateState = Annotation.Root({
  /** 스레드 식별자이자 케이스 식별자. */
  case_id: Annotation<string>,
  /** 사람이 쓴 요청 한 문장. */
  request: Annotation<string>,
  /** unified diff 원문. */
  diff: Annotation<string>,
  /** diff에서 파싱한 변경 파일 목록. */
  files: Annotation<string[]>,
  /** 변경 줄(추가+삭제). diff 직접 파싱 값. */
  lines_changed: Annotation<number>,
  /** 테스트 통과 여부 (fixture 기록). */
  test_passed: Annotation<boolean>,
  /** 계산된 신호 id 목록. */
  signals: Annotation<string[]>,
  /** 신호별 사람이 읽는 근거 문장. */
  rationale: Annotation<string[]>,
  /** 신호 가중 합 (0~100). */
  risk_score: Annotation<number>,
  /** 멈춤 사유. 비어 있으면 자동 적용 경로. */
  stop_reasons: Annotation<string[]>,
  /** 승인 시 일어날 일을 적은 문장. */
  effect_on_approve: Annotation<string>,
  /** human_gate에서 기록한 결정. */
  decision: Annotation<Decision>,
  /** 검토자 메모. */
  reviewer_note: Annotation<string>,
  /** 최종 상태. */
  final_status: Annotation<FinalStatus>,
  /** apply 노드가 만든 커밋 SHA. */
  commit_sha: Annotation<string>,
});

export type GateStateType = typeof GateState.State;
