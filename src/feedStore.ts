import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { FeedItem, FeedItemsFile } from "./types.js";

const snapshotEntrySchema = z
  .object({
    entityKey: z.string().min(1),
    name: z.string(),
    rank: z.number().int(),
    score: z.number(),
    scoreDisplay: z.string()
  })
  .passthrough();

const rankingSnapshotSchema = z.object({
  savedAt: z.string().min(1),
  snapshotDate: z.string().min(1).optional(),
  entries: z.array(snapshotEntrySchema)
});

export type SnapshotEntry = z.infer<typeof snapshotEntrySchema>;
export type RankingSnapshotFile = z.infer<typeof rankingSnapshotSchema>;

/** Write-side shape: structural so bot RankedModel[] and LiveBench entries fit. */
export interface RankingSnapshotInput {
  savedAt: string;
  snapshotDate?: string;
  entries: ReadonlyArray<{
    entityKey: string;
    name: string;
    rank: number;
    score: number;
    scoreDisplay: string;
    organization?: string;
    coding?: number;
    agenticCoding?: number;
  }>;
}

/**
 * Loads a board ranking snapshot (same shape as the bot's RankingSnapshot
 * plus an optional official snapshotDate). A missing file is a baseline;
 * a corrupt one throws.
 */
export function loadRankingSnapshot(file: string): RankingSnapshotFile | undefined {
  if (!existsSync(file)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Snapshot file ${file} could not be read`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Snapshot file ${file} is corrupt; fix or restore it before running`, {
      cause: error
    });
  }
  return rankingSnapshotSchema.parse(parsed);
}

/** Atomic tmp+rename write, mirroring the bot's StateStore. */
export function saveRankingSnapshot(file: string, snapshot: RankingSnapshotInput): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}

const feedItemSchema = z.object({
  guid: z.string().min(1),
  title: z.string(),
  link: z.string(),
  pubDate: z.string().min(1),
  description: z.string(),
  createdAt: z.string().min(1)
});

const feedItemsFileSchema = z.object({ items: z.array(feedItemSchema) });

/**
 * Loads a feed-items cache. A missing file is an empty feed; a corrupt one
 * throws so a bad state never silently republishes.
 */
export function loadFeedItems(file: string): FeedItem[] {
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Feed state file ${file} could not be read`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Feed state file ${file} is corrupt; fix or restore it before running`, {
      cause: error
    });
  }
  return feedItemsFileSchema.parse(parsed).items;
}

/** Atomic tmp+rename write, mirroring the bot's StateStore. */
export function saveFeedItems(file: string, items: FeedItem[]): void {
  const payload: FeedItemsFile = { items };
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}

/**
 * Merges incoming items into the cache. A GUID that already exists keeps the
 * stored record untouched — content and pubDate are frozen at first creation,
 * so a retry that re-detects the same model changes nothing. New GUIDs append;
 * the result is sorted newest-first (guid as deterministic tiebreak) and
 * capped at `cap`. This merge is what makes every run idempotent.
 */
export function mergeFeedItems(
  existing: FeedItem[],
  incoming: readonly FeedItem[],
  cap: number
): FeedItem[] {
  const byGuid = new Map(existing.map((item) => [item.guid, item]));
  for (const item of incoming) {
    if (!byGuid.has(item.guid)) byGuid.set(item.guid, item);
  }
  return [...byGuid.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.guid.localeCompare(b.guid))
    .slice(0, Math.max(0, cap));
}
