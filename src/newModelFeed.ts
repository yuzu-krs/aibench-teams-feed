import { pollNewModelAlerts } from "ai-benchmark-bot/dist/alerts.js";
import type { ProviderSource } from "ai-benchmark-bot/dist/announcements/index.js";
import { truncateText } from "ai-benchmark-bot/dist/embeds.js";
import {
  formatLocalDate,
  formatLocalDateTime,
  localDateKey,
  localHourMinute
} from "ai-benchmark-bot/dist/time.js";
import type { Logger } from "ai-benchmark-bot/dist/logger.js";
import { StateStore } from "ai-benchmark-bot/dist/state.js";
import type { NewModelAnnouncement } from "ai-benchmark-bot/dist/types.js";
import type { AppConfig } from "./config.js";
import {
  feedItemsPath,
  newModelLastPostedPath,
  newModelPendingPath,
  regenerateFeedXml
} from "./feeds.js";
import {
  loadFeedItems,
  loadLastPosted,
  mergeFeedItems,
  saveFeedItems,
  saveLastPosted
} from "./feedStore.js";
import { toRfc822 } from "./rssBuilder.js";
import type { FeedItem } from "./types.js";

/** Mirrors the bot embed's summary cap so RSS and Discord stay in step. */
const SUMMARY_LIMIT = 1000;

/** Credits the OpenRouter prices shown on 💰 lines (see README, Data Sources). */
const FOOTER_PRICE = "💰 価格: openrouter.ai";

export interface FeedDeps {
  config: AppConfig;
  store: StateStore;
  logger: Logger;
  /** Overrides the polled announcement sources (tests inject fakes). */
  sources?: readonly ProviderSource[];
  fetchFn?: typeof globalThis.fetch;
  now?: () => Date;
  retryDelayMs?: number;
}

export type NewModelStatus = "posted" | "skipped-before-digest" | "skipped-already-posted";

export interface NewModelFeedResult {
  dateKey: string;
  status: NewModelStatus;
  /** Alerts the send callback received this run (0 on a quiet/baseline poll). */
  alerts: number;
  /** Model blocks in the published card; 0 while skipped or on an empty day. */
  models: number;
}

export function newModelGuid(providerId: string, modelId: string): string {
  return `urn:aibench:new-model:${providerId}:${modelId}`;
}

/** The daily card's GUID — one card per JST day, benchmark-style. */
export function newModelDailyGuid(dateKey: string): string {
  return `urn:aibench:new-model:${dateKey}`;
}

/**
 * One announcement becomes one block per model — the same unit the bot's
 * seen-models dedup uses, which makes the GUID a natural, forever-stable
 * pending key (`urn:aibench:new-model:<providerId>:<modelId>`). Blocks are
 * the raw material of the daily card; the per-model GUID never reaches the
 * published feed.
 */
export function alertToFeedItems(alert: NewModelAnnouncement, timeZone: string): FeedItem[] {
  const detectedAt = new Date(alert.detectedAt);
  return alert.modelIds.map((modelId) => {
    const price = alert.pricingByModel?.[modelId];
    const lines = [
      `🏢 ${alert.providerName}`,
      `🧠 ${modelId}`,
      `📝 ${truncateText(alert.summary ?? "（概要なし）", SUMMARY_LIMIT)}`,
      ...(price
        ? [
            `💰 ${price.priceDisplay}${price.contextDisplay !== undefined ? ` · ${price.contextDisplay}` : ""}`
          ]
        : []),
      `🕒 ${formatLocalDateTime(detectedAt, timeZone)}`
    ];
    return {
      guid: newModelGuid(alert.providerId, modelId),
      title: `🚀 New Model: ${modelId} · ${alert.providerName}`,
      link: alert.url,
      pubDate: toRfc822(detectedAt),
      description: lines.join("\n"),
      createdAt: alert.detectedAt
    };
  });
}

/**
 * The once-per-day gate, mirroring shouldRunBenchmark: at or after the
 * digest time in the configured zone, and no card recorded for today's
 * dateKey. A failed run never records the day, so the next hourly run
 * retries it — cron misses and outages self-heal.
 */
export function shouldRunNewModel(now: Date, config: AppConfig): boolean {
  const { hour, minute } = localHourMinute(now, config.timeZone);
  if (hour * 60 + minute < config.digestHour * 60 + config.digestMinute) return false;
  return (
    loadLastPosted(newModelLastPostedPath(config.stateDir))?.dateKey !==
    localDateKey(now, config.timeZone)
  );
}

/**
 * Combines the day's pending model blocks into one benchmark-style card.
 * `pending` arrives newest-first from mergeFeedItems; each block is the
 * per-model rendering of alertToFeedItems.
 */
export function buildDailyCard(
  pending: readonly FeedItem[],
  now: Date,
  config: AppConfig
): FeedItem {
  const savedAt = now.toISOString();
  const blocks = pending.map((item) => item.description);
  const description = [
    `📅 ${formatLocalDate(now, config.timeZone)}\n🕒 取得: ${formatLocalDateTime(now, config.timeZone)}`,
    `🚀 本日の新モデル: ${blocks.length}件`,
    [...blocks, FOOTER_PRICE].join("\n\n")
  ].join("\n\n");
  return {
    guid: newModelDailyGuid(localDateKey(now, config.timeZone)),
    title: `🚀 New Model — ${formatLocalDate(now, config.timeZone)}`,
    link: config.feedBaseUrl,
    pubDate: toRfc822(now),
    description,
    createdAt: savedAt
  };
}

/** Counts model blocks (each has exactly one 🏢 heading line). */
function countModelBlocks(description: string): number {
  return description.match(/^🏢 /gm)?.length ?? 0;
}

/**
 * Polls every provider through the bot's alert pipeline and accumulates the
 * day's detections in new-model-pending.json — the RSS is never touched
 * mid-day, so Power Automate (polling once daily) cannot see partial batch.
 * At the first run at/after the digest time (06:17 JST with the hourly
 * cron) the pending batch is published as ONE benchmark-style card — a
 * single-item feed with GUID `urn:aibench:new-model:<YYYY-MM-DD>`; a day
 * with zero pending models publishes an item-less, still-valid RSS and
 * still records the day. Teams delivery happens at the PA flow's daily
 * recurrence (~07:00 JST).
 *
 * Persistent dedup lives solely in the bot's seen-models.json. The send
 * callback persists the pending batch write-through: if saving throws, the
 * bot leaves the models unseen and the next run re-detects and re-merges
 * (mergeFeedItems keeps the frozen first record).
 *
 * Publication order matters: card cache → XML → pending clear → day
 * recorded LAST, mirroring the benchmark so a failed run stays retryable.
 * The one loss window is between the pending clear and the day record —
 * the recovery branch below detects exactly that state (empty pending +
 * today's card already cached) and re-records the day around the cached
 * card, whose models are already seen and thus unrecoverable by re-polling.
 */
export async function runNewModelFeed(
  deps: FeedDeps & { force?: boolean }
): Promise<NewModelFeedResult> {
  const { config, store, logger } = deps;
  const pendingFile = newModelPendingPath(config.stateDir);
  const cacheFile = feedItemsPath(config.stateDir, "new-model");
  const lastPostedFile = newModelLastPostedPath(config.stateDir);
  const now = deps.now?.() ?? new Date();
  const dateKey = localDateKey(now, config.timeZone);

  const alerts = await pollNewModelAlerts({
    timeZone: config.timeZone,
    store,
    logger,
    send: async (_embed, alert) => {
      const incoming = alertToFeedItems(alert, config.timeZone);
      saveFeedItems(
        pendingFile,
        mergeFeedItems(loadFeedItems(pendingFile), incoming, config.newModelMaxItems)
      );
    },
    ...(deps.sources ? { sources: deps.sources } : {}),
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {})
  });

  if (!deps.force && !shouldRunNewModel(now, config)) {
    const alreadyPosted = loadLastPosted(lastPostedFile)?.dateKey === dateKey;
    return {
      dateKey,
      status: alreadyPosted ? "skipped-already-posted" : "skipped-before-digest",
      alerts,
      models: 0
    };
  }

  const savedAt = now.toISOString();
  const pending = loadFeedItems(pendingFile);
  const dailyGuid = newModelDailyGuid(dateKey);
  const cachedCard = loadFeedItems(cacheFile).find((item) => item.guid === dailyGuid);

  // Recovery for the loss window described above: pending already cleared,
  // day not yet recorded. The cached card is the only copy of the batch.
  if (pending.length === 0 && cachedCard) {
    regenerateFeedXml(config, "new-model");
    saveLastPosted(lastPostedFile, dateKey, savedAt);
    return {
      dateKey,
      status: "posted",
      alerts,
      models: countModelBlocks(cachedCard.description)
    };
  }

  const item = pending.length > 0 ? buildDailyCard(pending, now, config) : undefined;
  saveFeedItems(cacheFile, item ? [item] : []);
  regenerateFeedXml(config, "new-model");
  saveFeedItems(pendingFile, []);
  saveLastPosted(lastPostedFile, dateKey, savedAt);

  return { dateKey, status: "posted", alerts, models: pending.length };
}
