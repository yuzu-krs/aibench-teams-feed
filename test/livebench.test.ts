import { describe, expect, it } from "vitest";
import { fetchLiveBenchTop } from "../src/livebench.js";
import { silentLogger } from "./helpers.js";
import type { Logger } from "ai-benchmark-bot/dist/logger.js";

/**
 * The official RELEASES constant lists 2026-09-04 as the newest release even
 * though the deployed gh-pages listing still only carries 2026-06-25 files —
 * discovery must pick the newest, never the stale one.
 */
const CONSTANTS_JS = `// Release dates that have a published table_<date>.csv (+ categories, + optional cost).
export const RELEASES = [
  "2024-06-24", "2024-07-26", "2024-08-31", "2024-11-25",
  "2025-04-02", "2025-04-25", "2025-05-30",
  "2025-11-25", "2025-12-23", "2026-01-08", "2026-06-25", "2026-09-04",
];`;

/** A stale deployed listing: only 2026-06-25 files. */
const STALE_LISTING = [
  { name: "index.html", type: "file" },
  { name: "table_2026_06_25.csv", type: "file" },
  { name: "categories_2026_06_25.json", type: "file" }
];

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
 * The fresh 2026-09-04 data: a brand-new model tops the ranking, and the two
 * legacy grok models exercise the site's hardcoded overall overrides.
 */
const FRESH_CSV = [
  "model,code_generation,code_completion,javascript,AMPS_Hard,theory_of_mind,tablejoin,typos,summarize",
  "nemotron-3-ultra-550b-a55b,85,85,85,85,85,85,85,85",
  "model-a,80,80,80,80,80,80,80,80",
  "grok-3-thinking,90,90,90,90,90,90,90,90",
  "grok-3,50,50,50,50,50,50,50,50"
].join("\n");

const LAST_MODIFIED = "Thu, 10 Sep 2026 15:13:40 GMT";

type Slot =
  | "constants"
  | "listing"
  | "live-table"
  | "live-categories"
  | "gh-table"
  | "gh-categories"
  | "dead";

function createFetch(slots: Partial<Record<Slot, () => Promise<Response>>>, requests: string[]) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    let slot: Slot | undefined;
    if (url.includes("src/lib/constants.js")) slot = "constants";
    else if (url.includes("api.github.com")) slot = "listing";
    else if (url.includes("livebench.ai") && url.includes("table_")) slot = "live-table";
    else if (url.includes("livebench.ai") && url.includes("categories_")) slot = "live-categories";
    else if (url.includes("new-livebench/gh-pages") && url.includes("table_")) slot = "gh-table";
    else if (url.includes("new-livebench/gh-pages") && url.includes("categories_")) slot = "gh-categories";
    else slot = "dead";
    const responder = slots[slot];
    if (!responder) return new Response("not found", { status: 404 });
    return responder();
  }) as typeof fetch;
}

function jsonResponse(payload: unknown, headers: Record<string, string> = {}): () => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json", ...headers }
      })
    );
}

function textResponse(body: string, headers: Record<string, string> = {}): () => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "text/csv", ...headers } })
    );
}

function run(
  slots: Partial<Record<Slot, () => Promise<Response>>>,
  logs?: { warns: Array<{ message: string; [key: string]: unknown }> }
) {
  const requests: string[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, fields) => {
      logs?.warns.push({ message, ...fields });
    },
    error: () => undefined
  };
  const result = fetchLiveBenchTop({
    topN: 10,
    logger,
    fetchFn: createFetch(slots, requests)
  });
  return { result, requests };
}

describe("fetchLiveBenchTop release discovery", () => {
  it("picks the newest release from the official RELEASES constant, not the stale listing", async () => {
    const { result, requests } = run({
      constants: textResponse(CONSTANTS_JS),
      listing: jsonResponse(STALE_LISTING),
      "live-table": textResponse(FRESH_CSV, { "last-modified": LAST_MODIFIED }),
      "live-categories": jsonResponse(CATEGORIES)
    });
    const board = await result;
    expect(board.releaseDate).toBe("2026-09-04");
    // Snapshot date = the data actually used (served file's Last-Modified).
    expect(board.snapshotDate).toBe("2026-09-10");
    // No request for the stale release's files.
    expect(requests.some((request) => request.includes("table_2026_06_25"))).toBe(false);
  });

  it("serves the fresh live site copy with the official formula and overrides", async () => {
    const { result } = run({
      constants: textResponse(CONSTANTS_JS),
      listing: jsonResponse(STALE_LISTING),
      "live-table": textResponse(FRESH_CSV, { "last-modified": LAST_MODIFIED }),
      "live-categories": jsonResponse(CATEGORIES)
    });
    const board = await result;
    expect(board.entries[0]?.name).toBe("nemotron-3-ultra-550b-a55b");
    expect(board.entries[0]?.scoreDisplay).toBe("85.00");
    // The site's hardcoded overall overrides are replicated.
    const grokThinking = board.entries.find((entry) => entry.name === "grok-3-thinking");
    const grok3 = board.entries.find((entry) => entry.name === "grok-3");
    expect(grokThinking?.scoreDisplay).toBe("72.00");
    expect(grok3?.scoreDisplay).toBe("58.00");
    expect(board.entries.find((entry) => entry.name === "model-a")?.coding).toBeCloseTo(80, 5);
  });

  it("falls back to the deployed gh-pages copy of the SAME release when the live site fails", async () => {
    const logs: { warns: Array<{ message: string }> } = { warns: [] };
    const { result, requests } = run(
      {
        constants: textResponse(CONSTANTS_JS),
        listing: jsonResponse(STALE_LISTING),
        "live-table": () => Promise.resolve(new Response("gone", { status: 404 })),
        "live-categories": () => Promise.resolve(new Response("gone", { status: 404 })),
        "gh-table": textResponse(FRESH_CSV, { "last-modified": LAST_MODIFIED }),
        "gh-categories": jsonResponse(CATEGORIES)
      },
      logs
    );
    const board = await result;
    // Same release, never an older one.
    expect(board.releaseDate).toBe("2026-09-04");
    expect(board.entries[0]?.name).toBe("nemotron-3-ultra-550b-a55b");
    expect(requests.some((request) => request.includes("table_2026_06_25"))).toBe(false);
    expect(logs.warns.some((warn) => warn.message.includes("fallback source"))).toBe(true);
  });

  it("recovers when only the gh-pages listing is available", async () => {
    const { result } = run({
      constants: () => Promise.resolve(new Response("boom", { status: 500 })),
      listing: jsonResponse([
        { name: "table_2026_06_25.csv", type: "file" },
        { name: "table_2026_09_04.csv", type: "file" },
        { name: "categories_2026_09_04.json", type: "file" }
      ]),
      "live-table": textResponse(FRESH_CSV, { "last-modified": LAST_MODIFIED }),
      "live-categories": jsonResponse(CATEGORIES)
    });
    const board = await result;
    expect(board.releaseDate).toBe("2026-09-04");
  });

  it("treats LiveBench as unavailable when the newest release exists nowhere", async () => {
    const { result } = run({
      constants: textResponse(CONSTANTS_JS),
      listing: jsonResponse(STALE_LISTING)
      // no source carries table_2026_09_04.csv
    });
    await expect(result).rejects.toThrow(/unavailable from any official source/);
  });
});
