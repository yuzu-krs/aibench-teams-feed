import { buildRankedBoards, ALL_RANKING_BOARDS } from "ai-benchmark-bot/dist/boards.js";
import { buildBoardValue, compareWithPrevious } from "ai-benchmark-bot/dist/embeds.js";
import { errorFields, type Logger } from "ai-benchmark-bot/dist/logger.js";
import { fetchOpenRouterModels, resolveRankingPricing } from "ai-benchmark-bot/dist/openrouter.js";
import { StateStore } from "ai-benchmark-bot/dist/state.js";
import {
  formatLocalDate,
  formatLocalDateTime,
  localDateKey,
  localHourMinute
} from "ai-benchmark-bot/dist/time.js";
import type { RankedModel, RankingBoard } from "ai-benchmark-bot/dist/types.js";
import type { RankedBoardSpec } from "ai-benchmark-bot/dist/boards.js";
import type { AppConfig } from "./config.js";
import { feedItemsPath } from "./feeds.js";
import { loadFeedItems, mergeFeedItems, saveFeedItems } from "./feedStore.js";
import type { FeedDeps } from "./newModelFeed.js";
import { toRfc822 } from "./rssBuilder.js";
import type { FeedItem } from "./types.js";

/** Same failure line as the bot's embeds (its constant is not exported). */
const NO_RANKING_MESSAGE = "⚠️ ランキングを取得できませんでした。";
/** Legend split into short lines — Teams reads plain text, one topic per line. */
const FOOTER_MOVEMENT = "⬆️ 上昇 · ⬇️ 下降 · ➖ 変動なし";
const FOOTER_PRICE = "💰 入力/出力 $/1Mトークン";

export type BenchmarkStatus = "posted" | "skipped-before-digest" | "skipped-already-posted";

export interface BenchmarkFeedResult {
  dateKey: string;
  status: BenchmarkStatus;
  boards: Partial<Record<RankingBoard, "ok" | "failed">>;
  skipped: readonly RankingBoard[];
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

/** Bare-host credit; the bot's private creditHost rendered for plain text. */
function creditHost(url: string): string {
  return url.replace(/^https:\/\/(www\.)?/, "").replace(/\/+$/, "");
}

/**
 * Builds the daily digest through the bot's ranking pieces (fetch, compare,
 * price, render). Unlike the bot's runDailyRanking, an all-boards-failed run
 * throws WITHOUT recording the day or publishing an item: Teams never
 * receives a "could not fetch" card, and the day stays retryable. A run with
 * at least one successful board publishes; failed boards show the failure
 * line and keep their previous snapshot for the next comparison.
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
      skipped: [],
      itemsAdded: 0
    };
  }

  const { boards, embedMeta } = buildRankedBoards({
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
    logger,
    ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {}),
    ...(config.huggingFaceToken ? { huggingFaceToken: config.huggingFaceToken } : {}),
    ...(config.aaApiKey ? { aaApiKey: config.aaApiKey } : {})
  });
  const runnable = new Set(boards.map((board) => board.board));
  const skipped = ALL_RANKING_BOARDS.filter((board) => !runnable.has(board));

  // Boards and the pricing catalog resolve in parallel. Board failures are
  // isolated per board; a catalog failure only drops prices, never the digest.
  const [boardResults, catalog] = await Promise.all([
    Promise.allSettled(boards.map((board) => board.fetch())),
    fetchOpenRouterModels({
      ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      logger,
      ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {})
    }).catch((error: unknown) => {
      logger.warn("OpenRouter pricing unavailable; publishing digest without prices", errorFields(error));
      return undefined;
    })
  ]);

  const fetched: Array<{ spec: RankedBoardSpec; entries: RankedModel[] }> = [];
  for (const [index, spec] of boards.entries()) {
    const result = boardResults[index];
    if (result?.status === "fulfilled") fetched.push({ spec, entries: result.value });
  }
  if (fetched.length === 0) {
    throw new Error(`all ${boards.length} ranking boards failed; digest not published`);
  }

  const prices = catalog
    ? resolveRankingPricing(
        catalog,
        fetched.flatMap(({ entries }) => entries.map((entry) => entry.name))
      )
    : undefined;

  const savedAt = now.toISOString();
  const entriesBySpec = new Map(fetched.map((entry) => [entry.spec, entry.entries]));
  const sectionBlocks: string[] = [];
  const boardStatus: Partial<Record<RankingBoard, "ok" | "failed">> = {};
  for (const spec of boards) {
    const entries = entriesBySpec.get(spec);
    if (!entries) {
      sectionBlocks.push(`${spec.emoji} ${spec.displayName}\n${NO_RANKING_MESSAGE}`);
      boardStatus[spec.board] = "failed";
      continue;
    }
    const comparisons = compareWithPrevious(entries, store.loadRanking(spec.board), prices);
    sectionBlocks.push(`${spec.emoji} ${spec.displayName}\n${buildBoardValue(comparisons)}`);
    boardStatus[spec.board] = "ok";
    // Persist only after a clean render, mirroring the bot's save-after-send.
    store.saveRanking(spec.board, entries, savedAt);
  }

  const meta = await embedMeta();
  const footerLines = [
    ...(meta.aa ? ["🧠 AA指数 0-100", `データ: ${creditHost(meta.aa.attributionUrl)}`] : []),
    FOOTER_MOVEMENT,
    FOOTER_PRICE
  ];
  const description = [
    `📅 ${formatLocalDate(now, config.timeZone)}\n🕒 Updated: ${formatLocalDateTime(now, config.timeZone)}`,
    sectionBlocks.join("\n\n"),
    footerLines.join("\n")
  ].join("\n\n");

  const item: FeedItem = {
    guid: `urn:aibench:benchmark:${dateKey}`,
    title: `📊 AI Benchmark Daily — ${formatLocalDate(now, config.timeZone)}`,
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

  return { dateKey, status: "posted", boards: boardStatus, skipped, itemsAdded };
}
