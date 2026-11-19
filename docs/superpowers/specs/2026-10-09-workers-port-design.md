# Angelic Angel の Workers 移植設計

## 目的と根拠

`sh1ma/Angelic-Angel` の Rust CLI を TypeScript に移植し、Cloudflare Workers 上で X の Web Push 通知を受信、復号、Webhook 転送できるようにする。参照した upstream revision は `169a098e2025cc6e41a50fc8d521c483e21d9b6d`。利用者の依頼は移植であり、Cloudflare 本番へのデプロイや X アカウントでの実登録は今回のローカル実装検証に含めない。

## 構成

- Worker は管理 API を認証し、単一アカウント用の listener Durable Object に転送する。
- listener は Mozilla AutoPush に outbound WebSocket 接続する。HTTP Upgrade による Workers の標準 WebSocket API を使う。outbound 接続は hibernation 非対応なので、通常のイベントリスナーと永続 alarm により再接続する。
- UAID、channel ID、endpoint、P-256 秘密鍵、公鍵、auth secret、登録進行状態、実行希望状態、再接続期限を Durable Object storage に保持する。
- 既存の `Inbox`、`INBOX` binding、`v1` migration は維持する。新 listener は追加 migration を使う。既存の probe は有効な `PROBE_TOKEN` がある場合のみ利用できる。
- 秘密情報は Workers secrets に設定し、管理 API の結果とログに秘密鍵、auth secret、Cookie、通知本文を出さない。
- X の資格情報は `X_AUTH_TOKEN` と `X_CT0` の Workers secrets を使用する。DO の `env` から再登録時にも読み出せるため、HTTP body や独自の資格情報保存 API は追加しない。

## upstream との互換性

- AutoPush の `hello` は `uaid`、`use_webpush: true`、`broadcasts: {}` を含み、`channelIDs` を送らない。
- `register` は新しい UUID channel ID と upstream の X VAPID public key を送る。
- X の `/i/api/1.1/notifications/settings/login.json` に、同一のヘッダー、Cookie、`push_device_info` 形式で endpoint/public key/auth を登録する。
- ECE の `aes128gcm` と legacy `aesgcm` の両方を Web Crypto の ECDH P-256、HKDF SHA-256、AES-GCM で復号する。未指定 encoding は `aes128gcm`。復号した UTF-8 は JSON として転送し、JSON 以外は `{ "raw": text }` にする。
- データなし通知は正常 ACK。正しい鍵での確定的な復号失敗は 101、永続受理済み通知は 100。保存失敗、容量上限、鍵が一時的に利用できない場合は ACK を返さず接続を閉じて復旧する。ACK 102 は再送要求ではないので、汎用例外処理に使用しない。通知 ID は channel と version の組で重複判定する。
- UAID が変わったら鍵と channel を新しくし、X に再登録する。失敗時にも再試行に必要な候補購読を永続保持する。
- 通常の接続失敗は 5 秒から最大 5 分の指数 backoff。close code 4774 は 30 分待機し、cron/status/start でもこの期限を尊重する。
- upstream の TCP keepalive や制御 Ping frame は Workers API に公開されていない。アプリケーション ping `{}` と 10 秒の応答期限で接続状態を監視する。

## API と運用

Bearer `ADMIN_TOKEN` を必須にし、`POST /api/register`、`POST /api/start`、`POST /api/stop`、`GET /api/status`、`POST /api/unregister` を提供する。登録と受信開始は upstream 同様に別操作とする。登録処理は途中状態を保持し、繰り返し要求で購読を乱立させない。未登録での開始は明確なエラーにする。停止は受信と再接続を止め、登録解除は upstream の応答を確認した後に購読情報を除去する。解除は AutoPush の解除を意味し、upstream と同様に X 側の logout API は呼び出さない。

Webhook は固定の HTTPS `WEBHOOK_ENDPOINT` を使う。復号済み通知を永続 outbox に受理してから ACK し、失敗時は alarm で再試行する。容量上限で既存データを黙って捨てない。有限回の失敗後は dead-letter として保持し、状態と管理操作で確認・再試行できる。転送は at-least-once とし、Webhook に安定した通知 ID を付ける。

Cron は listener と未完了の登録解除・outbox を復旧する。停止状態やサーバー backoff を変更しない。停止中も受理済み outbox の配送と未完了の解除処理は進める。単一 Durable Object alarm は heartbeat、再接続、Webhook retry の最も早い期限に合わせて設定する。

候補登録の鍵と channel ID は AutoPush register を送る前に、返された endpoint は X を呼ぶ前に永続化する。X の timeout は結果不明として同じ候補を保持する。ネットワーク待機中は `blockConcurrencyWhile` を保持せず、操作と socket の世代を確認して古い完了結果を排除する。解除 timeout も削除成功とはみなさず、復旧可能な解除状態を保持する。

復号本文は fatal UTF-8 decoding で読み取る。有効な JSON は元の文字列を転送し、64-bit ID などを JavaScript number の round-trip で変質させない。JSON 以外のみ `{ "raw": text }` に変換する。

## 計画レビューの反映

- Claude Code Sonnet の独立レビューを完了。単一 alarm の多用途化、outbound socket の重複禁止・世代管理、再起動時の実行意図復元、secret の非公開、X API 失敗時の候補保持を受け入れる。
- 現在の CI は存在しない `production` / `staging` 環境へ deploy している。既存 Worker 名 `x-push-probe` は保持し、本番 deploy は default branch の top-level 設定へ、staging は別 Worker とその bindings へ明示的に分離する。
- `bun.lock` が未追跡で frozen install が保証されていなかった。lockfile を納品物に含める。Miniflare を明示的な dev dependency にし、純粋モジュールの Bun test と DO の Workers runtime test を分ける。
- Claude 実行環境は Linux、Codex の target は macOS。同じソースは読み書きできるが、共有 `node_modules` の Darwin native binaries は Claude で実行できない。Claude は共有 dependency directory を Linux install で上書きせず、Codex が macOS で全ツールを検証する。
- legacy ECE の複数 record は Python `http_ece 1.2.1` で生成・復号した独立 fixture で検証する。レビューの「single-record のみ」という想定には依存しない。
- LocalGPT GPT 6 Pro の独立レビューを完了。ACK の terminal/transient 区別、外部副作用前の write-ahead 保存、停止中の配送・解除復旧、JSON の整数精度保持、実際の Worker namespace 維持を反映する。

実装レビューで、登録済み channel のローカル鍵が利用できない場合と、購読を持たない別 channel の通知を区別した。前者は ACK を返さず復旧し、後者のみ ACK 102 を返す明示的な terminal routing rejection とする。正しい鍵での確定的な ciphertext/UTF-8 失敗は 101。`queueFull` で容量状態を表示する。

## 検証

- RFC/独立した実装で作成した既知の暗号ベクトルで復号互換性を検証する。破損、padding、record 境界、不正な encoding/headers を拒否する。
- protocol parser、X 登録 request、payload 変換、認証と秘密の非公開を検証する。
- Workers runtime で模擬 AutoPush と X/Webhook を使い、実際の upgrade、永続 storage、登録から通知/ACK/転送、再接続と解除の経路を検証する。
- `bun test`、型検査、lint、Wrangler の deploy dry-run を実行する。外部アカウントの資格情報がないため、X/Mozilla の本番互換性は実登録時に確認が必要であることを README に明記する。

## 資料

- https://github.com/sh1ma/Angelic-Angel/tree/169a098e2025cc6e41a50fc8d521c483e21d9b6d
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/api/alarms/
- https://www.rfc-editor.org/rfc/rfc8291
- https://www.rfc-editor.org/rfc/rfc8188
