import { pollNewModelAlerts } from "ai-benchmark-bot/dist/alerts.js";
import type { ProviderSource } from "ai-benchmark-bot/dist/announcements/index.js";
import { truncateText } from "ai-benchmark-bot/dist/embeds.js";
import { formatLocalDateTime } from "ai-benchmark-bot/dist/time.js";
import type { Logger } from "ai-benchmark-bot/dist/logger.js";
import { StateStore } from "ai-benchmark-bot/dist/state.js";
import type { NewModelAnnouncement } from "ai-benchmark-bot/dist/types.js";
import type { AppConfig } from "./config.js";
import { feedItemsPath } from "./feeds.js";
import { loadFeedItems, mergeFeedItems, saveFeedItems } from "./feedStore.js";
import { toRfc822 } from "./rssBuilder.js";
import type { FeedItem } from "./types.js";

/** Mirrors the bot embed's summary cap so RSS and Discord stay in step. */
const SUMMARY_LIMIT = 1000;

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

export interface NewModelFeedResult {
  alerts: number;
  itemsAdded: number;
}

export function newModelGuid(providerId: string, modelId: string): string {
  return `urn:aibench:new-model:${providerId}:${modelId}`;
}

/**
 * One announcement becomes one item per model — the same unit the bot's
 * seen-models dedup uses, which makes the GUID a natural, forever-stable key
 * (`urn:aibench:new-model:<providerId>:<modelId>`).
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
 * Polls every provider through the bot's alert pipeline, converting each
 * structured alert into per-model feed items. The send callback persists
 * items write-through: if saving fails, the exception propagates and the bot
 * leaves those models unseen, so the next poll retries the alert (its
 * documented contract). The very first poll only baselines seen-models and
 * produces no items.
 */
export async function runNewModelFeed(deps: FeedDeps): Promise<NewModelFeedResult> {
  const { config, store, logger } = deps;
  const file = feedItemsPath(config.stateDir, "new-model");
  let itemsAdded = 0;
  const alerts = await pollNewModelAlerts({
    timeZone: config.timeZone,
    store,
    logger,
    send: async (_embed, alert) => {
      const incoming = alertToFeedItems(alert, config.timeZone);
      const existing = loadFeedItems(file);
      const known = new Set(existing.map((item) => item.guid));
      const merged = mergeFeedItems(existing, incoming, config.newModelMaxItems);
      saveFeedItems(file, merged);
      itemsAdded += incoming.filter((item) => !known.has(item.guid)).length;
    },
    ...(deps.sources ? { sources: deps.sources } : {}),
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {})
  });
  return { alerts, itemsAdded };
}
