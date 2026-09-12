# aibench-teams-feed

AI モデルの新着情報(New Model Alert と デイリーランキング)を RSS Feed として
GitHub Pages に公開し、Power Automate の標準 RSS トリガー経由で Microsoft Teams
へ届けるシステム。

```
ai-benchmark-bot (v1.1.1, npm git dependency)
        ↓ ロジック再利用(検知・ランキング・比較・整形・state)
   GitHub Actions (毎時 cron 17 * * * *)
        ↓ node dist/cli.js auto
   state/*.json 更新 + docs/rss/*.xml 再生成(差分時のみ commit)
        ↓ GitHub Pages (main / docs)
   https://yuzu-krs.github.io/aibench-teams-feed/rss/new-model.xml
   https://yuzu-krs.github.io/aibench-teams-feed/rss/benchmark.xml
        ↓ Power Automate 標準 RSS トリガー
   Microsoft Teams
```

## 設計の要点

- **ロジックは二重実装しない**: 新モデル検知(`pollNewModelAlerts`)・ランキング取得
  (`buildRankedBoards`)・前日比較(`compareWithPrevious`)・行整形(`buildBoardValue`)・
  state(`StateStore`)は [ai-benchmark-bot](https://github.com/yuzu-krs/ai-benchmark-bot)
  の `dist/` を直接 import する。依存は `package.json` の
  `github:yuzu-krs/ai-benchmark-bot#v1.1.1` で commit SHA まで固定。
- **GUID は安定・不変**(重複通知防止の必須要件):
  - New Model: `urn:aibench:new-model:<providerId>:<modelId>`(モデル単位)
  - Benchmark: `urn:aibench:benchmark:<YYYY-MM-DD>`(JST, 1日1件)
  - Benchmark は同一 GUID の再発行でも既存レコードが勝つ(内容・pubDate は初回作成時に凍結)
- **new-model.xml は差分フィード**: 今回の実行で新規検出されたモデルだけを掲載し、
  次回実行で丸ごと置き換わる。新規 0 件なら `<item>` なしの有効な RSS になる。
  検知済みかどうかの永続管理は `state/seen-models.json` のみが担う(RSSは差分、
  seen-models は永続状態と明確に分離)。benchmark.xml は1日1itemを90件保持する
  履歴フィードのまま変更なし。
- **no-op では commit しない**: 変化がないとき XML はバイト等価。`lastBuildDate` は
  最新 item の pubDate を使うため wall clock に依存しない。
- **benchmark の日次ゲート**: 「JST 07:00 以降」かつ「今日の dateKey 未記録」の両方を
  満たした最初の毎時実行が発火。cron 遅延・一時的障害は翌時の実行が自動回収する。
  全ボード取得失敗時は何も書かず exit 1(「取得できませんでした」カードは流さない)。
- **状態は git で管理**(`state/*.json`)。bot の `data/` と同一スキーマなので、
  自宅サーバーの `data/*.json` を `state/` にコピーすれば経験の引き継ぎ(シード)も可能。
- **土日祝の扱いなし**(毎日・毎時)。将来「平日のみ」へは
  `src/benchmarkFeed.ts` の `shouldRunBenchmark` に曜日チェックを追加するだけ。

## コマンド

```bash
npm ci                    # bot 依存を pinned SHA から構築(prepare が dist/ を生成)
npm test                  # vitest(ネットワークなし)
npm run build             # dist/ へコンパイル
npm run feed -- auto      # new-model + benchmark(ゲート付き)= Actions の既定
npm run feed -- new-model
npm run feed -- benchmark --force   # ゲート無視(手動確認用)
npm run feed -- validate  # docs/rss/*.xml の整合性チェック
```

## 環境変数(すべて任意)

| 変数 | 既定 | 説明 |
|---|---|---|
| `AA_API_KEY` | なし | Artificial Analysis。無ければ AA 2ボードを skip |
| `HUGGINGFACE_TOKEN` | なし | HF datasets-server のレート制限対策 |
| `TIME_ZONE` | `Asia/Tokyo` | dateKey・表示の基準タイムゾーン |
| `DIGEST_HOUR` / `DIGEST_MINUTE` | `7` / `0` | benchmark 発火時刻(JST) |
| `FEED_BASE_URL` | `https://yuzu-krs.github.io/aibench-teams-feed` | channel link |
| `STATE_DIR` / `RSS_DIR` | `./state` / `./docs/rss` | 出力先 |
| `NEW_MODEL_MAX_ITEMS` / `BENCHMARK_MAX_ITEMS` | `200` / `90` | フィード保持件数 |
| `LOG_LEVEL` | `info` | debug/info/warn/error |

Secret をリポジトリに置かないこと。Actions では `AA_API_KEY` と `HUGGINGFACE_TOKEN`
を GitHub Actions Secrets に設定する(Discord token はこのプロジェクトに存在しない)。

## bot 依存の更新手順

1. ai-benchmark-bot を変更しテスト → main に push
2. `git tag vX.Y.Z && git push origin vX.Y.Z`
3. 本リポジトリで `package.json` の ref を更新 → `npm install`
4. **`npm approve-scripts ai-benchmark-bot`**(npm の install スクリプト承認。SHA pinned で
   `allowScripts` に記録されるのでこれを忘れると `npm ci` で prepare が走らない)
5. `npm test`(golden テストが描画のドリフトを検出)→ commit

## 運用

- 普段は無運用。Actions の赤ランは障害シグナル。state 破損時は `git revert` で復旧
- cron は UTC 指定で 0〜40 分遅延する。benchmark が 07:17〜07:45 JST 頃に届くのは正常
- Power Automate 側に独自の通知済み管理を作らない(GUID による重複排除に委任し、
  実挙動は E2E で確認する)
- **new-model.xml は差分フィード**のため、item は次回実行(最大約1時間後)で
  置き換わる。取りこぼしを避けるなら PA の New Model ポーリングは 1 時間より
  短い間隔(例: 30 分)にする。benchmark.xml は 90 日保持なので 24 時間間隔で十分
- PA 初回接続時の大量通知を防ぐため、**フィードが空の状態で接続する**
  (過去 item の backfill はしない)

## ディレクトリ

```
src/       feed本体(types/config/feedStore/rssBuilder/feeds/newModelFeed/benchmarkFeed/cli)
state/     git管理の状態(seen-models, <board>.json, last-posted, feed-items-*.json)
docs/      Pages で配信する内容(index.html と rss/*.xml は生成物)
test/      vitest(bot の fixture スタイル、ネットワークなし)
```

## ローカル参照コピーについて

`ai-benchmark-bot/` は開発時の参照用クローンで **gitignore 済み**(ローカルの
secret を含むため force add 禁止)。いつでも削除して問題ない。
