import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const base = join(homedir(), "Desktop", "aiffel");

const LOCK_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "poetry.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "Gemfile.lock",
]);

function excluded(file: string): boolean {
  if (file.endsWith(".ipynb")) return true;
  const segs = file.split("/");
  if (segs.includes("dist")) return true;
  const baseName = segs[segs.length - 1];
  if (LOCK_NAMES.has(baseName) || baseName.endsWith(".lock")) return true;
  return false;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * ~/Desktop/aiffel/* 아래 git 저장소들의 커밋별 변경 줄·파일 수 분포.
 * git log --no-merges --numstat --format=tformat:@@ 로 모아 p25/p50/p75/p90 출력.
 * lock 파일·dist/·*.ipynb 제외. 임계값 근거용이며 값을 고치지 않는다.
 */
function main(): void {
  const repos = readdirSync(base)
    .map((name) => join(base, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory() && existsSync(join(p, ".git"));
      } catch {
        return false;
      }
    })
    .sort();

  const lineCounts: number[] = [];
  const fileCounts: number[] = [];
  let scanned = 0;
  let skipped = 0;

  for (const repo of repos) {
    let out: string;
    try {
      out = execFileSync(
        "git",
        ["log", "--no-merges", "--numstat", "--format=tformat:@@"],
        { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
      );
    } catch {
      continue;
    }
    let lines = 0;
    let files = 0;
    let inCommit = false;
    const flush = () => {
      if (!inCommit) return;
      scanned += 1;
      if (files === 0) {
        skipped += 1;
      } else {
        lineCounts.push(lines);
        fileCounts.push(files);
      }
      lines = 0;
      files = 0;
    };
    for (const line of out.split("\n")) {
      if (line === "@@") {
        flush();
        inCommit = true;
        continue;
      }
      if (!inCommit || line.trim() === "") continue;
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
      if (!m) continue;
      const file = m[3];
      if (excluded(file)) continue;
      const added = m[1] === "-" ? 0 : Number(m[1]);
      const removed = m[2] === "-" ? 0 : Number(m[2]);
      lines += added + removed;
      files += 1;
    }
    flush();
  }

  lineCounts.sort((a, b) => a - b);
  fileCounts.sort((a, b) => a - b);
  const ps = [25, 50, 75, 90];
  console.log(`repos: ${repos.length}, commits scanned: ${scanned}, skipped (no counted files): ${skipped}`);
  console.log(
    `lines: ${ps.map((p) => `p${p}=${percentile(lineCounts, p)}`).join(" ")} (n=${lineCounts.length})`,
  );
  console.log(
    `files: ${ps.map((p) => `p${p}=${percentile(fileCounts, p)}`).join(" ")} (n=${fileCounts.length})`,
  );
}

main();
