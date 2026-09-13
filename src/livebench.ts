import { errorFields, type Logger } from "ai-benchmark-bot/dist/logger.js";
import { parseJson } from "ai-benchmark-bot/dist/http.js";
import { z } from "zod";

/**
 * LiveBench leaderboard, sourced from the benchmark project's own published
 * files. Scores follow the site's OFFICIAL aggregation formula — the feed
 * never invents its own: a category score is the mean of its task columns'
 * valid values, and the overall is the mean of the category means (a model
 * missing an entire category has no official overall and cannot be ranked).
 *
 * Release discovery and content freshness are two different axes here:
 * - The official RELEASES list (src/lib/constants.js of the new-livebench
 *   site repo) names the current release; release dates move rarely.
 * - The release's files are then UPDATED IN PLACE as new models are scored
 *   (a 2026-06-25 table gained models through September). The live site
 *   livebench.ai always serves the freshest copy, so it is tried first and
 *   its Last-Modified is the actual data date. Raw fallbacks serve the same
 *   release and are used only when the live site fails — never an older
 *   release, which would silently stale the feed.
 */

const RELEASES_RAW_URL =
  "https://raw.githubusercontent.com/LiveBench/new-livebench/main/src/lib/constants.js";
const GHPAGES_LISTING_URL =
  "https://api.github.com/repos/LiveBench/new-livebench/contents?ref=gh-pages";

const SOURCE_CHAIN = [
  { label: "livebench.ai", base: "https://livebench.ai", cacheBust: true },
  {
    label: "new-livebench gh-pages",
    base: "https://raw.githubusercontent.com/LiveBench/new-livebench/gh-pages",
    cacheBust: false
  },
  {
    label: "new-livebench main",
    base: "https://raw.githubusercontent.com/LiveBench/new-livebench/main/public",
    cacheBust: false
  },
  {
    label: "livebench.github.io main",
    base: "https://raw.githubusercontent.com/LiveBench/livebench.github.io/main/public",
    cacheBust: false
  }
] as const;

const TABLE_FILE = /^table_(\d{4}_\d{2}_\d{2})\.csv$/;
const DATE_LITERAL = /["'](\d{4}-\d{2}-\d{2})["']/g;
const TIMEOUT_MS = 30_000;

const listingSchema = z
  .array(z.object({ name: z.string(), type: z.string() }).passthrough())
  .min(1);
const categoriesSchema = z.record(z.string(), z.array(z.string()));

export interface LiveBenchEntry {
  entityKey: string;
  name: string;
  rank: number;
  /** Official overall (mean of category means), rounded to 2 decimals. */
  score: number;
  scoreDisplay: string;
  coding?: number;
  agenticCoding?: number;
}

export interface LiveBenchBoard {
  /** Date of the data actually used (from the served file's Last-Modified). */
  snapshotDate: string;
  /** Official release label the data belongs to, e.g. "2026-06-25". */
  releaseDate: string;
  entries: LiveBenchEntry[];
}

export interface FetchLiveBenchOptions {
  topN?: number;
  /** GitHub token; only raises api.github.com rate limits, never grants access. */
  githubToken?: string;
  fetchFn?: typeof globalThis.fetch;
  logger?: Logger;
}

interface FetchedFile {
  text: string;
  source: string;
  lastModified?: Date;
}

async function httpGetText(
  url: string,
  options: { headers?: Record<string, string>; fetchFn?: typeof globalThis.fetch }
): Promise<FetchedFile> {
  const response = await (options.fetchFn ?? globalThis.fetch)(url, {
    headers: { "user-agent": "aibench-teams-feed/1.0", ...options.headers },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`${url} → ${response.status}`);
  }
  const lastModifiedHeader = response.headers.get("last-modified");
  const lastModified = lastModifiedHeader ? new Date(lastModifiedHeader) : undefined;
  return {
    text: await response.text(),
    source: new URL(url).host,
    lastModified: lastModified !== undefined && !Number.isNaN(lastModified.getTime()) ? lastModified : undefined
  };
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Latest official release: the max over the site's own RELEASES constant and
 * the deployed gh-pages table files. A failed discovery source is skipped
 * with a warning; if every source fails, LiveBench is treated as
 * unavailable. The max is never downgraded to an older known release.
 */
async function discoverLatestRelease(
  options: FetchLiveBenchOptions
): Promise<string> {
  const logger = options.logger;
  const dates = new Set<string>();

  try {
    const { text } = await httpGetText(RELEASES_RAW_URL, { fetchFn: options.fetchFn });
    for (const match of text.matchAll(DATE_LITERAL)) {
      const date = match[1];
      if (date) dates.add(date);
    }
  } catch (error) {
    logger?.warn("livebench RELEASES constant unavailable", errorFields(error));
  }

  try {
    const { text } = await httpGetText(GHPAGES_LISTING_URL, {
      headers: {
        accept: "application/vnd.github+json",
        ...(options.githubToken ? { authorization: `Bearer ${options.githubToken}` } : {})
      },
      fetchFn: options.fetchFn
    });
    for (const entry of listingSchema.parse(parseJson(text, "livebench-gh-pages"))) {
      const date = TABLE_FILE.exec(entry.name)?.[1];
      if (date) dates.add(date.replaceAll("_", "-"));
    }
  } catch (error) {
    logger?.warn("livebench gh-pages listing unavailable", errorFields(error));
  }

  if (dates.size === 0) {
    throw new Error("could not discover the official LiveBench release list");
  }
  return [...dates].sort().at(-1) as string;
}

/**
 * Fetches one release file walking the official source chain in freshness
 * order. Fallbacks only ever relocate the SAME release file; when no source
 * has it, the caller treats LiveBench as unavailable.
 */
async function fetchReleaseFile(
  fileName: string,
  options: FetchLiveBenchOptions
): Promise<FetchedFile> {
  const logger = options.logger;
  // Hourly buster: every run pulls the origin's current bytes, so an
  // in-place update can never sit behind a same-day CDN cache entry.
  const cacheBust = `?v=${new Date().toISOString().slice(0, 13)}`;
  const failures: string[] = [];
  for (const source of SOURCE_CHAIN) {
    const url = `${source.base}/${fileName}${source.cacheBust ? cacheBust : ""}`;
    try {
      const file = await httpGetText(url, { fetchFn: options.fetchFn });
      if (source.label !== SOURCE_CHAIN[0].label) {
        logger?.warn("livebench file served by fallback source", {
          file: fileName,
          source: source.label
        });
      }
      return { ...file, source: source.label };
    } catch (error) {
      failures.push(source.label);
      logger?.warn("livebench source failed", {
        file: fileName,
        source: source.label,
        ...errorFields(error)
      });
    }
  }
  throw new Error(
    `LiveBench release file ${fileName} unavailable from any official source (${failures.join(", ")})`
  );
}

/** Minimal RFC-4180 parser: quoted fields, escaped quotes, CRLF. */

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"') {
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** The site's calculateAverage: mean over task columns with valid values. */
function taskAverage(values: Map<string, string>, columns: string[]): number | undefined {
  const valid = columns
    .map((column) => Number.parseFloat(values.get(column) ?? ""))
    .filter((value) => Number.isFinite(value));
  if (valid.length === 0) return undefined;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function buildEntries(
  rows: string[][],
  categories: Record<string, string[]>,
  topN: number
): LiveBenchEntry[] {
  const header = rows[0];
  if (!header) throw new Error("LiveBench snapshot CSV is empty");
  const categoryNames = Object.keys(categories);
  const candidates: Array<LiveBenchEntry & { overall: number }> = [];
  for (const row of rows.slice(1)) {
    const values = new Map<string, string>();
    header.forEach((column, index) => values.set(column, row[index] ?? ""));
    const model = values.get("model")?.trim();
    if (!model) continue;

    // Official overall: mean of the per-category means. A model missing an
    // entire category has no official overall ('-' on the site) — unrankable.
    const categoryAverages: number[] = [];
    let complete = true;
    for (const category of categoryNames) {
      const tasks = categories[category] ?? [];
      const average = taskAverage(values, tasks);
      if (average === undefined) {
        complete = false;
        break;
      }
      categoryAverages.push(average);
    }
    if (!complete) continue;
    let overall = categoryAverages.reduce((sum, value) => sum + value, 0) / categoryAverages.length;
    overall = Math.round(overall * 100) / 100;
    // The site hardcodes the displayed overall for these two legacy models;
    // replicated so the feed matches the official table byte for byte.
    if (model === "grok-3-thinking") overall = 72;
    if (model === "grok-3") overall = 58;

    candidates.push({
      entityKey: model,
      name: model,
      rank: 0,
      score: overall,
      scoreDisplay: overall.toFixed(2),
      overall,
      coding: taskAverage(values, categories["Coding"] ?? []),
      agenticCoding: taskAverage(values, categories["Agentic Coding"] ?? [])
    });
  }
  candidates.sort((a, b) => b.overall - a.overall || a.name.localeCompare(b.name));
  return candidates.slice(0, topN).map((entry, index) => ({ ...entry, rank: index + 1 }));
}

/**
 * Discovers the newest official release (RELEASES constant + deployed files,
 * max wins), fetches that release's files with the live site first, and
 * scores every model with the site's own category mapping and averaging
 * formula. `snapshotDate` is the date of the data actually used (the served
 * file's Last-Modified), falling back to the release label when absent.
 */
export async function fetchLiveBenchTop(options: FetchLiveBenchOptions = {}): Promise<LiveBenchBoard> {
  const topN = options.topN ?? 10;
  const releaseDate = await discoverLatestRelease(options);
  options.logger?.info("livebench release discovered", { release: releaseDate });

  const [table, categories] = await Promise.all([
    fetchReleaseFile(`table_${releaseDate.replaceAll("-", "_")}.csv`, options),
    fetchReleaseFile(`categories_${releaseDate.replaceAll("-", "_")}.json`, options)
  ]);

  const categoryMap = categoriesSchema.parse(parseJson(categories.text, "livebench-categories"));
  const entries = buildEntries(parseCsvRows(table.text), categoryMap, topN);
  if (entries.length === 0) {
    throw new Error("LiveBench snapshot produced no rankable models");
  }

  const dataDate = table.lastModified ?? categories.lastModified;
  return {
    snapshotDate: dataDate ? isoDay(dataDate) : releaseDate,
    releaseDate,
    entries
  };
}
