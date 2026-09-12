import { fetchText, parseJson } from "ai-benchmark-bot/dist/http.js";
import type { Logger } from "ai-benchmark-bot/dist/logger.js";
import { z } from "zod";

/**
 * LiveBench leaderboard, sourced from the benchmark project's own published
 * snapshot files (the data behind livebench.ai, served from its public site
 * repository). Scores follow the site's OFFICIAL aggregation formula — the
 * feed never invents its own: a category score is the mean of its task
 * columns' valid values, and the overall is the mean of the category means
 * (a model missing an entire category has no official overall and cannot be
 * ranked).
 */

const SITE_REPO = "LiveBench/livebench.github.io";
const LISTING_URL = `https://api.github.com/repos/${SITE_REPO}/contents/public`;
const RAW_BASE = `https://raw.githubusercontent.com/${SITE_REPO}/main/public`;

const TABLE_FILE = /^table_(\d{4}_\d{2}_\d{2})\.csv$/;

const listingSchema = z
  .array(z.object({ name: z.string(), type: z.string() }).passthrough())
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
  /** Snapshot date from the official file name, e.g. "2026-06-25". */
  snapshotDate: string;
  entries: LiveBenchEntry[];
}

export interface FetchLiveBenchOptions {
  topN?: number;
  /** GitHub token; only raises api.github.com rate limits, never grants access. */
  githubToken?: string;
  fetchFn?: typeof globalThis.fetch;
  logger?: Logger;
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
 * Discovers the newest official snapshot (table_YYYY_MM_DD.csv), then scores
 * every model with the site's own category mapping and averaging formula.
 */
export async function fetchLiveBenchTop(options: FetchLiveBenchOptions = {}): Promise<LiveBenchBoard> {
  const topN = options.topN ?? 10;
  const fetchOptions = { ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}) };
  const listingHeaders = {
    accept: "application/vnd.github+json",
    ...(options.githubToken ? { authorization: `Bearer ${options.githubToken}` } : {})
  };

  const { text: listingText } = await fetchText(LISTING_URL, {
    headers: listingHeaders,
    ...fetchOptions
  });
  const listing = listingSchema.parse(parseJson(listingText, "livebench-listing"));
  const snapshotDate = listing
    .filter((entry) => entry.type === "file")
    .map((entry) => TABLE_FILE.exec(entry.name)?.[1])
    .filter((date): date is string => date !== undefined)
    .sort()
    .at(-1);
  if (!snapshotDate) {
    throw new Error("no official LiveBench table snapshot found in the site repository");
  }

  const [table, categories] = await Promise.all([
    fetchText(`${RAW_BASE}/table_${snapshotDate}.csv`, fetchOptions),
    fetchText(`${RAW_BASE}/categories_${snapshotDate}.json`, fetchOptions)
  ]);
  const categoryMap = categoriesSchema.parse(parseJson(categories.text, "livebench-categories"));
  const entries = buildEntries(parseCsvRows(table.text), categoryMap, topN);
  if (entries.length === 0) {
    throw new Error("LiveBench snapshot produced no rankable models");
  }
  return { snapshotDate: snapshotDate.replaceAll("_", "-"), entries };
}
