const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const PHOTO_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/content/init/";
const TOKEN_KEY = "tiktok_tokens";
const COOKIE_NAME = "draftbox_session";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const COOKIE_TTL_SECONDS = 12 * 60 * 60;
const MEDIA_TTL_MS = 2 * 60 * 60 * 1000;
const MEDIA_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const PUBLISH_ID_RE = /^[A-Za-z0-9._~-]{1,64}$/;
const encoder = new TextEncoder();

class DraftBoxError extends Error {}

function b64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function unb64url(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("bad encoding");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(byteLength = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function signingKey(secret) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new DraftBoxError("На Worker не настроен SESSION_SECRET длиной не менее 32 символов.");
  }
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function cookieValue(request) {
  const cookies = request.headers.get("Cookie") || "";
  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return "";
}

async function readSession(request, env) {
  const fresh = () => ({ csrf: randomToken(), exp: Math.floor(Date.now() / 1000) + COOKIE_TTL_SECONDS });
  const raw = cookieValue(request);
  if (!raw) return fresh();
  try {
    const [payload, signature, extra] = raw.split(".");
    if (!payload || !signature || extra) return fresh();
    const key = await signingKey(env.SESSION_SECRET);
    const valid = await crypto.subtle.verify("HMAC", key, unb64url(signature), encoder.encode(payload));
    if (!valid) return fresh();
    const value = JSON.parse(new TextDecoder().decode(unb64url(payload)));
    if (!value || typeof value !== "object" || typeof value.csrf !== "string" || value.exp <= Date.now() / 1000) return fresh();
    return value;
  } catch (error) {
    if (error instanceof DraftBoxError) throw error;
    return fresh();
  }
}

async function makeSessionCookie(session, env) {
  const payload = b64url(encoder.encode(JSON.stringify(session)));
  const key = await signingKey(env.SESSION_SECRET);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return `${COOKIE_NAME}=${payload}.${b64url(signature)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_TTL_SECONDS}`;
}

async function csrfValid(session, form) {
  const received = form.get("csrf_token");
  if (typeof received !== "string" || !received) return false;
  const [expectedHash, receivedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(session.csrf || "")),
    crypto.subtle.digest("SHA-256", encoder.encode(received)),
  ]);
  const a = new Uint8Array(expectedHash);
  const b = new Uint8Array(receivedHash);
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0 && session.csrf === received;
}

async function passwordMatches(received, expected) {
  if (typeof expected !== "string" || expected.length < 20 || typeof received !== "string") return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(received)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0 && received.length === expected.length;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function htmlResponse(body, status = 200, cookie = "") {
  const headers = new Headers({
    "Content-Type": "text/html; charset=UTF-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(body, { status, headers });
}

function redirectResponse(location, cookie = "") {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function loginPage(csrf, error = "") {
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DraftBox</title><body style="font:16px system-ui;max-width:34rem;margin:12vh auto;padding:0 1rem;background:#101114;color:#f4f4f5">
<h1>DraftBox</h1><p>Вход в загрузчик черновиков.</p>${error ? `<p role="alert" style="color:#ff8a8a">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/login/"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
<label>Пароль <input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Войти</button></form></body></html>`;
}

function homePage({ csrf, connected, result = null, error = "" }) {
  const message = result
    ? `<section role="status" style="margin-top:1.5rem;padding:1rem;border:1px solid #555;border-radius:.75rem"><strong>${escapeHtml(result.title)}</strong><p>${escapeHtml(result.message)}</p></section>`
    : "";
  const errorBlock = error ? `<p role="alert" style="color:#ff8a8a">${escapeHtml(error)}</p>` : "";
  const upload = connected
    ? `<form id="upload-form" method="post" action="/upload/" enctype="multipart/form-data">
<input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
<p><label>Готовый мем (JPEG, WebP или PNG, до 20 МБ)<br><input id="image" type="file" name="image" accept="image/jpeg,image/webp,image/png" required></label></p>
<button id="submit" type="submit">Отправить в черновики</button><p id="upload-status" aria-live="polite"></p></form>
<script>
const form=document.getElementById('upload-form');
form.addEventListener('submit',async(event)=>{
  event.preventDefault();
  const input=document.getElementById('image');
  const button=document.getElementById('submit');
  const status=document.getElementById('upload-status');
  const file=input.files&&input.files[0];
  if(!file)return;
  button.disabled=true;status.textContent='Подготавливаю JPEG…';
  try{
    const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
    const scale=Math.min(1,1080/bitmap.width,1920/bitmap.height);
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));
    canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const context=canvas.getContext('2d');
    context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);
    context.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
    const jpeg=await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Не удалось преобразовать картинку.')),'image/jpeg',0.92));
    if(jpeg.size>${MAX_IMAGE_BYTES})throw new Error('После преобразования картинка больше 20 МБ.');
    const data=new FormData(form);data.set('image',jpeg,'meme.jpg');
    status.textContent='Отправляю мем в TikTok…';
    const response=await fetch(form.action,{method:'POST',body:data,credentials:'same-origin'});
    const html=await response.text();document.open();document.write(html);document.close();
  }catch(error){status.textContent=error&&error.message?error.message:'Не удалось подготовить картинку.';button.disabled=false;}
});
</script>`
    : `<p>Сначала подключи TikTok.</p><p><a style="color:#9ee7c1" href="/connect/">Подключить TikTok</a></p>`;
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DraftBox — черновики TikTok</title><body style="font:16px system-ui;max-width:40rem;margin:8vh auto;padding:0 1rem;background:#101114;color:#f4f4f5">
<h1>DraftBox</h1><p>Готовый мем → черновики TikTok.</p>${upload}${message}${errorBlock}
<form method="post" action="/logout/" style="margin-top:2rem"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button type="submit">Выйти</button></form>
</body></html>`;
}

function originAndCallback(env, requestUrl) {
  const configuredOrigin = String(env.PUBLIC_ORIGIN || "").trim().replace(/\/+$/u, "");
  let origin = configuredOrigin;
  if (!origin && requestUrl) {
    try { origin = new URL(requestUrl).origin; } catch { /* Report the same setup error below. */ }
  }
  let parsed;
  try { parsed = new URL(origin); } catch { throw new DraftBoxError("Открой Worker по публичному HTTPS-адресу Cloudflare."); }
  if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash || !parsed.host) {
    throw new DraftBoxError("Открой Worker по публичному HTTPS-адресу Cloudflare.");
  }
  return { origin, callback: `${origin}/oauth/callback/` };
}

function configuredTikTok(env, requestUrl) {
  const clientKey = String(env.TIKTOK_CLIENT_KEY || "").trim();
  const clientSecret = String(env.TIKTOK_CLIENT_SECRET || "").trim();
  if (!clientKey || !clientSecret) throw new DraftBoxError("На Worker не настроены TikTok client key и client secret.");
  return { clientKey, clientSecret, ...originAndCallback(env, requestUrl) };
}

async function readTokens(env) {
  if (!env.TOKENS) throw new DraftBoxError("Не настроено KV-хранилище TOKENS.");
  try {
    const value = await env.TOKENS.get(TOKEN_KEY, "json");
    if (value == null) return null;
    if (!value || typeof value !== "object" || !value.refresh_token) {
      throw new DraftBoxError("Авторизация TikTok повреждена. Подключи аккаунт заново.");
    }
    return value;
  } catch (error) {
    if (error instanceof DraftBoxError) throw error;
    throw new DraftBoxError("Не удалось прочитать авторизацию TikTok. Попробуй подключить аккаунт заново.");
  }
}

async function saveTokens(env, payload, previous = null, fallbackScope = "") {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = Number(payload.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new DraftBoxError("TikTok вернул некорректный срок действия токена.");
  const refreshExpiresIn = Number(payload.refresh_expires_in);
  const record = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || previous?.refresh_token,
    open_id: payload.open_id || previous?.open_id,
    scope: payload.scope || fallbackScope || previous?.scope || "",
    access_expires_at: now + expiresIn,
    refresh_expires_at: Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0
      ? now + refreshExpiresIn
      : Number(previous?.refresh_expires_at || 0),
  };
  if (!record.access_token || !record.refresh_token || !record.open_id || !record.refresh_expires_at) {
    throw new DraftBoxError("TikTok не вернул все данные авторизации. Подключи аккаунт заново.");
  }
  try {
    await env.TOKENS.put(TOKEN_KEY, JSON.stringify(record));
  } catch {
    throw new DraftBoxError("Не удалось сохранить авторизацию TikTok в KV.");
  }
  return record;
}

async function parseTikTokResponse(response, action) {
  let payload;
  try { payload = await response.json(); } catch { throw new DraftBoxError(`TikTok вернул непонятный ответ при ${action}.`); }
  if (!payload || typeof payload !== "object") throw new DraftBoxError(`TikTok вернул непонятный ответ при ${action}.`);
  const error = payload.error;
  const code = typeof error === "object" && error !== null ? error.code : error;
  if (!response.ok || (code != null && code !== "" && code !== "ok")) {
    const safeCode = String(code || "ошибка").slice(0, 80);
    throw new DraftBoxError(`TikTok не принял запрос (${safeCode}).`);
  }
  return payload;
}

async function tokenRequest(env, parameters, action) {
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters),
    });
  } catch {
    throw new DraftBoxError(`Не удалось связаться с TikTok при ${action}.`);
  }
  return parseTikTokResponse(response, action);
}

async function refreshTokens(env, tokens, requestUrl) {
  if (Number(tokens.refresh_expires_at || 0) <= Date.now() / 1000) {
    throw new DraftBoxError("Авторизация TikTok истекла. Нажми «Подключить TikTok».");
  }
  const { clientKey, clientSecret } = configuredTikTok(env, requestUrl);
  const payload = await tokenRequest(env, {
    client_key: clientKey,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  }, "обновлении авторизации");
  return saveTokens(env, payload, tokens);
}

async function accessToken(env, requestUrl) {
  let tokens = await readTokens(env);
  if (!tokens) throw new DraftBoxError("Сначала подключи аккаунт TikTok.");
  const scopes = new Set(String(tokens.scope || "").split(/[\s,]+/u).filter(Boolean));
  if (!scopes.has("video.upload")) throw new DraftBoxError("TikTok не выдал разрешение video.upload. Переподключи аккаунт.");
  if (Number(tokens.access_expires_at || 0) <= Date.now() / 1000 + 600) tokens = await refreshTokens(env, tokens, requestUrl);
  return tokens.access_token;
}

async function sendPhoto(env, jpeg, requestUrl) {
  if (!env.MEDIA) throw new DraftBoxError("Не настроено R2-хранилище MEDIA.");
  const { origin } = originAndCallback(env, requestUrl);
  const token = await accessToken(env, requestUrl);
  const mediaId = randomToken();
  const key = `media/${mediaId}.jpg`;
  try {
    await env.MEDIA.put(key, jpeg, {
      httpMetadata: { contentType: "image/jpeg", cacheControl: "no-store" },
      customMetadata: { createdAt: String(Date.now()) },
    });
  } catch {
    throw new DraftBoxError("Не удалось сохранить временный JPEG в R2.");
  }
  const body = {
    post_info: {},
    source_info: {
      source: "PULL_FROM_URL",
      photo_cover_index: 0,
      photo_images: [`${origin}/tiktok/${key}`],
    },
    post_mode: "MEDIA_UPLOAD",
    media_type: "PHOTO",
  };
  let response;
  try {
    response = await fetch(PHOTO_INIT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new DraftBoxError("Не удалось подтвердить ответ TikTok. Проверь Inbox перед повторной отправкой.");
  }
  const payload = await parseTikTokResponse(response, "отправке черновика");
  const publishId = payload.data?.publish_id;
  if (typeof publishId !== "string" || !PUBLISH_ID_RE.test(publishId)) {
    throw new DraftBoxError("TikTok не вернул корректный ID черновика.");
  }
  return publishId;
}

async function mediaResponse(env, pathname) {
  const match = pathname.match(/^\/tiktok\/media\/([A-Za-z0-9_-]{43})\.jpg$/u);
  if (!match || !MEDIA_ID_RE.test(match[1])) return new Response("Not found", { status: 404 });
  if (!env.MEDIA) return new Response("Not found", { status: 404 });
  const object = await env.MEDIA.get(`media/${match[1]}.jpg`);
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(object.size),
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function verificationFileResponse(env, pathname) {
  const match = pathname.match(/^\/tiktok\/([A-Za-z0-9._-]{1,200})$/u);
  if (!match || !env.MEDIA) return null;
  const object = await env.MEDIA.get(`verification/${match[1]}`);
  if (!object) return null;
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function isJpeg(bytes) {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8
    && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

async function requireCsrf(session, form) {
  if (!await csrfValid(session, form)) throw new DraftBoxError("Форма устарела. Обнови страницу и попробуй ещё раз.");
}

async function requireLogin(session, env) {
  if (!session.loggedIn) return redirectResponse("/login/", await makeSessionCookie(session, env));
  return null;
}

async function renderHome(env, session, options = {}, status = 200) {
  let connected = options.connected;
  if (connected === undefined) connected = Boolean(await readTokens(env));
  return htmlResponse(homePage({ csrf: session.csrf, connected, ...options }), status);
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/healthz" && request.method === "GET") return new Response("ok", { headers: { "Cache-Control": "no-store" } });
  if (url.pathname.startsWith("/tiktok/media/")) return request.method === "GET" ? mediaResponse(env, url.pathname) : new Response("Method not allowed", { status: 405 });
  const verificationFile = request.method === "GET" ? await verificationFileResponse(env, url.pathname) : null;
  if (verificationFile) return verificationFile;

  const session = await readSession(request, env);
  if (url.pathname === "/login/" && (request.method === "GET" || request.method === "POST")) {
    if (request.method === "GET") return htmlResponse(loginPage(session.csrf), 200, await makeSessionCookie(session, env));
    const form = await request.formData();
    await requireCsrf(session, form);
    const password = form.get("password");
    if (!await passwordMatches(password, env.APP_PASSWORD)) {
      return htmlResponse(loginPage(session.csrf, "Пароль не подошёл."), 401, await makeSessionCookie(session, env));
    }
    const loggedIn = { loggedIn: true, csrf: randomToken(), exp: Math.floor(Date.now() / 1000) + COOKIE_TTL_SECONDS };
    return redirectResponse("/", await makeSessionCookie(loggedIn, env));
  }

  if (url.pathname === "/logout/" && request.method === "POST") {
    const denied = await requireLogin(session, env);
    if (denied) return denied;
    const form = await request.formData();
    await requireCsrf(session, form);
    const cleared = `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
    return redirectResponse("/login/", cleared);
  }

  if (url.pathname === "/" && request.method === "GET") {
    const denied = await requireLogin(session, env);
    if (denied) return denied;
    return renderHome(env, session);
  }

  if (url.pathname === "/connect/" && request.method === "GET") {
    const denied = await requireLogin(session, env);
    if (denied) return denied;
    const { clientKey, callback } = configuredTikTok(env, request.url);
    session.oauthState = randomToken();
    const query = new URLSearchParams({
      client_key: clientKey,
      scope: "video.upload",
      response_type: "code",
      redirect_uri: callback,
      state: session.oauthState,
    });
    return redirectResponse(`${AUTHORIZE_URL}?${query}`, await makeSessionCookie(session, env));
  }

  if (url.pathname === "/oauth/callback/" && request.method === "GET") {
    const denied = await requireLogin(session, env);
    if (denied) return denied;
    const receivedState = url.searchParams.get("state") || "";
    if (!session.oauthState || !(await constantTimeTextEqual(receivedState, session.oauthState))) {
      throw new DraftBoxError("Проверка OAuth state не пройдена. Нажми «Подключить TikTok» ещё раз.");
    }
    delete session.oauthState;
    if (url.searchParams.has("error")) throw new DraftBoxError("TikTok не завершил авторизацию.");
    const code = url.searchParams.get("code") || "";
    if (!code) throw new DraftBoxError("TikTok не вернул код авторизации.");
    const { clientKey, clientSecret, callback } = configuredTikTok(env, request.url);
    const payload = await tokenRequest(env, {
      client_key: clientKey,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: callback,
    }, "авторизации");
    const grantedScope = payload.scope || url.searchParams.get("scopes") || "";
    if (!String(grantedScope).split(/[\s,]+/u).includes("video.upload")) {
      throw new DraftBoxError("TikTok не выдал video.upload. Проверь разрешение приложения и повтори подключение.");
    }
    await saveTokens(env, payload, null, grantedScope);
    return htmlResponse(homePage({
      csrf: session.csrf,
      connected: true,
      result: { title: "TikTok подключён", message: "Теперь выбери готовый мем и отправь его в Inbox." },
    }), 200, await makeSessionCookie(session, env));
  }

  if (url.pathname === "/upload/" && request.method === "POST") {
    const denied = await requireLogin(session, env);
    if (denied) return denied;
    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > MAX_IMAGE_BYTES + 512 * 1024) {
      return renderHome(env, session, { error: "Файл больше допустимых 20 МБ." }, 413);
    }
    const form = await request.formData();
    await requireCsrf(session, form);
    const file = form.get("image");
    if (!file || typeof file.arrayBuffer !== "function") {
      return renderHome(env, session, { error: "Выбери готовое изображение." }, 400);
    }
    if (file.size > MAX_IMAGE_BYTES || file.size <= 0) {
      return renderHome(env, session, { error: "Изображение пустое или превышает 20 МБ." }, 413);
    }
    const jpeg = new Uint8Array(await file.arrayBuffer());
    if (!isJpeg(jpeg)) return renderHome(env, session, { error: "Не удалось подготовить JPEG. Выбери JPEG, WebP или PNG." }, 400);
    await sendPhoto(env, jpeg, request.url);
    return renderHome(env, session, {
      connected: true,
      result: {
        title: "TikTok принял мем для черновика",
        message: "Когда появится уведомление в Inbox TikTok, открой его и заверши публикацию.",
      },
    });
  }

  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
}

async function constantTimeTextEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftHash = new Uint8Array(a);
  const rightHash = new Uint8Array(b);
  let mismatch = 0;
  for (let index = 0; index < leftHash.length; index += 1) mismatch |= leftHash[index] ^ rightHash[index];
  return mismatch === 0 && left.length === right.length;
}

export async function cleanupExpiredMedia(env, now = Date.now()) {
  if (!env.MEDIA) return 0;
  let cursor;
  let removed = 0;
  do {
    const page = await env.MEDIA.list({ prefix: "media/", limit: 1000, ...(cursor ? { cursor } : {}) });
    const stale = page.objects
      .filter((object) => now - new Date(object.uploaded).getTime() > MEDIA_TTL_MS)
      .map((object) => object.key);
    for (let offset = 0; offset < stale.length; offset += 1000) {
      const batch = stale.slice(offset, offset + 1000);
      if (batch.length) await env.MEDIA.delete(batch);
      removed += batch.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return removed;
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      if (error instanceof DraftBoxError) {
        const session = await readSession(request, env);
        if (session.loggedIn) return renderHome(env, session, { error: error.message }, 400);
        return htmlResponse(loginPage(session.csrf, error.message), 400, await makeSessionCookie(session, env));
      }
      return new Response("Внутренняя ошибка Worker. Проверь Cloudflare Logs.", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store" },
      });
    }
  },
  async scheduled(_controller, env) {
    await cleanupExpiredMedia(env);
  },
};
