import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({});
    expect(config.feedBaseUrl).toBe("https://yuzu-krs.github.io/aibench-teams-feed");
    expect(config.timeZone).toBe("Asia/Tokyo");
    expect(config.digestHour).toBe(6);
    expect(config.digestMinute).toBe(0);
    expect(config.newModelMaxItems).toBe(200);
    expect(config.benchmarkMaxItems).toBe(90);
    expect(config.logLevel).toBe("info");
    expect(config.stateDir).toMatch(/state$/);
    expect(config.rssDir).toMatch(/rss$/);
  });

  it("coerces numeric env strings", () => {
    const config = loadConfig({ NEW_MODEL_MAX_ITEMS: "50", DIGEST_HOUR: "8" });
    expect(config.newModelMaxItems).toBe(50);
    expect(config.digestHour).toBe(8);
  });

  it("strips trailing slashes from FEED_BASE_URL", () => {
    expect(loadConfig({ FEED_BASE_URL: "https://example.test/feed///" }).feedBaseUrl).toBe(
      "https://example.test/feed"
    );
  });

  it("rejects an invalid IANA time zone", () => {
    expect(() => loadConfig({ TIME_ZONE: "Mars/Olympus" })).toThrow();
  });

  it("turns blank secrets into undefined", () => {
    const blank = loadConfig({ GITHUB_TOKEN: "  ", HUGGINGFACE_TOKEN: "" });
    expect(blank.githubToken).toBeUndefined();
    expect(blank.huggingFaceToken).toBeUndefined();
    const set = loadConfig({ GITHUB_TOKEN: "key" });
    expect(set.githubToken).toBe("key");
  });
});
