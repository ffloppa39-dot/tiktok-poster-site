# DraftBox

Минимальный путь: **готовый мем → черновики TikTok**. Это Cloudflare Worker: отдельный VPS, Docker, программа на ПК, чаты и генерация видео не нужны.

Браузер преобразует изображение в JPEG до 1080×1920. Worker сохраняет JPEG в уже созданном KV namespace на два часа и передаёт TikTok публичную ссылку на `workers.dev`. TikTok забирает изображение и помещает его в Inbox для завершения публикации. OAuth-токены TikTok тоже хранятся в KV.

Для фотографий TikTok Content Posting API использует `PULL_FROM_URL`, поэтому адрес Worker должен быть подтверждён в TikTok Developer Portal. В документации TikTok не указана отдельная гарантия для доменов `workers.dev`; если портал не примет такой URL-prefix, понадобится другой подтверждаемый домен.

## Настройка

1. В `wrangler.jsonc` уже указан ID KV namespace `TOKENS`.
2. В Cloudflare Workers Builds подключи репозиторий и укажи путь проекта `draftbox-worker` (либо запускай `npx wrangler deploy --config draftbox-worker/wrangler.jsonc` из корня репозитория).
3. В Cloudflare добавь секреты Worker: `APP_PASSWORD`, `SESSION_SECRET`, `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`. Не добавляй их в GitHub и не отправляй в чат.
4. Разверни Worker на бесплатном `workers.dev` адресе.
5. В TikTok Developer Portal добавь OAuth redirect URI `https://<worker>.workers.dev/oauth/callback/`.
6. В TikTok Developer Portal подтверди URL-prefix `https://<worker>.workers.dev/tiktok/`. Скачанный файл проверки сохрани в KV namespace `TOKENS` как запись:
   - Key: `verification/<точное-имя-файла>`
   - Value: точное содержимое файла

   После этого открой `https://<worker>.workers.dev/tiktok/<точное-имя-файла>` и заверши проверку в портале.
7. Открой адрес Worker, войди, подключи TikTok и выбери готовый мем.

## Локальная проверка

```bash
npm test
npm run check
npx wrangler deploy --dry-run
```
