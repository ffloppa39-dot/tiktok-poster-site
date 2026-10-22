# DraftBox

Минимальный путь: **готовый мем → черновики TikTok**. Это Cloudflare Worker: отдельный VPS, Docker, программа на ПК, создание видео и чаты не нужны.

В браузере картинка приводится к JPEG до 1080×1920. Worker загружает фото через TikTok Content Posting API в `MEDIA_UPLOAD`; публикации в профиль автоматически нет. Временные JPEG хранятся в приватном R2 и удаляются почасовой задачей, когда им больше двух часов. Токены TikTok хранятся в Cloudflare KV.

## Что нужно

- Аккаунт Cloudflare.
- Cloudflare Worker получает бесплатный адрес `workers.dev`; собственный домен для размещения не нужен.
- Текущий TikTok Developer App с уже одобренным `video.upload` и Content Posting API. Новое приложение и новое разрешение создавать не требуется. После смены адреса добавь новый OAuth redirect URI в настройках приложения.
- TikTok требует подтвердить адрес, с которого скачивает фото. В проект добавлена выдача проверочного файла для проверки URL-prefix. TikTok официально поддерживает проверку URL-prefix файлом, но отдельно не подтверждает поддержку `workers.dev`; если Developer Portal отклонит этот адрес, понадобится собственный домен.
- Node.js и npm для первоначальной настройки и публикации Worker.

## Настройка и публикация

1. Установи зависимости и войди в Cloudflare:

   ```bash
   npm install
   npx wrangler login
   ```

2. Создай два хранилища:

   ```bash
   npx wrangler kv namespace create TOKENS
   npx wrangler r2 bucket create draftbox-meme-media
   ```

   Вставь ID созданного KV namespace в `wrangler.jsonc` вместо `REPLACE_WITH_KV_NAMESPACE_ID`.

3. Опубликуй Worker. Cloudflare выдаст ему адрес вида `https://draftbox-meme-drafts.<твой-аккаунт>.workers.dev`:

   ```bash
   npx wrangler deploy
   ```

4. Задай секреты через команды. Wrangler предложит безопасно ввести значение:

   ```bash
   npx wrangler secret put APP_PASSWORD
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put TIKTOK_CLIENT_KEY
   npx wrangler secret put TIKTOK_CLIENT_SECRET
   ```

   Для `APP_PASSWORD` используй длинный пароль. Для `SESSION_SECRET` — случайную строку не короче 32 символов. Не клади TikTok secret и пароль в GitHub или в исходный код. После добавления секретов снова запусти `npx wrangler deploy`.

5. В TikTok Developer Portal добавь OAuth redirect URI, подставив фактический `workers.dev` адрес:

   ```text
   https://draftbox-meme-drafts.<твой-аккаунт>.workers.dev/oauth/callback/
   ```

6. В TikTok Developer Portal открой проверку URL properties и добавь URL-prefix `https://draftbox-meme-drafts.<твой-аккаунт>.workers.dev/tiktok/`. TikTok выдаст проверочный файл. В Cloudflare Dashboard открой R2 bucket `draftbox-meme-media` и загрузи туда этот файл в папку `verification/`, сохранив исходное имя файла. Worker отдаст его по адресу `/tiktok/<имя-файла>`.

   После загрузки файла заверши проверку в TikTok Developer Portal. Затем открой адрес Worker, войди, нажми **Подключить TikTok** и разреши доступ существующему приложению.

   Если TikTok Developer Portal не принимает адрес `workers.dev`, остановись и подключи собственный домен к Cloudflare; код менять не нужно.

## Локальная проверка

Тесты используют только встроенный test runner Node.js и не обращаются к TikTok:

```bash
npm test
npm run check
```

Wrangler запускает локальную копию с эмуляцией KV и R2:

```bash
npx wrangler dev
```

Для локального входа создай `.dev.vars` со значениями `APP_PASSWORD`, `SESSION_SECRET`, `TIKTOK_CLIENT_KEY` и `TIKTOK_CLIENT_SECRET`; файл уже исключён из Git. Для OAuth и отправки TikTok всё равно потребуется публичный HTTPS-адрес.

## Ссылки на документацию

- [TikTok Photo Posting API](https://developers.tiktok.com/doc/content-posting-api-reference-photo-post/)
- [TikTok Content Posting API](https://developers.tiktok.com/products/content-posting-api/)
- [Cloudflare Workers: custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
