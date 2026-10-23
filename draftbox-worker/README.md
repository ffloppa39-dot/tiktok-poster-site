# DraftBox

Минимальный путь: **готовый мем → черновики TikTok**. Это Cloudflare Worker: отдельный VPS, Docker, программа на ПК, чаты и генерация видео не нужны.

Браузер преобразует изображение в JPEG до 1080×1920. Worker сохраняет JPEG в KV namespace на два часа и передаёт TikTok публичную ссылку на `workers.dev`. При успешном скачивании фото TikTok отправляется в Inbox для завершения публикации. OAuth-токены TikTok тоже хранятся в KV.

Workers KV включён в бесплатный план: лимит значения — 25 MiB, поэтому JPEG размером до 20 MB помещается в один ключ; также действуют суточные лимиты операций и лимит 1 GB хранения. KV не мгновенно распространяет новые записи по всем локациям: видимость может задержаться до 60 секунд или дольше. У медиа уникальный случайный URL, но успешный `dry-run` и локальные тесты не подтверждают, что TikTok реально скачал файл и создал запись в Inbox.

Для фотографий TikTok Content Posting API использует `PULL_FROM_URL`, поэтому URL-prefix Worker должен быть подтверждён в TikTok Developer Portal. Документация описывает проверку полного URL-prefix через файл подписи, но не обещает, что портал принимает `workers.dev`. Не считай адрес подтверждённым, пока портал явно не покажет успешную проверку.

## Настройка

1. В Cloudflare Workers Builds подключи репозиторий, ветку `main` и выставь:
   - Root directory: `draftbox-worker`
   - Build command: `npm ci`
   - Deploy command: `npx wrangler deploy`

   `package-lock.json` лежит в `draftbox-worker`, поэтому команды должны запускаться из этой папки.
2. В `wrangler.jsonc` указано production KV binding `TOKENS` и ID namespace. Проверь в Cloudflare, что binding называется `TOKENS` и выбран именно этот namespace ID.
3. В настройках Worker добавь в Production только как Secrets: `APP_PASSWORD`, `SESSION_SECRET`, `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`. `APP_PASSWORD` должен быть длиной не менее 20 символов, `SESSION_SECRET` — не менее 32. Не добавляй эти значения в GitHub, обычные Variables или чат. `PUBLIC_ORIGIN` необязателен: без него Worker берёт origin из своего HTTPS-адреса.
4. Разверни Worker на бесплатном `workers.dev` адресе.
5. В TikTok Developer Portal включи Login Kit для Web и Content Posting API, добавь scope `video.upload`, затем укажи redirect URI `https://<worker>.workers.dev/oauth/callback/`.
6. В TikTok Developer Portal добавь URL-prefix `https://<worker>.workers.dev/tiktok/` на проверку. Скачанный файл подписи сохрани в KV namespace `TOKENS` как запись:
   - Key: `verification/<точное-имя-файла>`
   - Value: точное содержимое файла

   После этого открой `https://<worker>.workers.dev/tiktok/<точное-имя-файла>` и заверши проверку в портале.
7. Если портал отвергнет `workers.dev`, используй домен или поддомен, которым уже владеешь, привяжи его к Worker и подтверди URL-prefix файлом подписи. Worker и KV можно оставить на бесплатном плане; домен должен быть доступен для настройки DNS. Если своего домена нет, гарантированного бесплатного обходного варианта нет.
8. Убедись, что нужный TikTok аккаунт добавлен как Target user в используемом Sandbox. Ранее выданное разрешение `video.upload` относится только к приложению, через которое TikTok авторизовал аккаунт; для этого Worker аккаунт нужно подключить через этот же Developer app и этот callback.
9. Открой адрес Worker, войди, подключи TikTok и выбери готовый мем. Когда TikTok покажет уведомление в Inbox, открой его и заверши публикацию вручную.

## Локальная проверка

```bash
npm test
npm run check
npx wrangler deploy --dry-run
```

## Secure final-meme upload from Codex / ChatGPT

This adds a remote MCP endpoint and a separate raw HTTP endpoint. It reuses the existing TOKENS KV for the existing TikTok OAuth token and temporary JPEG. A Durable Object binding named AGENT_UPLOAD_GUARD atomically reserves an image fingerprint to stop concurrent retries. No second KV namespace is created. The workflow remains MEDIA_UPLOAD plus video.upload; there is no video.publish call or direct publish action.

### One-time secret and deployment

1. Generate a random value at least 43 characters long using only A-Z, a-z, 0-9, underscore, and hyphen in a password manager. Do not send it in chat, put it in GitHub or project files, or type it into a terminal command.
2. Merge the feature branch into main (or select it in Workers Builds after review). The connected build uses draftbox-worker, npm ci, and npx wrangler deploy. The Durable Object is created by the wrangler.jsonc migration; the existing TOKENS namespace and OAuth record are unchanged.
3. In Cloudflare Dashboard open Workers & Pages → tiktok-poster-site → Settings → Variables and Secrets → Add → Secret. Name: AGENT_UPLOAD_TOKEN. Paste the random string from step 1. Save as a Production Secret, not a plain Variable.
4. Wait for a successful production deploy. Do not trigger TikTok OAuth or change the connected account.

### Connect MCP in Codex desktop, CLI, or IDE

1. Open Settings → MCP servers → Add server. Choose Streamable HTTP.
2. URL: https://tiktok-poster-site.vovahacker777bot.workers.dev/mcp
3. Choose Bearer token authentication and enter the same secret as Cloudflare directly in the Codex MCP settings. Do not send it in chat. If configuring config.toml instead, use the bearer_token_env_var setting and keep the environment variable in a local secret manager.
4. Save the connection and restart Codex. Verify that upload_finished_meme_to_inbox and check_finished_meme_inbox_status appear.
5. The upload tool accepts the saved final JPEG bytes as standard Base64. Call it only after saving and selecting the one final 1080×1920 JPEG; never send options or previews. After state accepted, call only the status tool until inbox, published, or timeout. inbox means TikTok reported SEND_TO_USER_INBOX; accepted only means TikTok accepted the request, not that a notification has appeared yet.

This endpoint uses static Bearer authentication, supported by Codex MCP clients. It is not yet an authenticated ChatGPT Web/Work plugin: OpenAI's current custom MCP plugin guidance expects OAuth 2.1 for authenticated servers, and ChatGPT Web/Work also requires confirmation before write actions. The current Work session cannot be connected to this endpoint from here. Use Codex desktop/CLI/IDE for this bearer-token setup; enabling direct Work support would require a separate OAuth provider and would still be subject to Work's write-confirmation behavior.

### HTTP API for another trusted client

- POST /agent/upload/ requires Authorization: Bearer, Content-Type: image/jpeg, and a raw JPEG body. It accepts structurally valid JPEG images exactly 1080×1920 and no larger than 20 MiB.
- GET /agent/status/<image_sha256> checks an existing operation and never creates a new upload.
- Re-uploading the exact same image within 24 hours does not trigger another TikTok upload. If the network response is ambiguous, the operation is marked unknown and retries are blocked; check Inbox before doing anything else.
- accepted means TikTok accepted the init request; inbox means TikTok reported SEND_TO_USER_INBOX; published means TikTok reported PUBLISH_COMPLETE. This app does not publish directly.
- Limit: no more than 10 new image uploads per hour. The limit and atomic idempotency record live in one Durable Object.
