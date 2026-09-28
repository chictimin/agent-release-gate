// 멈춤 신호 임계값·보호 경로·비밀 패턴·위험 가중치 상수.

/** 변경 줄(추가+삭제) 상한. 초과 시 size 신호. */
export const SIZE_MAX_LINES = 70;
/** 변경 파일 수 상한. 초과 시 size 신호. */
export const SIZE_MAX_FILES = 2;

/** 위험 점수 가중치 (합산 후 0~100으로 자름). */
export const RISK_WEIGHTS: Record<string, number> = {
  size: 25,
  protected_path: 40,
  secret: 50,
  test_failed: 30,
};

/** 비밀 탐지 정규식. 추가된 줄(+로 시작, +++ 제외)에만 적용한다. */
export const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{36}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** 보호 경로 여부. 스펙: `.github/**`, `package.json`, `pyproject.toml`, 파일명에 `auth` 포함, `*.env*`. */
export function isProtectedPath(path: string): boolean {
  const p = path.replace(/^\.\//, "");
  if (p === ".github" || p.startsWith(".github/")) return true;
  const base = basename(p);
  if (base === "package.json" || base === "pyproject.toml") return true;
  if (base.includes("auth")) return true;
  if (base.includes(".env")) return true;
  return false;
}
