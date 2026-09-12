import { existsSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderSource, RawAnnouncement } from "ai-benchmark-bot/dist/announcements/index.js";
import { StateStore } from "ai-benchmark-bot/dist/state.js";
import { loadFeedItems } from "../src/feedStore.js";
import { regenerateFeedXml } from "../src/feeds.js";
import { alertToFeedItems, newModelGuid, runNewModelFeed } from "../src/newModelFeed.js";
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

describe("runNewModelFeed", () => {
  it("establishes a silent baseline: seen-models written, zero items", async () => {
    const stateDir = tempDir("nm-base-");
    const result = await run(stateDir, [openai(() => [launch(["gpt-5.6"])])]);
    expect(result).toEqual({ alerts: 0, itemsAdded: 0 });
    expect(new StateStore(stateDir).loadSeenModels().map((model) => model.modelId)).toEqual([
      "gpt-5.6"
    ]);
    expect(existsSync(join(stateDir, "feed-items-new-model.json"))).toBe(false);
  });

  it("turns one fresh announcement into per-model items with stable GUIDs", async () => {
    const stateDir = tempDir("nm-item-");
    await run(stateDir, [openai(noModels)]);
    const result = await run(stateDir, [openai(() => [launch(["gpt-5.6"])])]);
    expect(result.alerts).toBe(1);
    expect(result.itemsAdded).toBe(1);

    const items = loadFeedItems(join(stateDir, "feed-items-new-model.json"));
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

  it("does not duplicate items when the same models are re-polled", async () => {
    const stateDir = tempDir("nm-dup-");
    await run(stateDir, [openai(noModels)]);
    const sources = [openai(() => [launch(["gpt-5.6"])])];
    await run(stateDir, sources);
    const second = await run(stateDir, sources);
    expect(second).toEqual({ alerts: 0, itemsAdded: 0 });
    expect(loadFeedItems(join(stateDir, "feed-items-new-model.json"))).toHaveLength(1);
  });

  it("splits a multi-model announcement into one item per model", async () => {
    const stateDir = tempDir("nm-multi-");
    await run(stateDir, [openai(noModels)]);
    const result = await run(stateDir, [openai(() => [launch(["gpt-5.6", "gpt-5.6-mini"])])]);
    expect(result.alerts).toBe(1);
    expect(result.itemsAdded).toBe(2);
    const guids = loadFeedItems(join(stateDir, "feed-items-new-model.json")).map(
      (entry) => entry.guid
    );
    expect(guids).toEqual([
      "urn:aibench:new-model:openai:gpt-5.6",
      "urn:aibench:new-model:openai:gpt-5.6-mini"
    ]);
  });

  it("keeps models unseen when persisting fails, then retries with the same GUID", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nm-fail-"));
    await run(stateDir, [openai(noModels)]);
    // A directory where the items cache belongs makes every save throw.
    const cachePath = join(stateDir, "feed-items-new-model.json");
    const fsPromises = await import("node:fs/promises");
    await fsPromises.mkdir(cachePath);
    const blocked = await run(stateDir, [openai(() => [launch(["gpt-5.6"])])]);
    expect(blocked.alerts).toBe(0);
    rmdirSync(cachePath);

    const retried = await run(stateDir, [openai(() => [launch(["gpt-5.6"])])]);
    expect(retried.alerts).toBe(1);
    const items = loadFeedItems(cachePath);
    expect(items.map((entry) => entry.guid)).toEqual([newModelGuid("openai", "gpt-5.6")]);
  });

  it("regenerates XML byte-identically on unchanged state", async () => {
    const stateDir = tempDir("nm-xml-");
    await run(stateDir, [openai(noModels)]);
    await run(stateDir, [openai(() => [launch(["gpt-5.6"])])]);
    const config = testConfig(stateDir);
    expect(regenerateFeedXml(config, "new-model")).toBe(true);
    expect(regenerateFeedXml(config, "new-model")).toBe(false);
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
