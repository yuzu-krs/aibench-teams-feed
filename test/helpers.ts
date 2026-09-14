import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "ai-benchmark-bot/dist/logger.js";
import type { AppConfig } from "../src/config.js";

/** Silent logger for tests. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

export function testConfig(stateDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    feedBaseUrl: "https://yuzu-krs.github.io/aibench-teams-feed",
    timeZone: "Asia/Tokyo",
    digestHour: 6,
    digestMinute: 0,
    stateDir,
    rssDir: join(stateDir, "rss"),
    newModelMaxItems: 200,
    logLevel: "error",
    ...overrides
  };
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

