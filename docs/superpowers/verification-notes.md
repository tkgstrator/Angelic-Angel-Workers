# 検証環境のメモ

- Codex native host: `studio.local`, macOS arm64。Claude / LocalMCP は同じプロジェクトを Linux arm64 container に mount して参照する。
- 既存 native dependency directory を Linux install で上書きしない。workerd、Biome、TypeScript 7 の native 実行は Codex の macOS 側で検証する。
- Wrangler `4.148.0` は Miniflare `5.20261006.0-alpha` / workerd `1.20261006.1` を使用する。
- Miniflare 5 は旧 `new Miniflare({ workers: [{ name, modules, script, durableObjects, ... }] })` を直接受け付けない。exported `convertV4MiniflareOptions` で既存形式を変換するか、新しい `workers[].config` 形式を使う。旧 README の例だけで API を判断しない。
- 独立 Python `http_ece 1.2.1` fixture は `__tests__/fixtures/legacy-ece.json` にある。短い日本語 JSON と 6311-byte の複数 record 本文を生成し、同じ Python library で復号結果を確認した。runtime production code から fixture 暗号化 helper を流用しない。
- baseline: Bun の placeholder 1 test と TypeScript 型検査は成功。Biome は既存 `src/index.ts` の整形不一致で失敗した。
- baseline production dry-run は不存在の `env.production` を警告した。本番の実配置先を保つため、default branch は top-level config を使い、staging のみ `--env staging` を使う。

## 実装後の検証 (2026-10-09)

- `bun run test`: Bun 単体 25 件、Node/workerd 統合 30 件、計 55 件が成功。
- `bun run typecheck`: production と test 用の両 TypeScript 設定が成功。
- `bun run lint`: 成功。既存 frontend 用 Date plugin が標準 ISO timestamp に警告 1 件を出す。
- production / staging の Wrangler deploy dry-run は両方成功。`Inbox` と `Angelic` の bindings を確認した。本番配置は行っていない。
- Node/workerd の外部模擬サービス自体も Durable Object にし、socket の I/O context を維持する。Bun は純粋モジュール、Node は Miniflare integration を担当する。
- Workers は `redirect: 'error'` を受け付けない。X と Webhook は `manual` にして、3xx を失敗として処理する。
- Miniflare 5 の永続化設定は `resourcePersistencePath`。実際の workerd process を終了・再作成して cold restore を検証した。実装から test-only hooks を呼んで復元を偽装していない。
- 保存失敗・容量上限で ACK が送られず、record が作られないこと、停止中の再配送、解除 timeout の復旧、UAID の更新、cold restore、安定した配送 ID を検証した。
- 模擬サービス以外の X/Mozilla/Webhook への実呼び出し、Cloudflare 本番上の長時間接続は未検証。
- 全 runtime は `finally` で dispose し、その実行が作った一時 directory を削除する。macOS 側でテスト後に workerd process が残っていないことを確認した。

## 実装レビュー

- Claude Code Opus の独立レビュー完了。未登録 channel の再接続ループと、ローカル鍵の import failure を ciphertext failure として扱う問題を再現テストで確認して修正した。前者は明示的な terminal ACK 102、後者は `KeyUnavailableError` として no ACK。容量表示を追加した。
- Claude Code Sonnet の独立した修正レビュー完了。blocking / correctness findings なし。追加の heartbeat timeout と解除中 4774 の runtime test も成功した。
- LocalGPT GPT 6 Pro の**計画レビューは完了**した。実装の最終レビューは共有ブラウザが切断され、結果を確認できていない。再送も remote cancellation も行っていない。
- 継続用 LocalGPT session: `051d3105-3251-4017-a0df-9c9f7ba82f82`、最終レビュー job: `abff9c13-d684-4bd5-bc2c-8e8d188f529d`、conversation: `6ac7d4ae-ef04-83e8-ac98-23ef5fd5b6e6`。再接続後は既存 job の結果確認を優先し、重複依頼しない。
- Git commit / push は行っていない。元 HEAD `0d459b7` を維持し、変更は作業ツリーにある。

## 400 行を超えるコードの分割 (2026-10-09)

- `src/angelic.ts` は 977 → 328 行。接続管理 307 行、登録・解除 226 行、通知受付 104 行、配送 87 行、状態保存 60 行、safe error 18 行へ責務を分けた。
- `__tests__/core.test.ts` は ECE 216 行、AutoPush 115 行、X 登録 99 行へ分割。共通 RFC vector は 22 行。各 describe block は元の本文と一致する。
- 分割前後とも `bun run test` は 25 単体 / 103 assertions と 30 workerd 統合テストが成功。保存後 ACK、キャンセル、cold restore、解除 timeout、heartbeat、停止中配送を含む。
- 両 TypeScript 設定、lint、`git diff --check`、本番と staging の dry-run が成功。lint の既存 Date 警告 1 件は継続。dry-run は 56.63 KiB / gzip 14.55 KiB、DO bindings の変更なし。
- ソースとテストのコード 25 ファイルはすべて 400 行以内、最大 328 行。対象外の既存ソース・テストは SHA-256 で変更なしを確認。テスト用 driver もそのまま使用できた。
- Claude Sonnet の計画レビュー `job_d5ab71bbdb33766d5107592eff9ffaef`、実装 `job_b959a9dc782189f4882e03292f4ebba3`、最終独立レビュー `job_4dbc383e028715f2f5a3332d3db051d7` は完了。新規の動作退行なし。内部メソッドの private 化とコメント・歴史的な ownership 表記を整えた。
- Reviewer の静的 `expect` call site 数 62 と、Bun の実行 assertion 数 103 は別の指標。fixture loop と helper 呼び出しを含む実行数は分割前後とも 103。
- LocalGPT はブラウザ未接続のため新規依頼を行わず、Claude を代替レビュー経路として使用した。実装前の比較用 snapshot は `.wrangler/refactor-400-baseline-20261009` に保存した。
