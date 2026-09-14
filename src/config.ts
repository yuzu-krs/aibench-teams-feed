import { resolve } from "node:path";
import { z } from "zod";

const optionalSecret = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional()
);

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

const configSchema = z.object({
  FEED_BASE_URL: z.string().url().default("https://yuzu-krs.github.io/aibench-teams-feed"),
  TIME_ZONE: z
    .string()
    .min(1)
    .refine(isIanaTimeZone, "TIME_ZONE must be a valid IANA time zone")
    .default("Asia/Tokyo"),
  DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(6),
  DIGEST_MINUTE: z.coerce.number().int().min(0).max(59).default(0),
  STATE_DIR: z.string().min(1).default("./state"),
  RSS_DIR: z.string().min(1).default("./docs/rss"),
  NEW_MODEL_MAX_ITEMS: z.coerce.number().int().min(10).max(1000).default(200),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  HUGGINGFACE_TOKEN: optionalSecret,
  GITHUB_TOKEN: optionalSecret
});

export interface AppConfig {
  /** Pages origin serving the feeds; the channel <link> and digest item link. */
  feedBaseUrl: string;
  timeZone: string;
  digestHour: number;
  digestMinute: number;
  stateDir: string;
  rssDir: string;
  newModelMaxItems: number;
  logLevel: "debug" | "info" | "warn" | "error";
  huggingFaceToken?: string;
  /** GitHub token; only raises api.github.com rate limits for LiveBench discovery. */
  githubToken?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.parse(env);
  const config: AppConfig = {
    feedBaseUrl: parsed.FEED_BASE_URL.replace(/\/+$/, ""),
    timeZone: parsed.TIME_ZONE,
    digestHour: parsed.DIGEST_HOUR,
    digestMinute: parsed.DIGEST_MINUTE,
    stateDir: resolve(parsed.STATE_DIR),
    rssDir: resolve(parsed.RSS_DIR),
    newModelMaxItems: parsed.NEW_MODEL_MAX_ITEMS,
    logLevel: parsed.LOG_LEVEL
  };
  if (parsed.HUGGINGFACE_TOKEN) config.huggingFaceToken = parsed.HUGGINGFACE_TOKEN;
  if (parsed.GITHUB_TOKEN) config.githubToken = parsed.GITHUB_TOKEN;
  return config;
}
