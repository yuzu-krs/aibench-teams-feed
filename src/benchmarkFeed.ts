import { compareWithPrevious, type RankComparison } from "ai-benchmark-bot/dist/embeds.js";
import { fetchText, parseJson } from "ai-benchmark-bot/dist/http.js";
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

/**
 * Podium ranks show only the medal (a number after 🥇 is redundant); rank 4+
 * falls back to the plain number.
 */
function rankPrefix(rank: number): string {
  if (rank === 1) return "🥇 ";
  if (rank === 2) return "🥈 ";
  if (rank === 3) return "🥉 ";
  return `${rank}. `;
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
    return `${rankPrefix(entry.rank)}${entry.name}${organization} — ${entry.scoreDisplay}${price} ${deltaText(comparison)}`;
  });
  return [
    "💻 Arena Coding",
    ...(publishDate ? [`データ: ${publishDate} 時点のランキング`] : []),
    ...lines
  ].join("\n");
}

function renderLiveBenchSection(board: LiveBenchBoard, comparisons: RankComparison[]): string {
  const byKey = new Map(comparisons.map((comparison) => [comparison.entry.entityKey, comparison]));
  const lines = board.entries.map((entry) => {
    const parts = [`${rankPrefix(entry.rank)}${entry.name}`, `— ${entry.scoreDisplay}`];
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
  return ["🧪 LiveBench", `Snapshot: ${board.snapshotDate}`, ...lines].join("\n");
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
    let prices: ReadonlyMap<string, string> | undefined;
    if (catalogSettled.status === "fulfilled") {
      const resolved = resolveRankingPricing(
        catalogSettled.value,
        entries.map((entry) => entry.name)
      );
      // Effort-tier names often have no separate OpenRouter listing; they
      // share the base listing's unit price, so resolve those feed-side.
      const merged = new Map(resolved);
      for (const entry of entries) {
        if (!merged.has(entry.name)) {
          const price = effortTierPrice(catalogSettled.value, entry.name);
          if (price !== undefined) merged.set(entry.name, price);
        }
      }
      prices = merged;
    }
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

  // Legend first (what the reader needs), then the data-source attributions
  // compressed into one line — every element CC BY 4.0 requires (source,
  // dataset, license, modification notice) plus the LiveBench/OpenRouter
  // credits survives; the detailed links live in the README.
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
