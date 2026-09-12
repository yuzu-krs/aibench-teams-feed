import { readFileSync } from "node:fs";
import { createLogger, errorFields } from "ai-benchmark-bot/dist/logger.js";
import { StateStore } from "ai-benchmark-bot/dist/state.js";
import { runBenchmarkFeed } from "./benchmarkFeed.js";
import { loadConfig } from "./config.js";
import { feedXmlPath, regenerateFeedXml } from "./feeds.js";
import { runNewModelFeed } from "./newModelFeed.js";
import { validateRssXml } from "./rssBuilder.js";

const FEED_IDS = ["new-model", "benchmark"] as const;

const USAGE = `usage: node dist/cli.js <command>

commands:
  auto        new-model poll + gated benchmark digest (scheduled default)
  new-model   new-model poll only
  benchmark   benchmark digest [--force bypasses the daily gate]
  validate    check that both feed XML files parse as RSS`;

async function main(): Promise<void> {
  const [command = "auto", ...flags] = process.argv.slice(2);

  if (command === "validate") {
    const config = loadConfig();
    for (const feedId of FEED_IDS) {
      const target = feedXmlPath(config.rssDir, feedId);
      validateRssXml(readFileSync(target, "utf8"), target);
    }
    console.log("rss ok");
    return;
  }

  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const store = new StateStore(config.stateDir);

  switch (command) {
    case "auto": {
      const newModel = await runNewModelFeed({ config, store, logger });
      const benchmark = await runBenchmarkFeed({ config, store, logger });
      logger.info("feed update finished", {
        newModelAlerts: newModel.alerts,
        newModelItemsAdded: newModel.itemsAdded,
        benchmarkStatus: benchmark.status
      });
      break;
    }
    case "new-model": {
      const result = await runNewModelFeed({ config, store, logger });
      logger.info("new-model feed finished", {
        alerts: result.alerts,
        itemsAdded: result.itemsAdded
      });
      break;
    }
    case "benchmark": {
      const result = await runBenchmarkFeed({
        config,
        store,
        logger,
        force: flags.includes("--force")
      });
      logger.info("benchmark feed finished", {
        status: result.status,
        boards: result.boards,
        skipped: result.skipped
      });
      break;
    }
    default:
      throw new Error(`unknown command: ${command}\n${USAGE}`);
  }

  // Both feeds regenerate after every command: a crash after state advanced
  // but before the last XML write heals here on the next run, and unchanged
  // feeds are byte-identical so this writes nothing.
  for (const feedId of FEED_IDS) {
    if (regenerateFeedXml(config, feedId)) logger.info("feed xml updated", { feed: feedId });
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ level: "error", message: "feed update failed", ...errorFields(error) }));
  process.exit(1);
});
