import { compareWithPrevious, type RankComparison } from "ai-benchmark-bot/dist/embeds.js";
import { fetchText, parseJson } from "ai-benchmark-bot/dist/http.js";
import { errorFields, type Logger } from "ai-benchmark-bot/dist/logger.js";
import { fetchLmArenaTop } from "ai-benchmark-bot/dist/lmarena.js";
import { fetchOpenRouterModels, resolveRankingPricing } from "ai-benchmark-bot/dist/openrouter.js";
import { StateStore } from "ai-benchmark-bot/dist/state.js";
import {
  formatLocalDate,
  formatLocalDateTime,
  localDateKey,
  localHourMinute
} from "ai-benchmark-bot/dist/time.js";
import type { RankedModel } from "ai-benchmark-bot/dist/types.js";
import { z } from "zod";
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

/**
 * The Benchmark digest serves exactly two boards, chosen for GHC coding-model
 * selection: Arena Coding (the official lmarena-ai/leaderboard-dataset's
 * webdev split — never the Arena website) and LiveBench (the project's
 * officially published snapshot CSV, scored with the site's own aggregation
 * formula). Arena Overall, MMLU-Pro, and Artificial Analysis are deliberately
 * not part of this feed; AA data is never redistributed through the public
 * RSS (see README, Data Sources).
 */

const TOP_N = 10;

/**
 * Arena Coding keeps the pre-existing snapshot file name, so snapshots seeded
 * from the home server or earlier runs still line up for day-over-day deltas.
 */
const ARENA_SNAPSHOT_FILE = "lmarena-coding.json";
const LIVEBENCH_SNAPSHOT_FILE = "livebench.json";

const ARENA_DATE_URL =
  "https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=webdev&split=latest&offset=0&length=1";

const arenaDateResponse = z.object({
  rows: z
    .array(
      z
        .object({
          row: z.object({ leaderboard_publish_date: z.string().optional() }).passthrough()
        })
        .passthrough()
    )
    .min(1)
});

/** Single-topic legend lines — Teams reads plain text, one note per line. */
const FOOTER_MOVEMENT = "⬆️ 上昇 · ⬇️ 下降 · ➖ 変動なし";
const FOOTER_PRICE = "💰 入力/出力 $/1Mトークン";

export type BenchmarkBoardId = "arena-coding" | "livebench";
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

/** The official webdev split's leaderboard_publish_date, from one row. */
async function fetchArenaPublishDate(
  config: AppConfig,
  fetchFn?: typeof globalThis.fetch
): Promise<string | undefined> {
  const { text } = await fetchText(ARENA_DATE_URL, {
    headers: {
      accept: "application/json",
      ...(config.huggingFaceToken ? { authorization: `Bearer ${config.huggingFaceToken}` } : {})
    },
    ...(fetchFn ? { fetchFn } : {})
  });
  const parsed = arenaDateResponse.parse(parseJson(text, "lmarena-webdev-date"));
  return parsed.rows[0]?.row.leaderboard_publish_date;
}

function deltaText(comparison: RankComparison): string {
  if (comparison.isNew) return "🆕 NEW";
  if (comparison.delta === undefined || comparison.delta === 0) return "➖";
  return comparison.delta > 0 ? `⬆️ +${comparison.delta}` : `⬇️ ${comparison.delta}`;
}

function renderArenaSection(
  publishDate: string | undefined,
  comparisons: RankComparison[]
): string {
  const lines = comparisons.map((comparison) => {
    const { entry } = comparison;
    const organization = entry.organization ? ` (${entry.organization})` : "";
    const price = comparison.priceDisplay !== undefined ? ` · ${comparison.priceDisplay}` : "";
    return `${entry.rank}. ${entry.name}${organization} — ${entry.scoreDisplay}${price} ${deltaText(comparison)}`;
  });
  return [
    "=== Arena Coding ===",
    ...(publishDate ? [`データ: ${publishDate} 時点のランキング`] : []),
    ...lines
  ].join("\n");
}

function renderLiveBenchSection(board: LiveBenchBoard, comparisons: RankComparison[]): string {
  const byKey = new Map(comparisons.map((comparison) => [comparison.entry.entityKey, comparison]));
  const lines = board.entries.map((entry) => {
    const parts = [`${entry.rank}. ${entry.name}`, `— ${entry.scoreDisplay}`];
    const detail = [
      entry.coding !== undefined ? `coding ${entry.coding.toFixed(2)}` : undefined,
      entry.agenticCoding !== undefined ? `agentic ${entry.agenticCoding.toFixed(2)}` : undefined
    ]
      .filter((value): value is string => value !== undefined)
      .join(" / ");
    if (detail) parts.push(`(${detail})`);
    const comparison = byKey.get(entry.entityKey);
    if (comparison) parts.push(deltaText(comparison));
    return parts.join(" ");
  });
  return ["=== LiveBench ===", `Snapshot: ${board.snapshotDate}`, ...lines].join("\n");
}

/**
 * Builds the daily digest from the two GHC-selection boards. The boards fail
 * independently: whichever succeeds is published, a failed board renders a
 * single unavailability line and keeps its previous snapshot. Only when BOTH
 * fail does the run throw — no item, no day recorded — so Teams never
 * receives an empty card and the day stays retryable.
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
  const [arenaSettled, dateSettled, liveSettled, catalogSettled] = await Promise.allSettled([
    fetchLmArenaTop("coding", {
      topN: TOP_N,
      logger,
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {}),
      ...(config.huggingFaceToken ? { token: config.huggingFaceToken } : {})
    }),
    fetchArenaPublishDate(config, deps.fetchFn),
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
    throw new Error("both Arena Coding and LiveBench failed; digest not published");
  }
  const publishDate = dateSettled.status === "fulfilled" ? dateSettled.value : undefined;

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
        ? resolveRankingPricing(catalogSettled.value, entries.map((entry) => entry.name))
        : undefined;
    const comparisons = compareWithPrevious(entries, previous, prices);
    sectionBlocks.push(renderArenaSection(publishDate, comparisons));
    boardStatus["arena-coding"] = "ok";
    // Persist only after a clean render, mirroring the bot's save-after-send.
    saveRankingSnapshot(join(config.stateDir, ARENA_SNAPSHOT_FILE), { savedAt, entries });
  } else {
    logger.warn(
      "arena coding unavailable; publishing digest without it",
      errorFields(arenaSettled.reason)
    );
    sectionBlocks.push("=== Arena Coding ===\n⚠️ Arena Coding: unavailable");
    boardStatus["arena-coding"] = "failed";
  }

  if (liveSettled.status === "fulfilled") {
    const board: LiveBenchBoard = liveSettled.value;
    const previous: RankingSnapshotFile | undefined = loadRankingSnapshot(
      join(config.stateDir, LIVEBENCH_SNAPSHOT_FILE)
    );
    const comparisons = compareWithPrevious(board.entries, previous);
    sectionBlocks.push(renderLiveBenchSection(board, comparisons));
    boardStatus["livebench"] = "ok";
    saveRankingSnapshot(join(config.stateDir, LIVEBENCH_SNAPSHOT_FILE), {
      savedAt,
      snapshotDate: board.snapshotDate,
      releaseDate: board.releaseDate,
      entries: board.entries
    });
  } else {
    logger.warn(
      "livebench unavailable; publishing digest without it",
      errorFields(liveSettled.reason)
    );
    sectionBlocks.push("=== LiveBench ===\n⚠️ LiveBench: unavailable");
    boardStatus["livebench"] = "failed";
  }

  // Legend first (what the reader needs), then the official attributions —
  // one "Source:" block per board in digest order (Arena -> LiveBench ->
  // OpenRouter prices), grouped at the very bottom, verbatim per the
  // data-source policy.
  const footerLines = [
    FOOTER_MOVEMENT,
    FOOTER_PRICE,
    "",
    "Source: Arena",
    "Dataset: lmarena-ai/leaderboard-dataset",
    "License: CC BY 4.0",
    "Changes: Ranking data reformatted for RSS.",
    "",
    "Source: LiveBench",
    "License: Apache License 2.0",
    "",
    "Source: OpenRouter",
    "Site: openrouter.ai"
  ];
  const description = [
    `📅 ${formatLocalDate(now, config.timeZone)}\n🕒 Updated: ${formatLocalDateTime(now, config.timeZone)}`,
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
