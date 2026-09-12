import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadFeedItems, mergeFeedItems, saveFeedItems } from "../src/feedStore.js";
import { tempDir } from "./helpers.js";
import type { FeedItem } from "../src/types.js";

function item(guid: string, createdAt: string, title = `title of ${guid}`): FeedItem {
  return {
    guid,
    title,
    link: "https://example.com",
    pubDate: "Sat, 12 Sep 2026 07:17:00 GMT",
    description: "description",
    createdAt
  };
}

describe("loadFeedItems", () => {
  it("returns an empty list for a missing file", () => {
    expect(loadFeedItems(`${tempDir("load-")}/feed-items.json`)).toEqual([]);
  });

  it("round-trips through save", () => {
    const file = `${tempDir("round-")}/feed-items.json`;
    saveFeedItems(file, [item("a", "2026-09-12T00:00:00.000Z")]);
    expect(loadFeedItems(file)).toEqual([item("a", "2026-09-12T00:00:00.000Z")]);
  });

  it("throws on corrupt JSON instead of silently emptying the feed", () => {
    const dir = tempDir("corrupt-");
    const file = `${dir}/feed-items.json`;
    writeFileSync(file, "{ not json", "utf8");
    expect(() => loadFeedItems(file)).toThrow(/corrupt/);
  });

  it("throws on schema violations", () => {
    const dir = tempDir("schema-");
    const file = `${dir}/feed-items.json`;
    writeFileSync(file, JSON.stringify({ items: [{ nope: true }] }), "utf8");
    expect(() => loadFeedItems(file)).toThrow();
  });
});

describe("mergeFeedItems", () => {
  it("dedupes by guid and freezes the existing record", () => {
    const existing = [item("a", "2026-09-01T00:00:00.000Z")];
    const incoming = [item("a", "2026-09-12T00:00:00.000Z", "REDETECTED WITH NEW TITLE")];
    const merged = mergeFeedItems(existing, incoming, 10);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe("title of a");
    expect(merged[0]?.createdAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("appends new guids and sorts newest-first with a deterministic tiebreak", () => {
    const existing = [item("old", "2026-09-01T00:00:00.000Z")];
    const incoming = [
      item("new-1", "2026-09-12T00:00:00.000Z"),
      item("new-2", "2026-09-12T00:00:00.000Z")
    ];
    const merged = mergeFeedItems(existing, incoming, 10);
    expect(merged.map((entry) => entry.guid)).toEqual(["new-1", "new-2", "old"]);
  });

  it("trims to the cap keeping the newest", () => {
    const existing = [
      item("a", "2026-09-01T00:00:00.000Z"),
      item("b", "2026-09-02T00:00:00.000Z"),
      item("c", "2026-09-03T00:00:00.000Z")
    ];
    const merged = mergeFeedItems(existing, [item("d", "2026-09-04T00:00:00.000Z")], 2);
    expect(merged.map((entry) => entry.guid)).toEqual(["d", "c"]);
  });
});

describe("saveFeedItems", () => {
  it("creates parent directories and leaves no temp file behind", () => {
    const dir = tempDir("save-");
    const file = `${dir}/nested/feed-items.json`;
    saveFeedItems(file, []);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});
