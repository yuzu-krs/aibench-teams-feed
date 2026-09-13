// One-off E2E helper: injects a synthetic provider announcement through the
// REAL alert pipeline (classification + seen-models dedup + delta feed) so a
// test card reaches Teams via Power Automate. Not committed to git.
//
// usage: node e2e-new-model.mjs <modelId>
import { runNewModelFeed } from "./dist/newModelFeed.js";
import { loadConfig } from "./dist/config.js";
import { createLogger } from "ai-benchmark-bot/dist/logger.js";
import { StateStore } from "ai-benchmark-bot/dist/state.js";

const modelId = process.argv[2] ?? "pa-flow-e2e-check-1";
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
      key: `e2e-${modelId}`,
      title: `We've launched ${modelId}`,
      url: "https://example.com/announcement",
      summary:
        "Power Automate フロー動作確認用のテスト検知です(自動生成・数分後に自動消滅します)。",
      explicitModelIds: [modelId]
    }
  ]
};

const result = await runNewModelFeed({
  config,
  store,
  logger,
  sources: [fakeSource]
});
console.log("result:", JSON.stringify(result));
console.log("guid: urn:aibench:new-model:e2e-test:" + modelId);
