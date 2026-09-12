import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "ai-benchmark-bot/dist/state.js";
import type { RankedModel } from "ai-benchmark-bot/dist/types.js";
import { runBenchmarkFeed, shouldRunBenchmark } from "../src/benchmarkFeed.js";
import { loadFeedItems } from "../src/feedStore.js";
import { regenerateFeedXml } from "../src/feeds.js";
import { silentLogger, tempDir, testConfig } from "./helpers.js";

const digestTime = () => new Date("2026-08-16T22:30:00.000Z"); // 07:30 JST
const beforeDigest = () => new Date("2026-08-16T21:00:00.000Z"); // 06:00 JST

function boardPage(names: string[]): unknown {
  return {
    rows: names.map((name, index) => ({
      row_idx: index,
      row: {
        model_name: name,
        organization: "Example AI",
        rating: 1500 - index * 7.3,
        rank: index + 1,
        category: "overall",
        leaderboard_publish_date: "2026-08-12"
      },
      truncated_cells: []
    })),
    num_rows_total: names.length,
    num_rows_per_page: 100,
    partial: false
  };
}

/** One AA model row: scores are null when the index was not measured. */
function aaModel(
  id: string,
  name: string,
  scores: { intelligence?: number; coding?: number }
): unknown {
  return {
    id,
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9.]+/g, "-"),
    model_creator: { id: "creator-1", name: "Example AI" },
    evaluations: {
      artificial_analysis_intelligence_index: scores.intelligence ?? null,
      artificial_analysis_coding_index: scores.coding ?? null,
      artificial_analysis_agentic_index: null
    }
  };
}

const AA_MODELS = [
  aaModel("id-alpha", "aa-alpha", { intelligence: 65.7 }),
  aaModel("id-beta", "aa-beta", { intelligence: 60.1 }),
  aaModel("id-code-1", "aa-code-1", { coding: 71.2 }),
  aaModel("id-code-2", "aa-code-2", { coding: 66.6 })
];

/** A catalog entry that matches none of the leaderboard fixture names. */
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

type Slot = "overall" | "coding" | "aa" | "openrouter";

function jsonOk(payload: unknown): () => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
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

function createHarness(overall: string[], coding: string[]): Harness {
  const stateDir = tempDir("bench-");
  const store = new StateStore(stateDir);
  const requests: string[] = [];
  const responses = new Map<Slot, () => Promise<Response>>([
    ["overall", jsonOk(boardPage(overall))],
    ["coding", jsonOk(boardPage(coding))],
    [
      "aa",
      jsonOk({
        tier: "free",
        intelligence_index_version: "4.1",
        pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false },
        data: AA_MODELS
      })
    ],
    ["openrouter", jsonOk({ data: UNRELATED_CATALOG })]
  ]);
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    let slot: Slot;
    if (url.includes("openrouter.ai")) slot = "openrouter";
    else if (url.includes("artificialanalysis.ai")) slot = "aa";
    else slot = url.includes("config=text_style_control") ? "overall" : "coding";
    const responder = responses.get(slot);
    if (!responder) throw new Error(`unexpected url: ${url}`);
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

function run(
  harness: Harness,
  options: { when?: () => Date; aaApiKey?: string; force?: boolean } = {}
) {
  return runBenchmarkFeed({
    config: testConfig(harness.stateDir, options.aaApiKey ? { aaApiKey: options.aaApiKey } : {}),
    store: harness.store,
    logger: silentLogger,
    fetchFn: harness.fetchFn,
    now: options.when ?? digestTime,
    retryDelayMs: 0,
    force: options.force
  });
}

function previousEntries(names: string[]): RankedModel[] {
  return names.map((name, index) => ({
    entityKey: name,
    name,
    rank: index + 1,
    score: 1400,
    scoreDisplay: "1400"
  }));
}

describe("gate", () => {
  it("skips before the digest time without fetching anything", async () => {
    const harness = createHarness(["model-a"], ["model-x"]);
    const result = await run(harness, { when: beforeDigest });
    expect(result.status).toBe("skipped-before-digest");
    expect(harness.requests).toEqual([]);
    expect(existsSync(join(harness.stateDir, "last-posted.json"))).toBe(false);
  });

  it("reports skipped-already-posted once today's digest ran", async () => {
    const harness = createHarness(["model-a"], ["model-x"]);
    await run(harness);
    const second = await run(harness);
    expect(second.status).toBe("skipped-already-posted");
    expect(second.itemsAdded).toBe(0);
    expect(harness.requests.length).toBeGreaterThan(0);
  });

  it("force bypasses the gate", async () => {
    const harness = createHarness(["model-a"], ["model-x"]);
    const result = await run(harness, { when: beforeDigest, force: true });
    expect(result.status).toBe("posted");
  });

  it("shouldRunBenchmark requires both the clock and a fresh dateKey", () => {
    const harness = createHarness(["model-a"], ["model-x"]);
    expect(shouldRunBenchmark(beforeDigest(), testConfig(harness.stateDir), harness.store)).toBe(
      false
    );
    expect(shouldRunBenchmark(digestTime(), testConfig(harness.stateDir), harness.store)).toBe(
      true
    );
  });
});

describe("digest", () => {
  it("posts one item with board sections, saves snapshots, and records the day", async () => {
    const harness = createHarness(["model-a", "model-b"], ["model-x"]);
    const result = await run(harness);
    expect(result.status).toBe("posted");
    expect(result.boards).toEqual({ "lmarena-overall": "ok", "lmarena-coding": "ok" });
    expect(result.skipped).toEqual(["aa-intelligence", "aa-coding"]);
    expect(result.itemsAdded).toBe(1);

    const items = loadFeedItems(join(harness.stateDir, "feed-items-benchmark.json"));
    expect(items).toHaveLength(1);
    const digest = items[0];
    expect(digest?.guid).toBe("urn:aibench:benchmark:2026-08-17");
    expect(digest?.title).toBe("📊 AI Benchmark Daily — 2026/08/17");
    expect(digest?.description).toContain("📅 2026/08/17");
    expect(digest?.description).toContain("🕒 Updated: 2026/08/17 07:30 JST");
    expect(digest?.description).toContain("🏆 LMArena Overall");
    expect(digest?.description).toContain("🥇 1. model-a · 1500 ➖");
    expect(digest?.description).toContain("💻 LMArena Coding");
    // Sections and rank lines are newline-separated, with a blank line
    // between blocks so Teams renders readable paragraphs.
    expect(digest?.description).toContain("🥈 2. model-b · 1493 ➖\n\n💻 LMArena Coding");
    expect(digest?.description).toContain("⬆️ 上昇 · ⬇️ 下降");
    expect(digest?.description).not.toContain("artificialanalysis.ai");

    const saved = harness.store.loadLastPosted();
    expect(saved?.dateKey).toBe("2026-08-17");
    expect(harness.store.loadRanking("lmarena-overall")?.entries).toHaveLength(2);
  });

  it("shows rank deltas against the previous snapshot", async () => {
    const harness = createHarness(["model-a", "model-b"], ["model-x"]);
    harness.store.saveRanking("lmarena-overall", previousEntries(["model-b", "model-a"]), "2026-08-15T00:00:00.000Z");
    const result = await run(harness);
    expect(result.status).toBe("posted");
    const digest = loadFeedItems(join(harness.stateDir, "feed-items-benchmark.json"))[0];
    // model-a moved 2 -> 1, model-b moved 1 -> 2.
    expect(digest?.description).toContain("🥇 1. model-a · 1500 ⬆️ +1");
    expect(digest?.description).toContain("🥈 2. model-b · 1493 ⬇️ -1");
  });

  it("publishes with a failure section when one board fails and keeps its snapshot", async () => {
    const harness = createHarness(["model-a"], ["model-x"]);
    harness.store.saveRanking("lmarena-coding", previousEntries(["model-x"]), "2026-08-15T00:00:00.000Z");
    harness.setResponse("coding", httpError(500));
    const result = await run(harness);
    expect(result.status).toBe("posted");
    expect(result.boards).toEqual({ "lmarena-overall": "ok", "lmarena-coding": "failed" });

    const digest = loadFeedItems(join(harness.stateDir, "feed-items-benchmark.json"))[0];
    expect(digest?.description).toContain("⚠️ ランキングを取得できませんでした。");
    // The failed board keeps its previous snapshot for the next comparison.
    expect(harness.store.loadRanking("lmarena-coding")?.savedAt).toBe("2026-08-15T00:00:00.000Z");
    expect(harness.store.loadRanking("lmarena-overall")?.savedAt).not.toBe(
      "2026-08-15T00:00:00.000Z"
    );
  });

  it("throws without writing anything when every board fails", async () => {
    const harness = createHarness(["model-a"], ["model-x"]);
    harness.setResponse("overall", httpError(500));
    harness.setResponse("coding", httpError(500));
    await expect(run(harness)).rejects.toThrow(/all .* boards failed/);
    expect(existsSync(join(harness.stateDir, "last-posted.json"))).toBe(false);
    expect(existsSync(join(harness.stateDir, "feed-items-benchmark.json"))).toBe(false);
  });

  it("includes AA boards and the mandatory attribution only with a key", async () => {
    const withKey = createHarness(["model-a"], ["model-x"]);
    const result = await run(withKey, { aaApiKey: "test-key" });
    expect(result.skipped).toEqual([]);
    const digest = loadFeedItems(join(withKey.stateDir, "feed-items-benchmark.json"))[0];
    expect(digest?.description).toContain("🧠 AA Intelligence");
    expect(digest?.description).toContain("🛠️ AA Coding");
    expect(digest?.description).toContain(
      "🧠 AA指数 0-100\nデータ: artificialanalysis.ai\n⬆️ 上昇 · ⬇️ 下降 · ➖ 変動なし\n💰 入力/出力 $/1Mトークン"
    );
  });
});

describe("xml regeneration", () => {
  it("writes once and stays byte-identical afterwards", async () => {
    const harness = createHarness(["model-a"], ["model-x"]);
    await run(harness);
    const config = testConfig(harness.stateDir);
    expect(regenerateFeedXml(config, "benchmark")).toBe(true);
    expect(regenerateFeedXml(config, "benchmark")).toBe(false);
  });
});
