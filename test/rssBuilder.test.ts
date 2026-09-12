import { describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { buildRssXml, escapeXml, toRfc822, validateRssXml } from "../src/rssBuilder.js";
import type { FeedItem } from "../src/types.js";

const channel = {
  title: "AI Bench — 新モデル通知",
  link: "https://yuzu-krs.github.io/aibench-teams-feed",
  description: "プロバイダー公式の発表から検出した新モデルの通知 (Teams配信)"
};

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    guid: "urn:aibench:new-model:openai:gpt-5.6",
    title: "🚀 New Model: gpt-5.6 · OpenAI",
    link: "https://example.com/launch",
    pubDate: toRfc822(new Date("2026-09-12T07:17:00.000Z")),
    description: ["🏢 OpenAI", "🧠 gpt-5.6", "🕒 2026/09/12 16:17 JST"].join("\n"),
    createdAt: "2026-09-12T07:17:00.000Z",
    ...overrides
  };
}

describe("toRfc822", () => {
  it("formats RFC-822 GMT timestamps", () => {
    expect(toRfc822(new Date("2026-09-12T07:17:00.000Z"))).toBe("Sat, 12 Sep 2026 07:17:00 GMT");
  });
});

describe("escapeXml", () => {
  it("escapes the five XML entities and keeps Japanese, emoji, and newlines", () => {
    const raw = ['A & B <tag> "quoted" \'single\'', "日本語 🚀"].join("\n");
    const escaped = escapeXml(raw);
    expect(escaped).toBe(
      "A &amp; B &lt;tag&gt; &quot;quoted&quot; &apos;single&apos;\n日本語 🚀"
    );
  });

  it("strips control characters that are illegal in XML content", () => {
    const control = String.fromCharCode(1);
    expect(escapeXml(`a${control}b`)).toBe("ab");
  });
});

describe("buildRssXml", () => {
  it("renders the golden document for a single-item channel", () => {
    const xml = buildRssXml(channel, [item()]);
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0">',
        "  <channel>",
        `    <title>${channel.title}</title>`,
        `    <link>${channel.link}</link>`,
        `    <description>${channel.description}</description>`,
        "    <language>ja</language>",
        "    <generator>aibench-teams-feed</generator>",
        "    <lastBuildDate>Sat, 12 Sep 2026 07:17:00 GMT</lastBuildDate>",
        "    <item>",
        "      <title>🚀 New Model: gpt-5.6 · OpenAI</title>",
        "      <link>https://example.com/launch</link>",
        '      <guid isPermaLink="false">urn:aibench:new-model:openai:gpt-5.6</guid>',
        "      <pubDate>Sat, 12 Sep 2026 07:17:00 GMT</pubDate>",
        "      <description>🏢 OpenAI",
        "🧠 gpt-5.6",
        "🕒 2026/09/12 16:17 JST</description>",
        "    </item>",
        "  </channel>",
        "</rss>",
        ""
      ].join("\n")
    );
    validateRssXml(xml, "test");
  });

  it("is byte-stable across repeated builds", () => {
    const first = buildRssXml(channel, [item(), item({ guid: "urn:aibench:new-model:x:y" })]);
    const second = buildRssXml(channel, [item(), item({ guid: "urn:aibench:new-model:x:y" })]);
    expect(first).toBe(second);
  });

  it("round-trips special characters through a parse", () => {
    const tricky = item({
      description: ['A & B < "web" > \'rss\'', "絵文字 🧠 &amp; test"].join("\n")
    });
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(buildRssXml(channel, [tricky]));
    const node = parsed.rss.channel.item.description;
    expect(node).toBe(tricky.description);
  });

  it("omits lastBuildDate for an empty feed", () => {
    const xml = buildRssXml(channel, []);
    expect(xml).not.toContain("lastBuildDate");
    validateRssXml(xml, "test");
  });

  it("uses the newest item's pubDate as lastBuildDate", () => {
    const older = item({ pubDate: "Tue, 01 Sep 2026 00:00:00 GMT" });
    const newer = item({ pubDate: "Sat, 12 Sep 2026 07:17:00 GMT" });
    const xml = buildRssXml(channel, [newer, older]);
    expect(xml).toContain("<lastBuildDate>Sat, 12 Sep 2026 07:17:00 GMT</lastBuildDate>");
  });
});

describe("validateRssXml", () => {
  it("throws on malformed XML", () => {
    expect(() => validateRssXml("<rss><channel>", "test")).toThrow();
  });

  it("throws on a non-RSS document", () => {
    expect(() => validateRssXml("<html><body/></html>", "test")).toThrow("not an RSS");
  });
});
