/** Which feed an item belongs to; also the suffix of its cache file. */
export type FeedId = "new-model" | "benchmark";

/**
 * One RSS item, frozen at first creation: the GUID, pubDate, and body never
 * change afterwards, so re-detection or regeneration can never re-notify
 * Power Automate.
 */
export interface FeedItem {
  /** Stable URN; the dedup key for Power Automate and for our own merge. */
  guid: string;
  title: string;
  link: string;
  /** RFC-822 GMT, frozen at creation: "Fri, 12 Sep 2026 07:17:00 GMT". */
  pubDate: string;
  /** Plain text with \n newlines; frozen at creation. */
  description: string;
  /** ISO-8601 creation instant; the ordering and trimming key. */
  createdAt: string;
}

export interface FeedItemsFile {
  /** Newest first; length within the feed's retention cap. */
  items: FeedItem[];
}
