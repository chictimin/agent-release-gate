import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 그래프에 들어가는 케이스 입력. expected는 포함하지 않는다. */
export interface CaseInput {
  case_id: string;
  request: string;
  diff: string;
  test_passed: boolean;
}

/** 케이스 제공 경계. 이후 GitBranchSource 등으로 교체되는 지점. */
export interface CaseSource {
  list(): string[];
  load(caseId: string): CaseInput;
}

interface FixtureFile {
  case_id: string;
  request: string;
  diff: string;
  test_passed: boolean;
  expected?: unknown;
}

/** fixtures/*.json에서 읽는 소스. `expected`는 그래프에 넘기지 않는다. */
export class FixtureSource implements CaseSource {
  constructor(private dir: string) {}

  list(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => f.slice(0, -".json".length));
  }

  load(caseId: string): CaseInput {
    const raw = readFileSync(join(this.dir, `${caseId}.json`), "utf8");
    const parsed = JSON.parse(raw) as FixtureFile;
    return {
      case_id: parsed.case_id,
      request: parsed.request,
      diff: parsed.diff,
      test_passed: parsed.test_passed,
    };
  }
}
