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
| `HUGGINGFACE_TOKEN` | なし | HF datasets-server のレート制限対策 |
| `GITHUB_TOKEN` | なし | LiveBenchスナップショット探索(api.github.com)のレート制限対策 |
| `TIME_ZONE` | `Asia/Tokyo` | dateKey・表示の基準タイムゾーン |
| `DIGEST_HOUR` / `DIGEST_MINUTE` | `6` / `0` | benchmark 発火時刻(JST) |
| `FEED_BASE_URL` | `https://yuzu-krs.github.io/aibench-teams-feed` | channel link |
| `STATE_DIR` / `RSS_DIR` | `./state` / `./docs/rss` | 出力先 |
| `NEW_MODEL_MAX_ITEMS` / `BENCHMARK_MAX_ITEMS` | `200` / `90` | フィード保持件数 |
| `LOG_LEVEL` | `info` | debug/info/warn/error |

Secret をリポジトリに置かないこと。Actions では `GITHUB_TOKEN`(workflow 内で
`github.token` を使用)と `HUGGINGFACE_TOKEN` を GitHub Actions Secrets に設定する
(Discord token はこのプロジェクトに存在しない)。

## bot 依存の更新手順

1. ai-benchmark-bot を変更しテスト → main に push
2. `git tag vX.Y.Z && git push origin vX.Y.Z`
3. 本リポジトリで `package.json` の ref を更新 → `npm install`
4. **`npm approve-scripts ai-benchmark-bot`**(npm の install スクリプト承認。SHA pinned で
   `allowScripts` に記録されるのでこれを忘れると `npm ci` で prepare が走らない)
5. `npm test`(golden テストが描画のドリフトを検出)→ commit

## 運用

- 普段は無運用。Actions の赤ランは障害シグナル。state 破損時は `git revert` で復旧
- cron は UTC 指定で 0〜40 分遅延する。benchmark digest が **06:17〜06:45 JST 頃**に
  生成されるのは正常。目的は **07:00 の Teams 公開に先立って最新データを生成
 しておく**こと(06:17 生成 → 07:00 公開)
- Power Automate 側に独自の通知済み管理を作らない(GUID による重複排除に委任し、
  実挙動は E2E で確認する)
- **new-model.xml は差分フィード**のため、item は次回実行(最大約1時間後)で
  置き換わる。取りこぼしを避けるなら PA の New Model ポーリングは 1 時間より
  短い間隔(例: 30 分)にする。benchmark.xml は 90 日保持なので 24 時間間隔で十分
- PA 初回接続時の大量通知を防ぐため、**フィードが空の状態で接続する**
  (過去 item の backfill はしない)

## Power Automate での判定方法(item の有無と新着検出)

PA の標準 RSS トリガー「フィードアイテムが公開されるとき」は、ポーリングごとに
フィードを取得し、**取得した item の GUID が既読(トリガー状態に記録済み)かどうか**
だけで新着を判定する。PA 側にこちらの state は不要で、フィードの GUID の安定性だけが
前提になる。

| フィードの状態 | PA の動作 |
|---|---|
| `<item>` なし(空フィード) | 新着候補ゼロ → **フローは実行されない**(Teams投稿も無し) |
| item あり & GUID 未処理 | フローが実行され、未処理 item が動的コンテンツに渡る |
| item あり & GUID 処理済み | 実行されない(同一 GUID は二度と届かない) |

- **new-model.xml は差分フィード**: Actions の実行ごとに丸ごと置き換わる。
  新規検出 0 件の時間帯は空フィードになるため PA は何もせず、検出された実行の
  item だけが1度だけ届く。1 実行で複数モデルを検出した場合は 1 回のフロー実行に
  複数 item が入るため、Teams 投稿は「Apply to each(各々に適用)」でループさせる。
- **benchmark.xml は履歴フィード**(1日1item・90日保持): 毎日新しい dateKey の
  GUID が1件増えるだけ。24時間間隔のポーリングでもズレて見えるだけで
  取りこぼしはない。
- **初回接続**: フィードが空の状態で接続する(new-model は通常ずっと空)。
  PA の初回ポーリングが既存 item を「新着」として扱うかは仕様上断定できないため、
  接続直後の実行履歴で E2E 確認をする。GUID が常に安定しているため、PA 側の
  実挙動によらず二重通知は構造的に防がれている。

### PA フローの構築手順

2 本とも同じ構成で、**トリガーの URL とポーリング間隔だけが違う**。

| フロー | RSS URL | 間隔 |
|---|---|---|
| New Model 通知 | `https://yuzu-krs.github.io/aibench-teams-feed/rss/new-model.xml` | **30分**(推奨) |
| Benchmark digest | `https://yuzu-krs.github.io/aibench-teams-feed/rss/benchmark.xml` | **24時間** |

1. make.powerautomate.com →「作成」→「自動クラウド フロー」→
   トリガー検索「RSS」→「**フィードアイテムが公開されるとき**」を選択
2. トリガー設定: 接続名は任意、**RSS URL** に上表の URL、
   頻度 `分`/間隔 `30`(New Model)または `時間`/間隔 `24`(Benchmark)を入れて保存
3. 保存するとトリガーの下に「**Apply to each(各々に適用する)**」が自動で付く
   (トリガー出力が item 配列のため。benchmark は基本 1 件なので 1 周だけ実行)
4. その中に Teams アクション「**チャットまたはチャネルでメッセージを投稿する**」を追加:
   - 投稿者: Flow bot / 投稿先: チャネル(お好み)
   - チーム・チャネル: 投稿先を選択
   - Message: 次の**式**(fx)を入力 — description を直接入れないこと
     (改行が潰れる。下記「Teams 投稿で改行を表示する」参照)

       replace(trim(item()?['description']), decodeUriComponent('%0A'), '<br/>')

   - description の1行目は 📅(benchmark)または 🏢(new-model)で始まるため、
     title を重ねなくても内容は判別可能。見出しを付けたい場合は Message 先頭に
     `item()?['title']` を連結
5. 動作確認: Apply to each の先頭に「**作成(Compose)**」を置き、同じ式の出力を
   実行履歴で確認してから Teams アクションに接続すると確実
6. New Model フローの初回 E2E は、テスト検知 item を配信してから行う。
   リポジトリの `e2e-new-model.mjs` が公式パイプライン経由でテスト検知を
   差分フィードに掲載する(ID には既知ファミリー名 `gpt` 等を含める必要あり):

       node e2e-new-model.mjs gpt-e2e-check-1
       git add state docs && git commit -m "test: PA E2E" && git push

   配信済み item は次の毎時実行で自動消滅する(差分フィードの設計)。
   消滅後の再テストは ID の番号を変えて再実行。

### Teams 投稿で改行を表示する(new-model / benchmark 両フロー共通)

Teams コネクタはメッセージを HTML として描画するため、description 内の
改行文字(`\n`)はそのまま挿入すると詰めて表示される。**New Model 通知と
Benchmark digest の両方のフローで同じ対応が必要**。description を
メッセージに直接入れず、**式で `<br/>` に置換**する:

```
replace(trim(item()?['description']), decodeUriComponent('%0A'), '<br/>')
```

`trim()` を忘れると、コネクタが description の末尾に付加する改行まで
`<br/>` 変換されてカード最下部に空行が残る。

- Apply to each 内の item は `item()?['description']`、トリガー直挿しなら
  `triggerBody()?['description']`
- 「作成(Compose)」アクションで一度出力を確認してからメッセージへ接続すると確実
- 「カードを投稿(Adaptive Card)」を使う場合は TextBlock に `"wrap": true` も設定
- フィード側の description はプレーンテキスト+\n(RSS標準)を維持し、
  HTML 変換は PA フロー側でのみ行う(仕様)

### データの日付について

digest ヘッダーの `🕒 取得:` はフィードを取得した日時。各セクションの日付は
**ソース側が公開したデータの日付**であり、フィードは毎回最新を取得するが、
ソース自身が更新しなければ日付は進まない。

- Arena Coding の `データ: YYYY-MM-DD 時点` = 公式データセットの
  `leaderboard_publish_date`(Arena の公開ペースは 1〜2 日ごと)
- LiveBench の `Snapshot: YYYY-MM-DD` = livebench.ai 配信ファイルの
  Last-Modified(リリースは数週間ごとだが、ファイル自体は随時上書き更新される。
  キャッシュバストは 1 時間単位で、同一日中の CDN 古びれも発生しない)

## Data Sources

Benchmark RSS は GHC(コーディング用途)のモデル選定を目的とし、
**Arena Coding** と **LiveBench** の2ソースのみを扱う。
Arena Overall・MMLU-Pro・Artificial Analysis は本RSSに含めない。

### Arena / LMArena (Arena Coding)

Benchmark rankings are sourced from the public Arena leaderboard
dataset on Hugging Face. The Arena website is never scraped and no
automated queries are sent to the Arena web service.

Dataset:
https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset

License:
CC BY 4.0

Arena:
https://arena.ai/

### LiveBench

LiveBench scores are sourced from the official LiveBench published
leaderboard snapshots and scored with the official aggregation formula
(category mean of task scores, overall = mean of category means).

Site:
https://livebench.ai/

GitHub:
https://github.com/livebench/livebench

License:
Apache License 2.0

Note: the LiveBench project is licensed Apache License 2.0; the score data
is published on livebench.ai without a separate data-license file. Every
digest credits it in the footer.

### OpenRouter

Model prices shown in the RSS come from the public OpenRouter models API
(unauthenticated, no API key) and are credited in
the digest footer. aibench-teams-feed is not affiliated with OpenRouter.

Effort-tier names ("-max", "-xhigh", …) share the base listing's per-token
unit price; when the tier itself is not listed on OpenRouter, the price is
resolved from the base model. Models absent from OpenRouter entirely are
shown without a price.

Site:
https://openrouter.ai/

### Artificial Analysis

Artificial Analysis data is used separately by AIBench where permitted
by the applicable Artificial Analysis API and Data Platform Terms.

Artificial Analysis data is not redistributed through the public
aibench-teams-feed RSS.

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
