import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { StateStore } from "ai-benchmark-bot/dist/state.js";
import { runBenchmarkFeed, shouldRunBenchmark } from "../src/benchmarkFeed.js";
import { loadFeedItems, loadRankingSnapshot, saveRankingSnapshot } from "../src/feedStore.js";
import { feedXmlPath, regenerateFeedXml } from "../src/feeds.js";
import { silentLogger, tempDir, testConfig } from "./helpers.js";

// 22:00 JST on 2026-09-13: past the digest time, dateKey 2026-09-13.
const digestTime = () => new Date("2026-09-13T13:00:00.000Z");
// 06:00 JST on 2026-09-14: before the digest time.
const beforeDigest = () => new Date("2026-09-13T21:00:00.000Z");

const ARENA_DATE = "2026-08-30";

function arenaPage(names: string[]): unknown {
  return {
    rows: names.map((name, index) => ({
      row_idx: index,
      row: {
        model_name: name,
        organization: "Example AI",
        rating: 1500 - index * 7.3,
        vote_count: 9000 - index * 100,
        rank: index + 1,
        category: "webdev",
        leaderboard_publish_date: ARENA_DATE
      },
      truncated_cells: []
    })),
    num_rows_total: names.length,
    num_rows_per_page: 100,
    partial: false
  };
}

/** Official category -> task mapping, from categories_2026_09_04.json. */
const CATEGORIES = {
  Reasoning: ["theory_of_mind"],
  Coding: ["code_generation", "code_completion"],
  "Agentic Coding": ["javascript"],
  Mathematics: ["AMPS_Hard"],
  "Data Analysis": ["tablejoin"],
  Language: ["typos"],
  IF: ["summarize"]
};

/**
 * model-a: every task 80 -> overall 80.00. "model & b": every task 70 ->
 * overall 70.00 (also the XML-escape fixture). model-c: missing the entire
 * Reasoning category -> no official overall -> must be excluded.
 */
const LIVEBENCH_CSV = [
  "model,code_generation,code_completion,javascript,AMPS_Hard,theory_of_mind,tablejoin,typos,summarize",
  "model-a,80,80,80,80,80,80,80,80",
  "model & b,70,70,70,70,70,70,70,70",
  "model-c,70,70,70,70,,,,70,70"
].join("\n");

/**
 * The official RELEASES constant already lists 2026-09-04 while the deployed
 * gh-pages listing is stale (only 2026-06-25) — discovery must take the max.
 */
const CONSTANTS_JS = `export const RELEASES = [
  "2024-06-24", "2026-06-25", "2026-09-04",
];`;

const STALE_LISTING = [
  { name: "index.html", type: "file" },
  { name: "table_2026_06_25.csv", type: "file" },
  { name: "categories_2026_06_25.json", type: "file" }
];

const LIVEBENCH_LAST_MODIFIED = "Thu, 10 Sep 2026 15:13:40 GMT";

/** A catalog entry that matches none of the fixture model names. */
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

type Slot =
  | "arena"
  | "constants"
  | "listing"
  | "live-table"
  | "live-categories"
  | "openrouter";

function jsonResponse(payload: unknown): () => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
}

function textResponse(body: string, headers: Record<string, string> = {}): () => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "text/csv", ...headers } })
    );
}

function httpError(status: number): () => Promise<Response> {
  return () => Promise.resolve(new Response("boom", { status }));
}

interface Harness {
  stateDir: string;
  store: StateStore;
  requests: string[];
  fetchFn: typeof fetch;
  setResponse: (slot: Slot, responder: () => Promise<Response>) => void;
}

function createHarness(arenaNames: string[]): Harness {
  const stateDir = tempDir("bench-");
  const store = new StateStore(stateDir);
  const requests: string[] = [];
  const responses = new Map<Slot, () => Promise<Response>>([
    ["arena", jsonResponse(arenaPage(arenaNames))],
    ["constants", textResponse(CONSTANTS_JS)],
    ["listing", jsonResponse(STALE_LISTING)],
    ["live-table", textResponse(LIVEBENCH_CSV, { "last-modified": LIVEBENCH_LAST_MODIFIED })],
    ["live-categories", jsonResponse(CATEGORIES)],
    ["openrouter", jsonResponse({ data: UNRELATED_CATALOG })]
  ]);
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    let slot: Slot;
    if (url.includes("openrouter.ai")) slot = "openrouter";
    else if (url.includes("config=webdev")) slot = "arena";
    else if (url.includes("src/lib/constants.js")) slot = "constants";
    else if (url.includes("api.github.com")) slot = "listing";
    else if (url.includes("livebench.ai") && url.includes("table_")) slot = "live-table";
    else if (url.includes("livebench.ai") && url.includes("categories_")) slot = "live-categories";
    else throw new Error(`unexpected url: ${url}`);
    const responder = responses.get(slot);
    if (!responder) throw new Error(`no responder for ${slot}`);
    return responder();
  }) as typeof fetch;
  return {
    stateDir,
    store,
    requests,
    fetchFn,
    setResponse: (slot, responder) => responses.set(slot, responder)
  };
}

function run(harness: Harness, options: { when?: () => Date; force?: boolean } = {}) {
  return runBenchmarkFeed({
    config: testConfig(harness.stateDir),
    store: harness.store,
    logger: silentLogger,
    fetchFn: harness.fetchFn,
    now: options.when ?? digestTime,
    retryDelayMs: 0,
    force: options.force
  });
}

describe("gate", () => {
  it("skips before the digest time without fetching anything", async () => {
    const harness = createHarness(["arena-model-x"]);
    const result = await run(harness, { when: beforeDigest });
    expect(result.status).toBe("skipped-before-digest");
    expect(harness.requests).toEqual([]);
    expect(existsSync(join(harness.stateDir, "last-posted.json"))).toBe(false);
  });

  it("reports skipped-already-posted once today's digest ran", async () => {
    const harness = createHarness(["arena-model-x"]);
    await run(harness);
    const second = await run(harness);
    expect(second.status).toBe("skipped-already-posted");
    expect(second.itemsAdded).toBe(0);
  });

  it("force bypasses the gate", async () => {
    const harness = createHarness(["arena-model-x"]);
    const result = await run(harness, { when: beforeDigest, force: true });
    expect(result.status).toBe("posted");
  });

  it("shouldRunBenchmark requires both the clock and a fresh dateKey", () => {
    const harness = createHarness(["arena-model-x"]);
    expect(shouldRunBenchmark(beforeDigest(), testConfig(harness.stateDir), harness.store)).toBe(
      false
    );
    expect(shouldRunBenchmark(digestTime(), testConfig(harness.stateDir), harness.store)).toBe(
      true
    );
  });
});

describe("digest", () => {
  it("publishes one item with Arena Coding and LiveBench sections and both attributions", async () => {
    const harness = createHarness(["arena-model-x", "arena-model-y"]);
    const result = await run(harness);
    expect(result.status).toBe("posted");
    expect(result.boards).toEqual({ "arena-coding": "ok", livebench: "ok" });
    expect(result.itemsAdded).toBe(1);

    const items = loadFeedItems(join(harness.stateDir, "feed-items-benchmark.json"));
    expect(items).toHaveLength(1);
    const digest = items[0];
    expect(digest?.guid).toBe("urn:aibench:benchmark:2026-09-13");
    expect(digest?.title).toBe("📊 Benchmark Daily — 2026/09/13");
    const description = digest?.description ?? "";

    // Arena Coding: official dataset fields — name, organization, rank,
    // rating, leaderboard publish date.
    expect(description).toContain("=== Arena Coding ===");
    expect(description).toContain(`データ: ${ARENA_DATE} 時点のランキング`);
    expect(description).toContain("1. arena-model-x (Example AI) — 1500 ➖");
    expect(description).toContain("2. arena-model-y (Example AI) — 1493 ➖");

    // LiveBench: snapshot date is the data actually used (the served file's
    // Last-Modified), not the release label.
    expect(description).toContain("=== LiveBench ===");
    expect(description).toContain("Snapshot: 2026-09-10");
    expect(description).toContain("1. model-a — 80.00 (coding 80.00 / agentic 80.00) ➖");
    expect(description).toContain("2. model & b — 70.00 (coding 70.00 / agentic 70.00) ➖");
    // A model without an official overall is unrankable and must not appear.
    expect(description).not.toContain("model-c");

    // Official attributions, verbatim.
    expect(description).toContain(
      "Source: Arena\nDataset: lmarena-ai/leaderboard-dataset\nLicense: CC BY 4.0\nChanges: Ranking data reformatted for RSS."
    );
    expect(description).toContain("Source: LiveBench\nLicense: Apache License 2.0");
    // Legend first, then attribution blocks grouped at the bottom in digest
    // order: Arena -> LiveBench -> OpenRouter, each starting with "Source:".
    expect(description).toContain(
      "⬆️ 上昇 · ⬇️ 下降 · ➖ 変動なし\n💰 入力/出力 $/1Mトークン\n\nSource: Arena"
    );
    expect(description).toContain(
      "Changes: Ranking data reformatted for RSS.\n\nSource: LiveBench\nLicense: Apache License 2.0\n\nSource: OpenRouter\nSite: openrouter.ai"
    );

    // Removed benchmarks: no Arena Overall, no MMLU-Pro, no Artificial Analysis.
    expect(description).not.toContain("Arena Overall");
    expect(description).not.toContain("MMLU-Pro");
    expect(description).not.toContain("Artificial Analysis");
    expect(description).not.toContain("artificialanalysis");
    expect(description).not.toContain("AA指数");

    // Source discipline: only the official HF dataset for Arena (never the
    // website), no AA API calls, the Overall board is never fetched, and the
    // LiveBench files come from the live site for the NEWEST release only.
    const hosts = harness.requests.map((request) => new URL(request).host);
    expect(
      hosts.every((host) =>
        [
          "datasets-server.huggingface.co",
          "api.github.com",
          "raw.githubusercontent.com",
          "livebench.ai",
          "openrouter.ai"
        ].includes(host)
      )
    ).toBe(true);
    expect(
      harness.requests.some((request) => request.includes("lmarena-ai/leaderboard-dataset"))
    ).toBe(true);
    expect(harness.requests.some((request) => request.includes("text_style_control"))).toBe(false);
    expect(harness.requests.some((request) => request.includes("artificialanalysis.ai"))).toBe(
      false
    );
    // The newest release is fetched from the live site; the stale release is
    // never requested from anywhere.
    expect(harness.requests.some((request) => request.includes("table_2026_09_04"))).toBe(true);
    expect(harness.requests.some((request) => request.includes("livebench.ai/table_2026_09_04"))).toBe(
      true
    );
    expect(harness.requests.some((request) => request.includes("table_2026_06_25"))).toBe(false);

    // Snapshots saved for both boards.
    expect(loadRankingSnapshot(join(harness.stateDir, "lmarena-coding.json"))?.entries).toHaveLength(
      2
    );
    const livebenchSnapshot = loadRankingSnapshot(join(harness.stateDir, "livebench.json"));
    expect(livebenchSnapshot?.snapshotDate).toBe("2026-09-10");
    expect(livebenchSnapshot?.releaseDate).toBe("2026-09-04");
    expect(livebenchSnapshot?.entries).toHaveLength(2);

    const saved = harness.store.loadLastPosted();
    expect(saved?.dateKey).toBe("2026-09-13");
  });

  it("keeps descriptions verbatim through XML generation (newlines and escapes)", async () => {
    const harness = createHarness(["arena-model-x"]);
    await run(harness);
    const config = testConfig(harness.stateDir);
    regenerateFeedXml(config, "benchmark");
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(
      readFileSync(feedXmlPath(config.rssDir, "benchmark"), "utf8")
    );
    const stored = loadFeedItems(join(harness.stateDir, "feed-items-benchmark.json"))[0];
    const rendered = parsed.rss.channel.item.description;
    expect(rendered).toBe(stored?.description);
    expect(rendered).toContain("\n");
    expect(rendered).toContain("model & b");
  });

  it("shows rank deltas against the previous snapshots", async () => {
    const harness = createHarness(["arena-model-x", "arena-model-y"]);
    saveRankingSnapshot(join(harness.stateDir, "lmarena-coding.json"), {
      savedAt: "2026-09-12T00:00:00.000Z",
      entries: [
        {
          entityKey: "arena-model-y",
          name: "arena-model-y",
          rank: 1,
          score: 1493,
          scoreDisplay: "1493"
        },
        {
          entityKey: "arena-model-x",
          name: "arena-model-x",
          rank: 2,
          score: 1500,
          scoreDisplay: "1500"
        }
      ]
    });
    saveRankingSnapshot(join(harness.stateDir, "livebench.json"), {
      savedAt: "2026-09-12T00:00:00.000Z",
      snapshotDate: "2026-09-10",
      releaseDate: "2026-09-04",
      entries: [
        {
          entityKey: "model & b",
          name: "model & b",
          rank: 1,
          score: 70,
          scoreDisplay: "70.00"
        },
        { entityKey: "model-a", name: "model-a", rank: 2, score: 80, scoreDisplay: "80.00" }
      ]
    });
    await run(harness);
    const digest = loadFeedItems(join(harness.stateDir, "feed-items-benchmark.json"))[0];
    expect(digest?.description).toContain("1. arena-model-x (Example AI) — 1500 ⬆️ +1");
    expect(digest?.description).toContain("2. arena-model-y (Example AI) — 1493 ⬇️ -1");
    expect(digest?.description).toContain(
      "1. model-a — 80.00 (coding 80.00 / agentic 80.00) ⬆️ +1"
    );
  });

  it("publishes with a failure line when only Arena Coding fails", async () => {
    const harness = createHarness(["arena-model-x"]);
    saveRankingSnapshot(join(harness.stateDir, "lmarena-coding.json"), {
      savedAt: "2026-09-12T00:00:00.000Z",
      entries: [
        {
          entityKey: "arena-model-x",
          name: "arena-model-x",
          rank: 1,
          score: 1500,
          scoreDisplay: "1500"
        }
      ]
    });
    harness.setResponse("arena", httpError(500));
    const result = await run(harness);
    expect(result.status).toBe("posted");
    expect(result.boards).toEqual({ "arena-coding": "failed", livebench: "ok" });
    const digest = loadFeedItems(join(harness.stateDir, "feed-items-benchmark.json"))[0];
    expect(digest?.description).toContain("⚠️ Arena Coding: unavailable");
    expect(digest?.description).toContain("=== LiveBench ===");
    // The failed board keeps its previous snapshot for the next comparison.
    expect(loadRankingSnapshot(join(harness.stateDir, "lmarena-coding.json"))?.savedAt).toBe(
      "2026-09-12T00:00:00.000Z"
    );
  });

  it("publishes with a failure line when only LiveBench fails", async () => {
    const harness = createHarness(["arena-model-x"]);
    // Every LiveBench discovery and file source must fail for the board to
    // count as unavailable.
    harness.setResponse("constants", httpError(500));
    harness.setResponse("listing", httpError(500));
    harness.setResponse("live-table", httpError(404));
    harness.setResponse("live-categories", httpError(404));
    const result = await run(harness);
    expect(result.status).toBe("posted");
    expect(result.boards).toEqual({ "arena-coding": "ok", livebench: "failed" });
    const digest = loadFeedItems(join(harness.stateDir, "feed-items-benchmark.json"))[0];
    expect(digest?.description).toContain("⚠️ LiveBench: unavailable");
    expect(digest?.description).toContain("=== Arena Coding ===");
  });

  it("throws without writing anything when both boards fail", async () => {
    const harness = createHarness(["arena-model-x"]);
    harness.setResponse("arena", httpError(500));
    harness.setResponse("constants", httpError(500));
    harness.setResponse("listing", httpError(500));
    harness.setResponse("live-table", httpError(404));
    harness.setResponse("live-categories", httpError(404));
    await expect(run(harness)).rejects.toThrow(/both Arena Coding and LiveBench failed/);
    expect(existsSync(join(harness.stateDir, "last-posted.json"))).toBe(false);
    expect(existsSync(join(harness.stateDir, "feed-items-benchmark.json"))).toBe(false);
  });
});

describe("xml regeneration", () => {
  it("writes once and stays byte-identical afterwards", async () => {
    const harness = createHarness(["arena-model-x"]);
    await run(harness);
    const config = testConfig(harness.stateDir);
    expect(regenerateFeedXml(config, "benchmark")).toBe(true);
    expect(regenerateFeedXml(config, "benchmark")).toBe(false);
  });
});
