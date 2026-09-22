import { existsSync, mkdtempSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";
import type { ProviderSource, RawAnnouncement } from "ai-benchmark-bot/dist/announcements/index.js";
import { StateStore } from "ai-benchmark-bot/dist/state.js";
import { loadFeedItems, loadLastPosted } from "../src/feedStore.js";
import { feedXmlPath, regenerateFeedXml } from "../src/feeds.js";
import {
  alertToFeedItems,
  buildDailyCard,
  newModelDailyGuid,
  newModelGuid,
  runNewModelFeed,
  shouldRunNewModel
} from "../src/newModelFeed.js";
import { validateRssXml } from "../src/rssBuilder.js";
import { silentLogger, tempDir, testConfig } from "./helpers.js";

// 16:30 JST on 2026-09-12: past the digest time, dateKey 2026-09-12.
const digestTime = () => new Date("2026-09-12T07:30:00.000Z");
// 04:00 / 05:00 JST the same day: before the digest time, same dateKey.
const beforeDigest = () => new Date("2026-09-11T19:00:00.000Z");
const beforeDigestLater = () => new Date("2026-09-11T20:00:00.000Z");
// 04:00 JST on 2026-09-13: the next day, before that day's digest.
const nextDayBeforeDigest = () => new Date("2026-09-12T19:00:00.000Z");
// The next day's digest window: 16:30 JST on 2026-09-13.
const nextDayDigest = () => new Date("2026-09-13T07:30:00.000Z");

function source(id: string, raws: () => RawAnnouncement[]): ProviderSource {
  return {
    id,
    providerName: id === "openai" ? "OpenAI" : "Test Provider",
    displayName: `${id} docs`,
    fetchUrl: `https://example.test/${id}`,
    accept: "text/html",
    parse: () => raws()
  };
}

function launch(modelIds: string[]): RawAnnouncement {
  return {
    key: `launch-${modelIds.join("-")}`,
    title: `We've launched ${modelIds.join(" and ")}`,
    url: "https://example.com/launch",
    summary: "A new language model for complex reasoning.",
    explicitModelIds: modelIds
  };
}

function okResponse(): Response {
  return new Response("<html>source document</html>", {
    status: 200,
    headers: { "content-type": "text/html" }
  });
}

/** Catalog entry matching nothing, so price lookups degrade to no 💰 line. */
const UNRELATED_CATALOG = [
  {
    id: "unrelated/vendor-model",
    name: "Vendor: Unrelated Model",
    hugging_face_id: null,
    created: 1,
    context_length: 8192,
    pricing: { prompt: "0.0000012", completion: "0.000012" }
  }
];

function harnessFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("openrouter.ai")) {
      return new Response(JSON.stringify({ data: UNRELATED_CATALOG }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return okResponse();
  }) as typeof fetch;
}

interface RunOptions {
  when?: () => Date;
  force?: boolean;
  maxItems?: number;
}

function run(stateDir: string, sources: ProviderSource[], options: RunOptions = {}) {
  return runNewModelFeed({
    config: testConfig(
      stateDir,
      options.maxItems ? { newModelMaxItems: options.maxItems } : {}
    ),
    store: new StateStore(stateDir),
    logger: silentLogger,
    sources,
    fetchFn: harnessFetch(),
    now: options.when ?? digestTime,
    retryDelayMs: 0,
    ...(options.force !== undefined ? { force: options.force } : {})
  });
}

const openai = (raws: () => RawAnnouncement[]) => source("openai", raws);
const noModels = () => [];
const cachePath = (stateDir: string) => join(stateDir, "feed-items-new-model.json");
const pendingPath = (stateDir: string) => join(stateDir, "new-model-pending.json");
const lastPostedPath = (stateDir: string) => join(stateDir, "last-posted-new-model.json");
const pendingGuids = (stateDir: string) =>
  loadFeedItems(pendingPath(stateDir)).map((item) => item.guid);

describe("gate", () => {
  it("accumulates before the digest time without touching the card cache or XML", async () => {
    const stateDir = tempDir("nm-gate-");
    await run(stateDir, [openai(noModels)], { when: beforeDigest });
    const result = await run(stateDir, [openai(() => [launch(["gpt-5.6"])])], {
      when: beforeDigest
    });
    expect(result).toEqual({
      dateKey: "2026-09-12",
      status: "skipped-before-digest",
      alerts: 1,
      models: 0
    });
    // Detected AND seen, but only staged in pending — the feed is untouched.
    expect(pendingGuids(stateDir)).toEqual([newModelGuid("openai", "gpt-5.6")]);
    expect(loadFeedItems(cachePath(stateDir))).toEqual([]);
    expect(existsSync(feedXmlPath(testConfig(stateDir).rssDir, "new-model"))).toBe(false);
    expect(existsSync(lastPostedPath(stateDir))).toBe(false);
    expect(new StateStore(stateDir).loadSeenModels().map((model) => model.modelId)).toEqual([
      "gpt-5.6"
    ]);
  });

  it("reports skipped-already-posted once today's card ran, still accumulating", async () => {
    const stateDir = tempDir("nm-posted-");
    await run(stateDir, [openai(noModels)], { when: beforeDigest });
    await run(stateDir, [openai(() => [launch(["model-a"])])], { when: beforeDigest });
    const published = await run(stateDir, [openai(noModels)]);
    expect(published.status).toBe("posted");

    const second = await run(stateDir, [openai(() => [launch(["model-b"])])]);
    expect(second).toEqual({
      dateKey: "2026-09-12",
      status: "skipped-already-posted",
      alerts: 1,
      models: 0
    });
    // Tomorrow's batch accumulates while today's card stays untouched.
    expect(pendingGuids(stateDir)).toEqual([newModelGuid("openai", "model-b")]);
    expect(loadFeedItems(cachePath(stateDir))).toHaveLength(1);
  });

  it("force bypasses the gate and records the day", async () => {
    const stateDir = tempDir("nm-force-");
    await run(stateDir, [openai(noModels)], { when: beforeDigest });
    const result = await run(stateDir, [openai(() => [launch(["model-a"])])], {
      when: beforeDigest,
      force: true
    });
    expect(result.status).toBe("posted");
    expect(result.models).toBe(1);
    expect(loadFeedItems(cachePath(stateDir))).toHaveLength(1);
    expect(loadLastPosted(lastPostedPath(stateDir))?.dateKey).toBe("2026-09-12");
    // The gate now treats today as done.
    const after = await run(stateDir, [openai(noModels)], { when: beforeDigest });
    expect(after.status).toBe("skipped-already-posted");
  });

  it("shouldRunNewModel requires both the clock and a fresh dateKey", () => {
    const stateDir = tempDir("nm-gatefn-");
    const config = testConfig(stateDir);
    expect(shouldRunNewModel(beforeDigest(), config)).toBe(false);
    expect(shouldRunNewModel(digestTime(), config)).toBe(true);
  });
});

describe("daily digest", () => {
  it("establishes a silent baseline: seen-models written, item-less card published", async () => {
    const stateDir = tempDir("nm-base-");
    const result = await run(stateDir, [openai(() => [launch(["gpt-5.6"])])]);
    expect(result).toEqual({ dateKey: "2026-09-12", status: "posted", alerts: 0, models: 0 });
    expect(new StateStore(stateDir).loadSeenModels().map((model) => model.modelId)).toEqual([
      "gpt-5.6"
    ]);
    expect(loadFeedItems(cachePath(stateDir))).toEqual([]);
    expect(loadLastPosted(lastPostedPath(stateDir))?.dateKey).toBe("2026-09-12");

    const config = testConfig(stateDir);
    const xml = readFileSync(feedXmlPath(config.rssDir, "new-model"), "utf8");
    expect(xml).not.toContain("<item>");
    validateRssXml(xml, "test");
  });

  it("publishes the day's fresh models as one combined card", async () => {
    const stateDir = tempDir("nm-digest-");
    await run(stateDir, [openai(noModels)], { when: beforeDigest });
    await run(stateDir, [openai(() => [launch(["model-a"])])], { when: beforeDigest });
    await run(stateDir, [openai(() => [launch(["model-b"])])], { when: beforeDigestLater });
    const result = await run(stateDir, [openai(noModels)]);
    expect(result).toEqual({
      dateKey: "2026-09-12",
      status: "posted",
      alerts: 0,
      models: 2
    });

    const items = loadFeedItems(cachePath(stateDir));
    expect(items).toHaveLength(1);
    const card = items[0];
    expect(card?.guid).toBe("urn:aibench:new-model:2026-09-12");
    expect(card?.title).toBe("🚀 New Model — 2026/09/12");
    expect(card?.pubDate).toBe("Sat, 12 Sep 2026 07:30:00 GMT");
    const description = card?.description ?? "";
    expect(description).toContain("📅 2026/09/12");
    expect(description).toContain("🕒 取得: 2026/09/12 16:30 JST");
    expect(description).toContain("🚀 本日の新モデル: 2件");
    expect(description).toContain("🏢 OpenAI");
    expect(description).toContain("🧠 model-a");
    expect(description).toContain("🧠 model-b");
    // Per-model blocks keep the detection time; price footer credits OpenRouter.
    expect(description).toContain("🕒 2026/09/12 05:00 JST");
    expect(description).toContain("💰 価格: openrouter.ai");
    // mergeFeedItems ordering: the newer model leads the card.
    expect(description.indexOf("🧠 model-b")).toBeLessThan(description.indexOf("🧠 model-a"));

    // The batch is consumed: pending cleared, the day recorded.
    expect(loadFeedItems(pendingPath(stateDir))).toEqual([]);
    expect(loadLastPosted(lastPostedPath(stateDir))).toEqual({
      dateKey: "2026-09-12",
      postedAt: "2026-09-12T07:30:00.000Z"
    });

    const config = testConfig(stateDir);
    const xml = readFileSync(feedXmlPath(config.rssDir, "new-model"), "utf8");
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
    expect(parsed.rss.channel.item.guid["#text"]).toBe("urn:aibench:new-model:2026-09-12");
    validateRssXml(xml, "test");
  });

  it("emits one block per model detected within a single run", async () => {
    const stateDir = tempDir("nm-multi-");
    await run(stateDir, [openai(noModels)], { when: beforeDigest });
    const result = await run(stateDir, [openai(() => [launch(["model-a", "model-b"])])], {
      when: digestTime
    });
    expect(result.models).toBe(2);
    const card = loadFeedItems(cachePath(stateDir))[0];
    expect(card?.description).toContain("🧠 model-a");
    expect(card?.description).toContain("🧠 model-b");
  });

  it("publishes an item-less feed when nothing is fresh, never re-publishing seen ones", async () => {
    const stateDir = tempDir("nm-empty-");
    await run(stateDir, [openai(noModels)], { when: beforeDigest });
    await run(stateDir, [openai(() => [launch(["gpt-5.6"])])], { when: beforeDigest });
    await run(stateDir, [openai(() => [launch(["gpt-5.6"])])]);
    expect(loadFeedItems(cachePath(stateDir))).toHaveLength(1);

    // The same source the next day: gpt-5.6 is seen, the day publishes empty.
    const result = await run(stateDir, [openai(() => [launch(["gpt-5.6"])])], {
      when: nextDayDigest
    });
    expect(result).toEqual({
      dateKey: "2026-09-13",
      status: "posted",
      alerts: 0,
      models: 0
    });
    expect(loadFeedItems(cachePath(stateDir))).toEqual([]);
    const config = testConfig(stateDir);
    const xml = readFileSync(feedXmlPath(config.rssDir, "new-model"), "utf8");
    expect(xml).not.toContain("<item>");
    validateRssXml(xml, "test");
  });

  it("replaces the feed with the next day's card (single-item feed)", async () => {
    const stateDir = tempDir("nm-repl-");
    await run(stateDir, [openai(noModels)], { when: beforeDigest });
    await run(stateDir, [openai(() => [launch(["model-a"])])], { when: beforeDigest });
    await run(stateDir, [openai(noModels)]);
    const result = await run(stateDir, [openai(() => [launch(["model-b"])])], {
      when: nextDayDigest
    });
    expect(result.status).toBe("posted");
    const items = loadFeedItems(cachePath(stateDir));
    expect(items).toHaveLength(1);
    expect(items[0]?.guid).toBe("urn:aibench:new-model:2026-09-13");
  });

  it("caps the pending batch at newModelMaxItems, keeping the newest", async () => {
    const stateDir = tempDir("nm-cap-");
    const cap = { maxItems: 2 };
    await run(stateDir, [openai(noModels)], { when: beforeDigest, ...cap });
    await run(stateDir, [openai(() => [launch(["model-a"])])], {
      when: () => new Date("2026-09-11T17:00:00.000Z"), // 02:00 JST
      ...cap
    });
    await run(stateDir, [openai(() => [launch(["model-b"])])], {
      when: () => new Date("2026-09-11T18:00:00.000Z"), // 03:00 JST
      ...cap
    });
    await run(stateDir, [openai(() => [launch(["model-c"])])], { when: beforeDigest, ...cap });
    const result = await run(stateDir, [openai(noModels)], cap);
    expect(result.models).toBe(2);
    const description = loadFeedItems(cachePath(stateDir))[0]?.description ?? "";
    expect(description).not.toContain("🧠 model-a");
    expect(description.indexOf("🧠 model-c")).toBeLessThan(description.indexOf("🧠 model-b"));
  });

  it("keeps models unseen when persisting fails past the digest, then retries", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nm-fail-"));
    await run(stateDir, [openai(noModels)], { when: beforeDigest });
    // A directory where the pending file belongs makes every save throw.
    // (A quiet baseline run creates no pending file, so rm needs force.)
    const fsPromises = await import("node:fs/promises");
    await fsPromises.rm(pendingPath(stateDir), { force: true });
    await fsPromises.mkdir(pendingPath(stateDir));
    await expect(run(stateDir, [openai(() => [launch(["gpt-5.6"])])])).rejects.toThrow();
    expect(new StateStore(stateDir).loadSeenModels()).toEqual([]);
    rmdirSync(pendingPath(stateDir));

    const retried = await run(stateDir, [openai(() => [launch(["gpt-5.6"])])]);
    expect(retried.status).toBe("posted");
    expect(retried.models).toBe(1);
    expect(loadFeedItems(cachePath(stateDir))[0]?.description).toContain("🧠 gpt-5.6");
  });

  it("resolves quietly on a persist failure before the digest and retries later", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nm-fail2-"));
    await run(stateDir, [openai(noModels)], { when: beforeDigest });
    const fsPromises = await import("node:fs/promises");
    await fsPromises.rm(pendingPath(stateDir), { force: true });
    await fsPromises.mkdir(pendingPath(stateDir));
    // The bot swallows the send failure (models stay unseen); the gate fails
    // before anything reads pending, so the run resolves — the next hourly
    // run re-detects.
    const result = await run(stateDir, [openai(() => [launch(["gpt-5.6"])])], {
      when: beforeDigest
    });
    expect(result.status).toBe("skipped-before-digest");
    expect(new StateStore(stateDir).loadSeenModels()).toEqual([]);
    rmdirSync(pendingPath(stateDir));

    const retried = await run(stateDir, [openai(() => [launch(["gpt-5.6"])])]);
    expect(retried.status).toBe("posted");
    expect(retried.models).toBe(1);
  });

  it("recovers the cached card when the previous run died between clear and day record", async () => {
    const stateDir = tempDir("nm-recover-");
    await run(stateDir, [openai(noModels)], { when: beforeDigest });
    await run(stateDir, [openai(() => [launch(["model-a"])])], {
      when: beforeDigest,
      force: true
    });
    const before = readFileSync(cachePath(stateDir), "utf8");
    // Simulate the crash window: pending empty, today's card cached, day lost.
    rmSync(lastPostedPath(stateDir));

    const result = await run(stateDir, [openai(noModels)]);
    expect(result).toEqual({
      dateKey: "2026-09-12",
      status: "posted",
      alerts: 0,
      models: 1
    });
    expect(readFileSync(cachePath(stateDir), "utf8")).toBe(before);
    expect(loadLastPosted(lastPostedPath(stateDir))?.dateKey).toBe("2026-09-12");
  });
});

describe("xml regeneration", () => {
  it("writes once and stays byte-identical across same-day runs", async () => {
    const stateDir = tempDir("nm-xml-");
    await run(stateDir, [openai(noModels)], { when: beforeDigest });
    await run(stateDir, [openai(() => [launch(["gpt-5.6"])])], { when: beforeDigest });
    await run(stateDir, [openai(noModels)]);
    const config = testConfig(stateDir);
    const before = readFileSync(feedXmlPath(config.rssDir, "new-model"), "utf8");
    // A same-day skip run must not change anything, and regenerating from
    // the card cache (the CLI's healing loop) must be a byte no-op.
    await run(stateDir, [openai(noModels)]);
    expect(regenerateFeedXml(config, "new-model")).toBe(false);
    expect(readFileSync(feedXmlPath(config.rssDir, "new-model"), "utf8")).toBe(before);
  });

  it("freezes the published card while the next day accumulates", async () => {
    const stateDir = tempDir("nm-freeze-");
    await run(stateDir, [openai(noModels)], { when: beforeDigest });
    await run(stateDir, [openai(() => [launch(["model-a"])])], { when: beforeDigest });
    await run(stateDir, [openai(noModels)]);
    const config = testConfig(stateDir);
    const before = readFileSync(feedXmlPath(config.rssDir, "new-model"), "utf8");

    // The next day, before the digest: detection stages into pending and the
    // published card stays exactly as Teams last saw it.
    const result = await run(stateDir, [openai(() => [launch(["model-b"])])], {
      when: nextDayBeforeDigest
    });
    expect(result.status).toBe("skipped-before-digest");
    expect(readFileSync(feedXmlPath(config.rssDir, "new-model"), "utf8")).toBe(before);
    expect(pendingGuids(stateDir)).toEqual([newModelGuid("openai", "model-b")]);
  });

  it("preserves newlines in the card description through XML generation", async () => {
    const stateDir = tempDir("nm-nl-");
    const multiline = (): RawAnnouncement[] => [
      {
        key: "launch-multi",
        title: "We've launched gpt-5.6",
        url: "https://example.com/launch",
        summary: "First paragraph.\n\nSecond paragraph.",
        explicitModelIds: ["gpt-5.6"]
      }
    ];
    await run(stateDir, [openai(noModels)], { when: beforeDigest });
    await run(stateDir, [openai(multiline)], { when: beforeDigest });
    await run(stateDir, [openai(noModels)]);
    const config = testConfig(stateDir);
    regenerateFeedXml(config, "new-model");
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(
      readFileSync(feedXmlPath(config.rssDir, "new-model"), "utf8")
    );
    const stored = loadFeedItems(cachePath(stateDir))[0];
    const rendered = parsed.rss.channel.item.description;
    expect(rendered).toBe(stored?.description);
    expect(rendered).toContain("\n\n");
  });
});

describe("GUID stability", () => {
  it("derives stable per-model GUIDs without timestamps or run ids", () => {
    const alert = {
      providerId: "zai",
      providerName: "Z.ai",
      title: "launch",
      url: "https://example.com",
      summary: "s",
      modelIds: ["model-a", "model-b"],
      stage: "general_availability" as const,
      detectedAt: "2026-09-12T07:17:00.000Z"
    };
    const first = alertToFeedItems(alert, "Asia/Tokyo");
    const second = alertToFeedItems(alert, "Asia/Tokyo");
    expect(second).toEqual(first);
    expect(first.map((item) => item.guid)).toEqual([
      "urn:aibench:new-model:zai:model-a",
      "urn:aibench:new-model:zai:model-b"
    ]);
    for (const guid of first.map((item) => item.guid)) {
      expect(guid).toMatch(/^urn:aibench:new-model:[^:\s]+:[^:\s]+$/);
    }
  });

  it("derives the daily card GUID from the dateKey, disjoint from per-model ones", () => {
    expect(newModelDailyGuid("2026-09-12")).toBe("urn:aibench:new-model:2026-09-12");
    expect(newModelDailyGuid("2026-09-12")).not.toBe(newModelGuid("2026-09-12", "x"));
    // A dateKey segment can never contain ":", so the 3-segment daily form
    // cannot collide with the 4-segment per-model form.
    expect(newModelDailyGuid("2026-09-12").split(":")).toHaveLength(4);
    expect(newModelGuid("openai", "gpt-5.6").split(":")).toHaveLength(5);
  });

  it("stamps the daily card with the publication day and instant", () => {
    const config = testConfig(tempDir("nm-card-"));
    const pending = alertToFeedItems(
      {
        providerId: "openai",
        providerName: "OpenAI",
        title: "launch",
        url: "https://example.com",
        summary: "s",
        modelIds: ["model-a"],
        stage: "general_availability" as const,
        detectedAt: "2026-09-11T20:00:00.000Z"
      },
      config.timeZone
    );
    const card = buildDailyCard(pending, digestTime(), config);
    expect(card.guid).toBe("urn:aibench:new-model:2026-09-12");
    expect(card.createdAt).toBe("2026-09-12T07:30:00.000Z");
    expect(card.link).toBe(config.feedBaseUrl);
  });
});

describe("alertToFeedItems", () => {
  it("renders the price line only for matched models", () => {
    const items = alertToFeedItems(
      {
        providerId: "openai",
        providerName: "OpenAI",
        title: "launch",
        url: "https://example.com",
        summary: "s",
        modelIds: ["gpt-5.6", "gpt-5.6-mini"],
        stage: "general_availability",
        pricingByModel: {
          "gpt-5.6": { priceDisplay: "$1.25/$10", contextDisplay: "400K" }
        },
        detectedAt: "2026-09-12T07:17:00.000Z"
      },
      "Asia/Tokyo"
    );
    expect(items).toHaveLength(2);
    expect(items[0]?.description).toContain("💰 $1.25/$10 · 400K");
    expect(items[1]?.description).not.toContain("💰");
  });
});
