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

## Автоматическая отправка выбранного мема в TikTok Inbox из ChatGPT Work

Worker предоставляет защищённый OAuth 2.1 MCP endpoint по `/mcp`. Он использует уже существующие `TOKENS` KV, Durable Object `AGENT_UPLOAD_GUARD` и TikTok OAuth-запись. Новый KV namespace, новый TikTok login и секрет `AGENT_UPLOAD_TOKEN` для ChatGPT Work не нужны. Для входа и согласия на MCP используется `APP_PASSWORD` от этой панели DraftBox; это не переподключает TikTok и не меняет выбранный аккаунт.

MCP публикует только две операции: `upload_finished_meme_to_inbox` и `check_finished_meme_inbox_status`. Первая принимает один сохранённый JPEG размером ровно 1080×1920 и инициирует `MEDIA_UPLOAD` с `video.upload`; в коде нет вызова `video.publish`. Worker сравнивает SHA-256, атомарно подавляет одинаковую повторную отправку на 24 часа и запрещает повтор после неоднозначного ответа TikTok. После состояния `accepted` надо проверять только статус; `inbox` означает, что TikTok подтвердил `SEND_TO_USER_INBOX`, `published` — что сам TikTok сообщил о публикации.

### Развертывание

1. Проверь локально: `npm test`, `npm run check`, `npx wrangler deploy --dry-run`.
2. В Cloudflare Workers Builds используй тот же репозиторий, ветку `main`, корень `draftbox-worker`, build `npm ci`, deploy `npx wrangler deploy`. При включённом build-on-push обновление `main` развернёт Worker автоматически.
3. Проверь, что Worker доступен по `https://<worker>.workers.dev/healthz`, а `/.well-known/oauth-protected-resource` возвращает JSON с `resource` и `authorization_servers`.
4. Не создавай `AGENT_UPLOAD_TOKEN` для Work OAuth. Он нужен только если отдельно используется `/agent/upload/` с HTTP Bearer или старый Codex MCP с Bearer.

### Одноразовое подключение ChatGPT Work

1. Открой ChatGPT **в браузере** и найди Plugins → `+` → `Add custom MCP server`.
2. URL: `https://<worker>.workers.dev/mcp`. Выбери OAuth, создай/подключи plugin и открой его в этой задаче.
3. При OAuth-переходе войди в DraftBox паролем `APP_PASSWORD`, который уже настроен в Worker. На странице согласия проверь, что запрашиваются только отправка в Inbox и проверка статуса, затем разреши.
4. При первом вызове выбери разрешение `Always allow` для отправки, если оно доступно в твоём аккаунте/пространстве. Если настройка оставлена как `Always ask`, каждое расписание может остановиться до подтверждения.
5. Включи MCP-плагин для текущего Work расписания и проверь его одним готовым мемом. Отправляй только финальный выбранный файл, не варианты и не превью.

ChatGPT может спрашивать подтверждение write-действий; настройки разрешений и доступность полного MCP зависят от плана и workspace. Если `Add custom MCP server` или write-доступ недоступен, Worker остаётся готовым, но облачный вызов из Work ещё не подключён. Нужен поддерживаемый workspace с write-доступом к Custom MCP либо отдельный частный облачный мост; локальный Bearer-коннектор не выполняет требование «без ПК».

### Защита и пределы повтора

- `POST /agent/upload/` — отдельный raw HTTP API с `Authorization: Bearer`, `Content-Type: image/jpeg` и JPEG 1080×1920 до 20 MiB. Для него секрет `AGENT_UPLOAD_TOKEN` нужно добавить именно как Production Secret в Cloudflare. Не помещай его в GitHub, обычные Variables, расписание, логи или чат.
- `GET /agent/status/<image_sha256>` только проверяет существующую операцию и не создаёт новую.
- Одинаковый JPEG не вызовет вторую загрузку в течение 24 часов. При неопределённом ответе операция блокирует повтор; сначала проверяй TikTok Inbox.
- Сервис использует уже привязанный TikTok аккаунт из `TOKENS`. В этом приложении нет прямой публикации в профиль.
