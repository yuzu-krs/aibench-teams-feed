import {
  buildBoardValue,
  compareWithPrevious,
  type RankComparison
} from "ai-benchmark-bot/dist/embeds.js";
import { errorFields, type Logger } from "ai-benchmark-bot/dist/logger.js";
import { fetchLmArenaTop } from "ai-benchmark-bot/dist/lmarena.js";
import {
  fetchOpenRouterModels,
  formatPriceDisplay,
  resolveRankingPricing,
  type OpenRouterCatalog
} from "ai-benchmark-bot/dist/openrouter.js";
import { StateStore } from "ai-benchmark-bot/dist/state.js";
import {
  formatLocalDate,
  formatLocalDateTime,
  localDateKey,
  localHourMinute
} from "ai-benchmark-bot/dist/time.js";
import type { RankedModel } from "ai-benchmark-bot/dist/types.js";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { feedItemsPath } from "./feeds.js";
import {
  loadFeedItems,
  loadRankingSnapshot,
  mergeFeedItems,
  saveFeedItems,
  saveRankingSnapshot,
  type RankingSnapshotFile
} from "./feedStore.js";
import { fetchLiveBenchTop, type LiveBenchBoard } from "./livebench.js";
import type { FeedDeps } from "./newModelFeed.js";
import { toRfc822 } from "./rssBuilder.js";
import type { FeedItem } from "./types.js";

const TOP_N = 10;

/** Single-topic legend lines — Teams reads plain text, one note per line. */
const FOOTER_MOVEMENT = "⬆️ 上昇 · ⬇️ 下降 · ➖ 変動なし";
const FOOTER_PRICE = "💰 入力/出力 $/1Mトークン";

/**
 * The Benchmark digest serves exactly two boards, chosen for GHC coding-model
 * selection: LMArena Coding (the official lmarena-ai/leaderboard-dataset's
 * webdev split — the same source the bot uses, never the Arena website) and
 * LiveBench (the project's officially published snapshot CSV, scored with the
 * site's own aggregation formula). Both sections are rendered with the bot's
 * own rank-line renderer, so the digest looks exactly like the bot's Discord
 * posts. Arena Overall, MMLU-Pro, and Artificial Analysis are deliberately
 * not part of this feed; AA data is never redistributed through the public
 * RSS (see README, Data Sources).
 */

/**
 * LMArena Coding keeps the pre-existing snapshot file name, so snapshots
 * seeded from the home server or earlier runs still line up for deltas.
 */
const ARENA_SNAPSHOT_FILE = "lmarena-coding.json";
const LIVEBENCH_SNAPSHOT_FILE = "livebench.json";

export type BenchmarkBoardId = "lmarena-coding" | "livebench";
export type BenchmarkStatus = "posted" | "skipped-before-digest" | "skipped-already-posted";

export interface BenchmarkFeedResult {
  dateKey: string;
  status: BenchmarkStatus;
  boards: Partial<Record<BenchmarkBoardId, "ok" | "failed">>;
  itemsAdded: number;
}

/**
 * The once-per-day gate, mirroring the bot's scheduler: at or after the
 * digest time in the configured zone, and no digest recorded for today's
 * dateKey. A failed run never records the day, so the next hourly run
 * retries it — cron misses and outages self-heal. Keeping the whole gate in
 * one predicate is also the future hook for a weekdays-only switch.
 */
export function shouldRunBenchmark(now: Date, config: AppConfig, store: StateStore): boolean {
  const { hour, minute } = localHourMinute(now, config.timeZone);
  if (hour * 60 + minute < config.digestHour * 60 + config.digestMinute) return false;
  return store.loadLastPosted()?.dateKey !== localDateKey(now, config.timeZone);
}

/**
 * Suffixes that mark a thinking-effort setting. Effort levels share the base
 * listing's per-token unit price, so a board name ending in one of these can
 * be priced from the base model when the tier itself is not listed.
 */
const EFFORT_TOKENS = [
  "max-effort",
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "effort",
  "thinking"
];

function baseNameCandidates(name: string): string[] {
  const candidates: string[] = [];
  let current = name.toLowerCase();
  for (;;) {
    const token = EFFORT_TOKENS.find((suffix) => current.endsWith(`-${suffix}`));
    if (!token) break;
    current = current.slice(0, current.length - token.length - 1);
    if (current) candidates.push(current);
  }
  return candidates;
}

/**
 * Resolves prices for effort-tier names ("-max", "-xhigh", …) that OpenRouter
 * carries only as the base model: effort levels share the base listing's
 * unit price. ":batch"/":free"-style listings price differently and are
 * excluded. Feed-side only — the bot's own matcher stays conservative so
 * Discord never gains this inference.
 */
export function effortTierPrice(catalog: OpenRouterCatalog, name: string): string | undefined {
  for (const base of baseNameCandidates(name)) {
    const matches = catalog.models.filter(
      (model) => !model.id.includes(":") && model.bareSlug === base
    );
    const best = matches.sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0];
    if (!best) continue;
    return formatPriceDisplay(best);
  }
  return undefined;
}

/**
 * The bot's conservative matcher first, then effort-tier resolution for the
 * names it could not price (see effortTierPrice).
 */
function boardPrices(catalog: OpenRouterCatalog, entries: RankedModel[]): ReadonlyMap<string, string> {
  const merged = new Map(
    resolveRankingPricing(
      catalog,
      entries.map((entry) => entry.name)
    )
  );
  for (const entry of entries) {
    if (!merged.has(entry.name)) {
      const price = effortTierPrice(catalog, entry.name);
      if (price !== undefined) merged.set(entry.name, price);
    }
  }
  return merged;
}

/**
 * Builds the daily digest from the two GHC-selection boards, rendering every
 * section with the bot's own rank-line renderer so the digest looks exactly
 * like the bot's Discord posts. The boards fail independently: whichever
 * succeeds is published, a failed board renders a single unavailability line
 * and keeps its previous snapshot. Only when BOTH fail does the run throw —
 * no item, no day recorded — so Teams never receives an empty card and the
 * day stays retryable.
 */
export async function runBenchmarkFeed(
  deps: FeedDeps & { force?: boolean }
): Promise<BenchmarkFeedResult> {
  const { config, store, logger } = deps;
  const now = deps.now?.() ?? new Date();
  const dateKey = localDateKey(now, config.timeZone);
  if (!deps.force && !shouldRunBenchmark(now, config, store)) {
    const alreadyPosted = store.loadLastPosted()?.dateKey === dateKey;
    return {
      dateKey,
      status: alreadyPosted ? "skipped-already-posted" : "skipped-before-digest",
      boards: {},
      itemsAdded: 0
    };
  }

  // Boards and the pricing catalog resolve fully in parallel and fail
  // independently; a catalog failure only drops prices, never the digest.
  const [arenaSettled, liveSettled, catalogSettled] = await Promise.allSettled([
    fetchLmArenaTop("coding", {
      topN: TOP_N,
      logger,
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {}),
      ...(config.huggingFaceToken ? { token: config.huggingFaceToken } : {})
    }),
    fetchLiveBenchTop({
      topN: TOP_N,
      logger,
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      ...(config.githubToken ? { githubToken: config.githubToken } : {})
    }),
    fetchOpenRouterModels({
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      logger,
      ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {})
    })
  ]);

  if (arenaSettled.status === "rejected" && liveSettled.status === "rejected") {
    throw new Error("both LMArena Coding and LiveBench failed; digest not published");
  }

  const savedAt = now.toISOString();
  const sectionBlocks: string[] = [];
  const boardStatus: BenchmarkFeedResult["boards"] = {};

  if (arenaSettled.status === "fulfilled") {
    const entries: RankedModel[] = arenaSettled.value;
    const previous: RankingSnapshotFile | undefined = loadRankingSnapshot(
      join(config.stateDir, ARENA_SNAPSHOT_FILE)
    );
    const prices =
      catalogSettled.status === "fulfilled"
        ? boardPrices(catalogSettled.value, entries)
        : undefined;
    const comparisons = compareWithPrevious(entries, previous, prices);
    sectionBlocks.push(`💻 LMArena Coding\n${buildBoardValue(comparisons)}`);
    boardStatus["lmarena-coding"] = "ok";
    // Persist only after a clean render, mirroring the bot's save-after-send.
    saveRankingSnapshot(join(config.stateDir, ARENA_SNAPSHOT_FILE), { savedAt, entries });
  } else {
    logger.warn(
      "LMArena Coding unavailable; publishing digest without it",
      errorFields(arenaSettled.reason)
    );
    sectionBlocks.push("💻 LMArena Coding\n⚠️ LMArena Coding: unavailable");
    boardStatus["lmarena-coding"] = "failed";
  }

  if (liveSettled.status === "fulfilled") {
    const board: LiveBenchBoard = liveSettled.value;
    const previous: RankingSnapshotFile | undefined = loadRankingSnapshot(
      join(config.stateDir, LIVEBENCH_SNAPSHOT_FILE)
    );
    const prices =
      catalogSettled.status === "fulfilled"
        ? boardPrices(catalogSettled.value, board.entries)
        : undefined;
    const comparisons = compareWithPrevious(board.entries, previous, prices);
    sectionBlocks.push(
      `🧪 LiveBench\nSnapshot: ${board.snapshotDate}\n${buildBoardValue(comparisons)}`
    );
    boardStatus["livebench"] = "ok";
    saveRankingSnapshot(join(config.stateDir, LIVEBENCH_SNAPSHOT_FILE), {
      savedAt,
      snapshotDate: board.snapshotDate,
      releaseDate: board.releaseDate,
      entries: board.entries
    });
  } else {
    logger.warn(
      "LiveBench unavailable; publishing digest without it",
      errorFields(liveSettled.reason)
    );
    sectionBlocks.push("🧪 LiveBench\n⚠️ LiveBench: unavailable");
    boardStatus["livebench"] = "failed";
  }

  // Official attributions compressed into one line — every element CC BY 4.0
  // requires (source, dataset, license, modification notice) plus the
  // LiveBench/OpenRouter credits survives; the detailed links live in the
  // README.
  const footerLines = [
    FOOTER_MOVEMENT,
    FOOTER_PRICE,
    "📊 出典: Arena lmarena-ai/leaderboard-dataset (CC BY 4.0, RSS用に再フォーマット) · LiveBench (Apache 2.0) · 価格: openrouter.ai"
  ];
  const description = [
    `📅 ${formatLocalDate(now, config.timeZone)}\n🕒 取得: ${formatLocalDateTime(now, config.timeZone)}`,
    sectionBlocks.join("\n\n"),
    footerLines.join("\n")
  ].join("\n\n");

  const item: FeedItem = {
    guid: `urn:aibench:benchmark:${dateKey}`,
    title: `📊 Benchmark Daily — ${formatLocalDate(now, config.timeZone)}`,
    link: config.feedBaseUrl,
    pubDate: toRfc822(now),
    description,
    createdAt: savedAt
  };
  const file = feedItemsPath(config.stateDir, "benchmark");
  const existing = loadFeedItems(file);
  const itemsAdded = existing.some((cached) => cached.guid === item.guid) ? 0 : 1;
  saveFeedItems(file, mergeFeedItems(existing, [item], config.benchmarkMaxItems));
  store.saveLastPosted(dateKey, savedAt);

  return { dateKey, status: "posted", boards: boardStatus, itemsAdded };
}
