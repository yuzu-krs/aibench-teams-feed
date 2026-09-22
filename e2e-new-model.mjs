// One-off E2E helper: injects a synthetic provider announcement through the
// REAL alert pipeline (classification + seen-models dedup + daily digest) so
// a test card reaches Teams via Power Automate. Not committed to git.
//
// The card publishes immediately (force bypasses the daily gate), but the
// new-model PA flow polls once a day (~07:00 JST). Run this BEFORE the day's
// scheduled publication (~06:17 JST) so the card is delivered at 07:00 —
// a force publish AFTER it overwrites the day's real card (one card per day).
// To test mid-day instead, temporarily set the PA flow to a short interval.
//
// usage: node e2e-new-model.mjs <modelId>
import { runNewModelFeed } from "./dist/newModelFeed.js";
import { loadConfig } from "./dist/config.js";
import { localDateKey } from "ai-benchmark-bot/dist/time.js";
import { createLogger } from "ai-benchmark-bot/dist/logger.js";
import { StateStore } from "ai-benchmark-bot/dist/state.js";

const modelIds = process.argv.slice(2);
if (modelIds.length === 0) {
  console.error("usage: node e2e-new-model.mjs <modelId> [<modelId> ...]");
  process.exit(1);
}
const config = loadConfig();
const logger = createLogger(config.logLevel);
const store = new StateStore(config.stateDir);

const fakeSource = {
  id: "e2e-test",
  providerName: "E2E Test Provider",
  displayName: "e2e test docs",
  fetchUrl: "https://example.com/",
  accept: "text/html",
  parse: () => [
    {
      key: `e2e-${modelIds.join("-")}`,
      title: `We've launched ${modelIds.join(" and ")}`,
      url: "https://example.com/announcement",
      summary:
        "Power Automate フロー動作確認用のテスト検知です(自動生成・翌朝06:17頃の次回公開で消滅します)。",
      explicitModelIds: modelIds
    }
  ]
};

const result = await runNewModelFeed({
  config,
  store,
  logger,
  sources: [fakeSource],
  force: true
});
console.log("result:", JSON.stringify(result));
console.log(
  "guid: urn:aibench:new-model:" + localDateKey(new Date(), config.timeZone)
);
