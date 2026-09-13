import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { loadFeedItems } from "./feedStore.js";
import { buildRssXml, writeRssIfChanged } from "./rssBuilder.js";
import type { FeedId } from "./types.js";

/** Static per-feed metadata: published file name and RSS channel header. */
const FEED_SPECS: Record<FeedId, { fileName: string; title: string; description: string }> = {
  "new-model": {
    fileName: "new-model.xml",
    title: "AI Bench — 新モデル通知",
    description: "プロバイダー公式の発表から検出した新モデルの通知 (Teams配信) · Source: OpenRouter"
  },
  benchmark: {
    fileName: "benchmark.xml",
    title: "AI Bench — デイリーランキング",
    description: "Arena Coding / LiveBench のデイリーランキング (Teams配信)"
  }
};

export function feedItemsPath(stateDir: string, feedId: FeedId): string {
  return join(stateDir, `feed-items-${feedId}.json`);
}

export function feedXmlPath(rssDir: string, feedId: FeedId): string {
  return join(rssDir, FEED_SPECS[feedId].fileName);
}

/**
 * Regenerates one feed's XML from its item cache, writing only on byte
 * changes. Runs for BOTH feeds after every command: a crash after state
 * advanced but before the previous XML write heals on the next run.
 */
export function regenerateFeedXml(config: AppConfig, feedId: FeedId): boolean {
  const spec = FEED_SPECS[feedId];
  const items = loadFeedItems(feedItemsPath(config.stateDir, feedId));
  const xml = buildRssXml(
    { title: spec.title, link: config.feedBaseUrl, description: spec.description },
    items
  );
  return writeRssIfChanged(feedXmlPath(config.rssDir, feedId), xml);
}
