import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const sandboxDir = join(root, "sandbox");
const dbPath = join(root, "data", "gate.sqlite");

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: sandboxDir, encoding: "utf8" }).trim();
}

function write(rel: string, content: string): void {
  const full = join(sandboxDir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/**
 * sandbox/를 지우고 다시 만든다: git init, main 브랜치, 작은 TS 프로젝트,
 * 초기 커밋 1개. data/gate.sqlite도 삭제한다 (리셋 겸용).
 */
function main(): void {
  rmSync(sandboxDir, { recursive: true, force: true });
  rmSync(dbPath, { force: true });
  mkdirSync(sandboxDir, { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });

  write(
    "package.json",
    `{
  "name": "sandbox",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "node --test"
  }
}
`,
  );
  write(
    "README.md",
    `# Sandbox

게이트 POC용 작은 프로젝트다.

## Scripts

- build: TypeScript 컴파일
- test: 테스트 실행
`,
  );
  write(
    "src/logger.ts",
    `export type LogLevel = "debug" | "info" | "warn" | "error";

export function formatLog(level: LogLevel, message: string): string {
  return \`[\${level}] \${message}\`;
}

export function log(level: LogLevel, message: string): void {
  console.log(formatLog(level, message));
}
`,
  );
  write(
    "src/app-config.ts",
    `export interface AppConfig {
  timeoutMs: number;
  retries: number;
}

export const defaultConfig: AppConfig = {
  timeoutMs: 5000,
  retries: 3,
};
`,
  );
  write(
    "src/validate.ts",
    `export function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

export function assertNonEmpty(value: string, name: string): void {
  if (!isNonEmpty(value)) {
    throw new Error(\`\${name} must not be empty\`);
  }
}
`,
  );
  write(
    "src/settings.ts",
    `export interface Settings {
  apiBaseUrl: string;
  apiKey: string;
}

export const settings: Settings = {
  apiBaseUrl: "https://api.example.com",
  apiKey: process.env.API_KEY ?? "",
};
`,
  );
  write(
    "src/retry.ts",
    `export async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
`,
  );
  write(
    "src/cache.ts",
    `export class SimpleCache {
  private store = new Map<string, string>();
  get(key: string): string | undefined {
    return this.store.get(key);
  }
  set(key: string, value: string): void {
    this.store.set(key, value);
  }
}
`,
  );
  write(
    ".github/workflows/ci.yml",
    `name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run build
`,
  );

  git(["init", "-b", "main"]);
  git(["config", "user.name", "gate"]);
  git(["config", "user.email", "gate@example.com"]);
  git(["add", "-A"]);
  git(["-c", "core.untrackedCache=false", "commit", "-m", "initial sandbox"]);
  console.log(`sandbox ready: ${git(["rev-parse", "--short", "HEAD"])}`);
  console.log(`db removed: ${dbPath}`);
}

main();
