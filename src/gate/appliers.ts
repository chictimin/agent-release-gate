import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ApplyResult {
  commit_sha: string;
}

/** 실제 저장소 반영 경계. 이후 실제 저장소 merge로 교체되는 지점. */
export interface Applier {
  apply(args: {
    caseId: string;
    request: string;
    diff: string;
    files: string[];
  }): ApplyResult;
}

/** sandbox git 저장소에 diff를 적용하고 커밋하는 적용기. */
export class SandboxApplier implements Applier {
  constructor(private repoDir: string) {}

  private git(args: string[]): string {
    return execFileSync("git", args, {
      cwd: this.repoDir,
      encoding: "utf8",
    }).trim();
  }

  apply(args: {
    caseId: string;
    request: string;
    diff: string;
    files: string[];
  }): ApplyResult {
    const workdir = mkdtempSync(join(tmpdir(), `gate-${args.caseId}-`));
    try {
      const patch = join(workdir, "change.patch");
      writeFileSync(patch, args.diff + "\n");
      execFileSync("git", ["apply", "--check", patch], { cwd: this.repoDir });
      execFileSync("git", ["apply", patch], { cwd: this.repoDir });
      execFileSync("git", ["add", "-A"], { cwd: this.repoDir });
      const message = `[gate] ${args.caseId}: ${args.request}`;
      execFileSync("git", ["commit", "-m", message], { cwd: this.repoDir });
      const commit_sha = this.git(["rev-parse", "HEAD"]);
      return { commit_sha };
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }
}
