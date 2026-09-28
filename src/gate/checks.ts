import {
  RISK_WEIGHTS,
  SECRET_PATTERNS,
  SIZE_MAX_FILES,
  SIZE_MAX_LINES,
  isProtectedPath,
} from "./rules.js";

export interface ParsedDiff {
  /** 변경 파일 목록 (b/ 측 경로). */
  files: string[];
  added: number;
  removed: number;
  linesChanged: number;
  /** 추가된 줄 내용 (+++ 헤더 제외). secret 검사용. */
  addedLines: string[];
}

/**
 * unified diff를 직접 파싱한다.
 * `diff --git`, `+++ b/<path>` 헤더로 파일을 찾고,
 * `+`(+++ 제외)/`-`(--- 제외) 줄을 센다.
 */
export function parseDiff(diff: string): ParsedDiff {
  const files: string[] = [];
  const addedLines: string[] = [];
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      const path = p.startsWith("b/") ? p.slice(2) : p;
      if (path !== "/dev/null" && path !== "dev/null") files.push(path);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
      addedLines.push(line.slice(1));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return { files, added, removed, linesChanged: added + removed, addedLines };
}

export interface SignalResult {
  signals: string[];
  rationale: string[];
  riskScore: number;
  /** 멈춤 사유. 네 신호 모두 멈춤 조건이므로 signals와 같다. */
  stopReasons: string[];
}

/**
 * 멈춤 신호 4종 계산 (순수 함수).
 * size | protected_path | secret | test_failed. 하나라도 걸리면 멈춤.
 */
export function computeSignals(args: {
  files: string[];
  linesChanged: number;
  addedLines: string[];
  testPassed: boolean;
}): SignalResult {
  const signals: string[] = [];
  const rationale: string[] = [];

  if (
    args.linesChanged > SIZE_MAX_LINES ||
    args.files.length > SIZE_MAX_FILES
  ) {
    signals.push("size");
    rationale.push(
      `변경 규모가 상한을 넘음 (줄 ${args.linesChanged} > ${SIZE_MAX_LINES} 또는 파일 ${args.files.length} > ${SIZE_MAX_FILES})`,
    );
  }

  const protectedFiles = args.files.filter(isProtectedPath);
  if (protectedFiles.length > 0) {
    signals.push("protected_path");
    rationale.push(`보호 경로 포함: ${protectedFiles.join(", ")}`);
  }

  const secretHit = args.addedLines.some((l) =>
    SECRET_PATTERNS.some((re) => re.test(l)),
  );
  if (secretHit) {
    signals.push("secret");
    rationale.push("추가된 줄에 비밀 형식 문자열이 있음");
  }

  if (args.testPassed === false) {
    signals.push("test_failed");
    rationale.push("테스트가 실패함 (test_passed === false)");
  }

  const raw = signals.reduce((sum, s) => sum + (RISK_WEIGHTS[s] ?? 0), 0);
  const riskScore = Math.max(0, Math.min(100, raw));
  return { signals, rationale, riskScore, stopReasons: [...signals] };
}

/** 승인 시 일어날 일을 적은 문장. */
export function formatEffect(args: {
  files: string[];
  added: number;
  removed: number;
}): string {
  const head =
    args.files.length === 0
      ? "변경 파일 없음"
      : args.files.length === 1
        ? args.files[0]
        : `${args.files[0]} 외 ${args.files.length - 1}파일`;
  return (
    `sandbox main에 커밋 1개가 추가됩니다 ` +
    `(${head}, +${args.added}/-${args.removed}). ` +
    `되돌리기: git revert <sha>`
  );
}
