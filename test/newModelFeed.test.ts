import { existsSync, mkdtempSync, readFileSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";
import type { ProviderSource, RawAnnouncement } from "ai-benchmark-bot/dist/announcements/index.js";
import { StateStore } from "ai-benchmark-bot/dist/state.js";
import { loadFeedItems } from "../src/feedStore.js";
import { feedXmlPath, regenerateFeedXml } from "../src/feeds.js";
import { alertToFeedItems, newModelGuid, runNewModelFeed } from "../src/newModelFeed.js";
import { validateRssXml } from "../src/rssBuilder.js";
import { silentLogger, tempDir, testConfig } from "./helpers.js";

const fixedNow = () => new Date("2026-09-12T07:17:00.000Z");

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

function run(stateDir: string, sources: ProviderSource[]) {
  return runNewModelFeed({
    config: testConfig(stateDir),
    store: new StateStore(stateDir),
    logger: silentLogger,
    sources,
    fetchFn: harnessFetch(),
    now: fixedNow,
    retryDelayMs: 0
  });
}

const openai = (raws: () => RawAnnouncement[]) => source("openai", raws);
const noModels = () => [];
const cachePath = (stateDir: string) => join(stateDir, "feed-items-new-model.json");

describe("new-model delta feed", () => {
  it("establishes a silent baseline: seen-models written, delta feed empty", async () => {
    const stateDir = tempDir("nm-base-");
    const result = await run(stateDir, [openai(() => [launch(["gpt-5.6"])])]);
    expect(result).toEqual({ alerts: 0, itemsAdded: 0 });
    expect(new StateStore(stateDir).loadSeenModels().map((model) => model.modelId)).toEqual([
      "gpt-5.6"
    ]);
    expect(loadFeedItems(cachePath(stateDir))).toEqual([]);
  });

  it("publishes the run's fresh models as the delta", async () => {
    const stateDir = tempDir("nm-delta-");
    await run(stateDir, [openai(noModels)]);
    const result = await run(stateDir, [openai(() => [launch(["gpt-5.6"])])]);
    expect(result.alerts).toBe(1);
    expect(result.itemsAdded).toBe(1);

    const items = loadFeedItems(cachePath(stateDir));
    expect(items).toHaveLength(1);
    const feedItem = items[0];
    expect(feedItem?.guid).toBe("urn:aibench:new-model:openai:gpt-5.6");
    expect(feedItem?.pubDate).toBe("Sat, 12 Sep 2026 07:17:00 GMT");
    expect(feedItem?.title).toBe("🚀 New Model: gpt-5.6 · OpenAI");
    expect(feedItem?.description).toContain("🏢 OpenAI");
    expect(feedItem?.description).toContain("🧠 gpt-5.6");
    expect(feedItem?.description).toContain("📝 A new language model");
    expect(feedItem?.description).toContain("🕒 2026/09/12 16:17 JST");
    expect(feedItem?.description).not.toContain("💰");
  });

  it("emits one independent item per model within a single run", async () => {
    const stateDir = tempDir("nm-multi-");
    await run(stateDir, [openai(noModels)]);
    const result = await run(stateDir, [openai(() => [launch(["gpt-5.6", "gpt-5.6-mini"])])]);
    expect(result.alerts).toBe(1);
    expect(result.itemsAdded).toBe(2);
    const guids = loadFeedItems(cachePath(stateDir)).map((entry) => entry.guid);
    expect(guids).toEqual([
      "urn:aibench:new-model:openai:gpt-5.6",
      "urn:aibench:new-model:openai:gpt-5.6-mini"
    ]);
  });

  it("publishes an empty, valid feed when no models are fresh, and never re-publishes seen ones", async () => {
    const stateDir = tempDir("nm-empty-");
    await run(stateDir, [openai(noModels)]);
    await run(stateDir, [openai(() => [launch(["gpt-5.6"])])]);
    expect(loadFeedItems(cachePath(stateDir))).toHaveLength(1);

    // Same sources again: seen models must not re-appear — and the delta
    // from the previous run must not linger in the feed either.
    const second = await run(stateDir, [openai(() => [launch(["gpt-5.6"])])]);
    expect(second).toEqual({ alerts: 0, itemsAdded: 0 });
    expect(loadFeedItems(cachePath(stateDir))).toEqual([]);

    const config = testConfig(stateDir);
    regenerateFeedXml(config, "new-model");
    const xml = readFileSync(feedXmlPath(config.rssDir, "new-model"), "utf8");
    expect(xml).not.toContain("<item>");
    validateRssXml(xml, "test");
  });

  it("replaces the previous delta: the next run's items drop the old ones", async () => {
    const stateDir = tempDir("nm-repl-");
    await run(stateDir, [openai(noModels)]);
    await run(stateDir, [openai(() => [launch(["model-a", "model-b"])])]);
    expect(loadFeedItems(cachePath(stateDir))).toHaveLength(2);

    const result = await run(stateDir, [openai(() => [launch(["model-c"])])]);
    expect(result.alerts).toBe(1);
    const guids = loadFeedItems(cachePath(stateDir)).map((entry) => entry.guid);
    expect(guids).toEqual(["urn:aibench:new-model:openai:model-c"]);
  });

  it("keeps models unseen when persisting fails, then retries with the same GUID", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nm-fail-"));
    await run(stateDir, [openai(noModels)]);
    // A directory where the items cache belongs makes every save throw.
    const fsPromises = await import("node:fs/promises");
    await fsPromises.rm(cachePath(stateDir));
    await fsPromises.mkdir(cachePath(stateDir));
    await expect(run(stateDir, [openai(() => [launch(["gpt-5.6"])])])).rejects.toThrow();
    rmdirSync(cachePath(stateDir));

    const retried = await run(stateDir, [openai(() => [launch(["gpt-5.6"])])]);
    expect(retried.alerts).toBe(1);
    const items = loadFeedItems(cachePath(stateDir));
    expect(items.map((entry) => entry.guid)).toEqual([newModelGuid("openai", "gpt-5.6")]);
  });

  it("keeps the generated XML byte-stable while the delta is unchanged", async () => {
    const stateDir = tempDir("nm-xml-");
    await run(stateDir, [openai(noModels)]);
    await run(stateDir, [openai(() => [launch(["gpt-5.6"])])]);
    const config = testConfig(stateDir);
    // The run itself publishes the XML; regenerating must not change a byte.
    const before = readFileSync(feedXmlPath(config.rssDir, "new-model"), "utf8");
    expect(regenerateFeedXml(config, "new-model")).toBe(false);
    expect(readFileSync(feedXmlPath(config.rssDir, "new-model"), "utf8")).toBe(before);
  });

  it("preserves newlines in descriptions through XML generation", async () => {
    const stateDir = tempDir("nm-nl-");
    await run(stateDir, [openai(noModels)]);
    await run(stateDir, [openai(() => [launch(["gpt-5.6"])])]);
    const config = testConfig(stateDir);
    regenerateFeedXml(config, "new-model");
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(
      readFileSync(feedXmlPath(config.rssDir, "new-model"), "utf8")
    );
    const stored = loadFeedItems(cachePath(stateDir))[0];
    const rendered = parsed.rss.channel.item.description;
    expect(rendered).toBe(stored?.description);
    expect(rendered).toContain("\n");
  });
});

describe("GUID stability", () => {
  it("derives stable GUIDs without timestamps or run ids", () => {
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
