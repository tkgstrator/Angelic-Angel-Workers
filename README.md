# Angelic Angel Workers

[sh1ma/Angelic-Angel](https://github.com/sh1ma/Angelic-Angel) の TypeScript / Cloudflare Workers 移植版です。Mozilla AutoPush の WebSocket 経由で X の Web Push 通知を受信し、Web Crypto で復号して指定した Webhook へ POST します。

```text
X → Mozilla AutoPush ← WebSocket → Durable Object → HTTPS Webhook
                                      ↑
                            管理 API / Alarm / Cron
```

X でフォローし、ポスト通知を有効にしたユーザーの通知を受け取ります。すべてのポストを取得する API ではありません。X の API を呼ぶのは購読登録・再登録時です。

## 必要なもの

- Bun、Node.js 22 以上と Cloudflare Workers が利用できる Cloudflare アカウント
- X の `auth_token` と `ct0` Cookie
- 通知を受け取る HTTPS Webhook

Cookie は X にログインしたブラウザの開発者ツールから確認できます。Application / Storage → Cookies → `https://x.com` の `auth_token` と `ct0` を使用します。資格情報は `.dev.vars` または Workers secrets に設定します。

## ローカル開発

```sh
git submodule update --init --recursive
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
```

`.dev.vars` の値を設定してから起動します。

```sh
bun run dev
```

| 設定 | 用途 |
| --- | --- |
| `ADMIN_TOKEN` | 管理 API 用の長いランダムな Bearer token |
| `X_AUTH_TOKEN` | X の `auth_token` Cookie |
| `X_CT0` | 同じ X セッションの `ct0` Cookie |
| `WEBHOOK_ENDPOINT` | 復号済み通知を POST する HTTPS URL |
| `PROBE_TOKEN` | 任意。既存の push probe を有効にする別 token |

設定不足は管理 API から確認できます。管理 token、Cookie、復号用の秘密鍵は API の状態表示に含めません。

## Cloudflare への配置

```sh
bun run deploy
bunx wrangler secret put ADMIN_TOKEN
bunx wrangler secret put X_AUTH_TOKEN
bunx wrangler secret put X_CT0
bunx wrangler secret put WEBHOOK_ENDPOINT
```

本番は `wrangler.jsonc` のトップレベル設定です。既存 Inbox の namespace を維持するため Worker 名 `x-push-probe` と適用済み `v1` migration を保持し、listener を追加 migration で作成します。既存の Inbox のオブジェクト名は `inbox` のままです。

staging は別 Worker です。`bun run deploy:staging` で deploy し、secrets もそれぞれ `--env staging` で設定します。X の購読情報も分離されるため、検証用アカウントの資格情報を使用してください。GitHub Actions は default branch を本番、それ以外の対象 branch を staging に配置します。

## 登録と受信

Rust CLI の `init` は secrets 設定、`register` と `listen` はそれぞれ管理 API に対応します。以下はローカル開発時の例です。本番では URL を Worker の HTTPS URL に置き換えます。

```sh
ANGELIC_URL="http://localhost:8787"
ANGELIC_ADMIN_TOKEN="your-admin-token"

curl --fail-with-body -X POST "$ANGELIC_URL/api/register" \
  -H "Authorization: Bearer $ANGELIC_ADMIN_TOKEN"

curl --fail-with-body -X POST "$ANGELIC_URL/api/start" \
  -H "Authorization: Bearer $ANGELIC_ADMIN_TOKEN"

curl --fail-with-body "$ANGELIC_URL/api/status" \
  -H "Authorization: Bearer $ANGELIC_ADMIN_TOKEN"
```

| API | 操作 |
| --- | --- |
| `POST /api/register` | AutoPush 購読を作成し X に登録。途中で失敗しても候補を保存して再試行 |
| `POST /api/start` | 登録済み購読の受信を開始 |
| `POST /api/stop` | 受信と再接続を停止。受理済み通知の配送は継続 |
| `GET /api/status` | 登録、接続、待機期限、配送状況を確認 |
| `POST /api/unregister` | AutoPush 購読を解除し受信を停止 |
| `GET /api/deadletters` | 再試行上限に達した通知のメタデータを確認 |
| `POST /api/retry-deadletters` | 保存済みの失敗通知を再配送 |

全管理 API に `Authorization: Bearer <ADMIN_TOKEN>` が必要です。X の Cookie は HTTP body に渡しません。解除は AutoPush での購読解除を意味し、X からのログアウトは行いません。Cookie を変更した場合は必要に応じて再登録し、アカウントを切り替える際は以前の購読を解除してから新しい資格情報を設定してください。

状態表示の `registration` は `none` / `pending` / `registered` / `unregistering`、`running` は受信の実行希望状態、`connected` は現在の接続状態です。`outbox` は `pending` / `dead` / `done` の件数、`queueFull` は容量上限に達しているかを返します。解除の応答が確認できない場合は `202` を返し、停止状態のまま解除を再試行します。Mozilla が古い UAID を無効化したことを確認した場合は、購読を新規作成せず解除を完了します。

## 配送と復旧

- ECE の `aes128gcm` と旧形式 `aesgcm` に対応します。JSON 通知は元の JSON を転送して整数 ID の精度を保持します。JSON 以外の本文は `{ "raw": "..." }` として転送します。
- 通知を永続 outbox に保存してから AutoPush に ACK を返します。保存できない場合は ACK を返さず、通知の再配信を待ちます。
- Webhook が失敗した場合は再試行します。配送は **at-least-once** なので、受信側も通知 ID による重複排除を行ってください。Webhook が受理した直後の障害では同じ通知が再度届くことがあります。
- `X-Angelic-Notification-ID` は channel と version から決まる安定した ID です。最大 8 回の失敗後は dead letter として保持します。pending と dead の合計上限は 1000 件です。上限では新着通知を ACK せず、既存の通知を保持します。配送済みデータの本文は削除し、重複判定用の記録を最大 1000 件保持します。
- 再接続は指数 backoff を使います。AutoPush の close code `4774` は 30 分の待機を保持し、開始要求や Cron でも短縮しません。
- 実行希望状態と登録情報は再起動後も保持します。停止後に Cron が受信を勝手に再開することはありません。

outbound WebSocket は [Cloudflare の hibernation 対象外](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) なので、受信中は Durable Object の duration 課金が発生します。Alarm と Cron は切断・再起動からの復旧を担います。Cloudflare の更新やネットワーク障害時には再接続まで受信が中断することがあります。

## 既存 push probe

`PROBE_TOKEN` を設定すると `POST /push/<PROBE_TOKEN>` と `GET /inbox/<PROBE_TOKEN>?limit=50` を利用できます。`MODE=record` は受信を記録し `201`、`MODE=gone` は `410` を返します。この endpoint は受信記録用であり、X には Mozilla AutoPush が発行する購読 endpoint を登録します。管理 API の要求は probe に保存しません。

## 検証

```sh
bun run test
bun run typecheck
bun run lint
bunx wrangler deploy --env= --dry-run
bunx wrangler deploy --env staging --dry-run
```

`bun run test` は Bun の単体テストと Node/workerd の統合テストを実行します。`bun test` は単体テストのみです。暗号テストには RFC 8291 の既知ベクトルと、独立した Python `http_ece` 実装で生成・復号した旧形式の fixtures を使います。Workers runtime のテストは外部サービスを模擬し、実際の Durable Object storage と WebSocket Upgrade を使用します。

本番の X/Mozilla への実登録、Cloudflare 上での長時間接続はローカルテストの対象外です。配置後に登録・開始し、X の通知を有効にしたアカウントからの通知が Webhook に届くことを確認してください。X の非公開 API の変更、Cookie の失効、Cloudflare からのリクエスト拒否は実サービスでの確認が必要です。

## コード構成

`src/angelic.ts` が管理 API と Alarm / Cron の調整を担当し、以下のモジュールを組み合わせます。

| ファイル | 責務 |
| --- | --- |
| `autopush-link.ts` | WebSocket 接続、応答待ち、heartbeat、再接続 |
| `registration.ts` | AutoPush / X の登録・解除とキャンセル |
| `notifications.ts` | 通知の復号、永続キューへの受付、ACK |
| `delivery.ts` | Webhook 配送と再試行 |
| `state.ts` | 受信状態の永続化 |
| `outbox.ts` | 配送キューと dead letters の保存 |

単体テストは `ece.test.ts`、`autopush.test.ts`、`x.test.ts` に分かれています。

## 出典とライセンス

upstream revision: [`169a098e2025cc6e41a50fc8d521c483e21d9b6d`](https://github.com/sh1ma/Angelic-Angel/tree/169a098e2025cc6e41a50fc8d521c483e21d9b6d)。MIT License、Copyright (c) 2026 sh1ma。[LICENSE](LICENSE) を参照してください。
