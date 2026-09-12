import { pollNewModelAlerts } from "ai-benchmark-bot/dist/alerts.js";
import type { ProviderSource } from "ai-benchmark-bot/dist/announcements/index.js";
import { truncateText } from "ai-benchmark-bot/dist/embeds.js";
import { formatLocalDateTime } from "ai-benchmark-bot/dist/time.js";
import type { Logger } from "ai-benchmark-bot/dist/logger.js";
import { StateStore } from "ai-benchmark-bot/dist/state.js";
import type { NewModelAnnouncement } from "ai-benchmark-bot/dist/types.js";
import type { AppConfig } from "./config.js";
import { feedItemsPath, regenerateFeedXml } from "./feeds.js";
import { mergeFeedItems, saveFeedItems } from "./feedStore.js";
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
 * Polls every provider through the bot's alert pipeline and publishes
 * new-model.xml as a DELTA feed: it carries exactly the models this run
 * detected and is replaced wholesale on the next run — a run with zero fresh
 * models publishes an item-less, still-valid RSS. Persistent dedup lives
 * solely in the bot's seen-models.json; the feed itself is ephemeral.
 *
 * The send callback persists the accumulated delta write-through: if saving
 * throws, the bot leaves the models unseen and the next run re-detects and
 * replaces the delta (its documented contract). The XML is regenerated
 * immediately after the poll returns — the bot persists seen-models at that
 * point, so a crash before the XML write would otherwise lose the run's
 * notifications for good.
 */
export async function runNewModelFeed(deps: FeedDeps): Promise<NewModelFeedResult> {
  const { config, store, logger } = deps;
  const file = feedItemsPath(config.stateDir, "new-model");
  const delta: FeedItem[] = [];
  let itemsAdded = 0;
  let detected = false;
  const alerts = await pollNewModelAlerts({
    timeZone: config.timeZone,
    store,
    logger,
    send: async (_embed, alert) => {
      detected = true;
      const incoming = alertToFeedItems(alert, config.timeZone);
      delta.push(...incoming);
      saveFeedItems(file, mergeFeedItems([], delta, config.newModelMaxItems));
      itemsAdded = delta.length;
    },
    ...(deps.sources ? { sources: deps.sources } : {}),
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {})
  });
  if (!detected) {
    // Zero fresh models (or a baseline run): clear any stale delta so the
    // feed never carries items from a previous run.
    saveFeedItems(file, []);
  }
  regenerateFeedXml(config, "new-model");
  return { alerts, itemsAdded };
}
