# DraftBox

Минимальный путь: **готовый мем → черновики TikTok**. Это Cloudflare Worker: отдельный VPS, Docker, программа на ПК, чаты и генерация видео не нужны.

Браузер преобразует изображение в JPEG до 1080×1920. Worker сохраняет JPEG в уже созданном KV namespace на два часа и передаёт TikTok публичную ссылку на `workers.dev`. TikTok забирает изображение и помещает его в Inbox для завершения публикации. OAuth-токены TikTok тоже хранятся в KV.

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
9. Открой адрес Worker, войди, подключи TikTok и выбери готовый мем. После ответа API открой Inbox TikTok и заверши публикацию вручную.

## Локальная проверка

```bash
npm test
npm run check
npx wrangler deploy --dry-run
```
