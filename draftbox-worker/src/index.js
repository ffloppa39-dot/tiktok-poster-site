const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const PHOTO_INIT_URL = "https://open.tiktokapis.com/v2/post/publish/content/init/";
const PHOTO_STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";
const TOKEN_KEY = "tiktok_tokens";
const COOKIE_NAME = "draftbox_session";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_AGENT_UPLOADS_PER_HOUR = 10;
const AGENT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MCP_MAX_BODY_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64 * 1024;
const COOKIE_TTL_SECONDS = 12 * 60 * 60;
const MEDIA_TTL_SECONDS = 2 * 60 * 60;
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

async function sendPhoto(env, jpeg, requestUrl, beforeTikTokRequest = null) {
  if (!env.TOKENS) throw new DraftBoxError("Не настроено KV-хранилище TOKENS.");
  const { origin } = originAndCallback(env, requestUrl);
  const token = await accessToken(env, requestUrl);
  const mediaId = randomToken();
  const key = `media/${mediaId}.jpg`;
  try {
    await env.TOKENS.put(key, jpeg.buffer, { expirationTtl: MEDIA_TTL_SECONDS });
  } catch {
    throw new DraftBoxError("Не удалось сохранить временный JPEG в KV.");
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
  if (beforeTikTokRequest) await beforeTikTokRequest();
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
  if (!env.TOKENS) return new Response("Not found", { status: 404 });
  const bytes = await env.TOKENS.get(`media/${match[1]}.jpg`, "arrayBuffer");
  if (!bytes) return new Response("Not found", { status: 404 });
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function verificationFileResponse(env, pathname) {
  const match = pathname.match(/^\/tiktok\/([A-Za-z0-9._-]{1,200})$/u);
  if (!match || !env.TOKENS) return null;
  const bytes = await env.TOKENS.get(`verification/${match[1]}`, "arrayBuffer");
  if (!bytes) return null;
  return new Response(bytes, {
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


function jsonResponse(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

async function isAgentAuthorized(request, env) {
  const expected = env.AGENT_UPLOAD_TOKEN;
  if (typeof expected !== "string" || !/^[A-Za-z0-9_-]{43,}$/u.test(expected)) return false;
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer ([A-Za-z0-9._~-]+)$/u);
  return Boolean(match && await constantTimeTextEqual(match[1], expected));
}

async function readLimitedBody(request, maxBytes) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new DraftBoxError("Тело запроса превышает допустимый размер.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function jpegDimensions(bytes) {
  if (!isJpeg(bytes)) return null;
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawStartOfScan = false;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd9) break;
    if (marker === 0xda) {
      sawStartOfScan = true;
      break;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    const isSof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      if (segmentLength < 8) return null;
      height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      width = (bytes[offset + 5] << 8) | bytes[offset + 6];
    }
    offset += segmentLength;
  }
  return sawStartOfScan && width > 0 && height > 0 ? { width, height } : null;
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function guardRequest(env, operation, key, record = null) {
  if (!env.AGENT_UPLOAD_GUARD) throw new DraftBoxError("Не настроен атомарный шлюз защиты от повторной отправки.");
  const id = env.AGENT_UPLOAD_GUARD.idFromName("draftbox-agent-upload-v1");
  const stub = env.AGENT_UPLOAD_GUARD.get(id);
  const response = await stub.fetch("https://agent-upload-guard.internal/" + operation, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, key, record }),
  });
  if (!response.ok) throw new DraftBoxError("Не удалось проверить состояние безопасной загрузки.");
  return response.json();
}

function publicAgentResult(record) {
  const state = String(record?.state || "unknown");
  const messages = {
    accepted: "TikTok принял запрос; подтверждение доставки в Inbox ещё ожидается.",
    inbox: "TikTok подтвердил отправку уведомления в Inbox для завершения черновика.",
    published: "TikTok подтвердил публикацию.",
    sending: "Запрос отправляется в TikTok; не запускай повторную отправку.",
    reserved: "Операция зарезервирована; проверь статус перед любым повтором.",
    unknown: "Ответ TikTok не удалось подтвердить. Проверь Inbox; повторная отправка заблокирована.",
    preflight_failed: "Мем не был отправлен в TikTok; исправь указанную проблему и повтори запрос.",
    failed: "TikTok сообщил об ошибке обработки.",
  };
  return {
    state,
    message: messages[state] || "Статус операции проверяется.",
    ...(record?.sha256 ? { image_sha256: record.sha256 } : {}),
    ...(record?.publish_id ? { publish_id: record.publish_id } : {}),
    ...(record?.tiktok_status ? { tiktok_status: record.tiktok_status } : {}),
    ...(record?.created_at ? { created_at: record.created_at } : {}),
  };
}

async function submitAgentMeme(env, jpeg, requestUrl) {
  if (!(jpeg instanceof Uint8Array) || jpeg.byteLength <= 0) {
    return { status: 400, body: { ok: false, error: "Передан пустой JPEG." } };
  }
  if (jpeg.byteLength > MAX_IMAGE_BYTES) {
    return { status: 413, body: { ok: false, error: "JPEG превышает лимит 20 МБ." } };
  }
  const dimensions = jpegDimensions(jpeg);
  if (!dimensions) {
    return { status: 400, body: { ok: false, error: "Файл не является корректно структурированным JPEG." } };
  }
  if (dimensions.width !== 1080 || dimensions.height !== 1920) {
    return { status: 400, body: { ok: false, error: "Для отправки нужен финальный мем размером ровно 1080×1920 px." } };
  }
  let imageHash;
  try {
    imageHash = await sha256Hex(jpeg);
  } catch {
    return { status: 500, body: { ok: false, error: "Не удалось проверить идентификатор изображения." } };
  }
  const now = Date.now();
  const initialRecord = {
    sha256: imageHash,
    state: "reserved",
    created_at: new Date(now).toISOString(),
    expires_at: now + AGENT_IDEMPOTENCY_TTL_MS,
  };
  let claim;
  try {
    claim = await guardRequest(env, "claim", imageHash, initialRecord);
  } catch (error) {
    return { status: 503, body: { ok: false, error: error.message } };
  }
  if (claim.status === "rate_limited") {
    return { status: 429, body: { ok: false, error: "Достигнут лимит: не более 10 новых отправок в час." } };
  }
  if (!claim.claimed) {
    const current = claim.record || { sha256: imageHash, state: "unknown" };
    return { status: 202, body: { ok: true, duplicate_suppressed: true, ...publicAgentResult(current) } };
  }

  let tiktokRequestStarted = false;
  try {
    const publishId = await sendPhoto(env, jpeg, requestUrl, async () => {
      await guardRequest(env, "update", imageHash, {
        ...initialRecord,
        state: "sending",
        created_at: new Date(now).toISOString(),
      });
      tiktokRequestStarted = true;
    });
    const acceptedRecord = {
      ...initialRecord,
      state: "accepted",
      publish_id: publishId,
    };
    await guardRequest(env, "update", imageHash, acceptedRecord);
    return { status: 202, body: { ok: true, duplicate_suppressed: false, ...publicAgentResult(acceptedRecord) } };
  } catch (error) {
    const failureRecord = {
      ...initialRecord,
      state: tiktokRequestStarted ? "unknown" : "preflight_failed",
      error_code: tiktokRequestStarted ? "tiktok_result_uncertain" : "preflight_failed",
    };
    try { await guardRequest(env, "update", imageHash, failureRecord); } catch { /* Keep the original operation safely reserved. */ }
    if (tiktokRequestStarted) {
      return {
        status: 502,
        body: {
          ok: false,
          ...publicAgentResult(failureRecord),
          error: "Не удалось подтвердить ответ TikTok. Проверь Inbox; запрос автоматически повторяться не будет.",
        },
      };
    }
    return { status: 503, body: { ok: false, ...publicAgentResult(failureRecord), error: error.message } };
  }
}

async function fetchTikTokPhotoStatus(env, publishId, requestUrl) {
  const token = await accessToken(env, requestUrl);
  let response;
  try {
    response = await fetch(PHOTO_STATUS_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ publish_id: publishId }),
    });
  } catch {
    throw new DraftBoxError("Не удалось получить статус обработки у TikTok.");
  }
  const payload = await parseTikTokResponse(response, "проверке статуса черновика");
  const status = payload.data?.status;
  if (typeof status !== "string" || !status) throw new DraftBoxError("TikTok не вернул статус обработки.");
  return status;
}

async function getAgentStatus(env, imageHash, requestUrl) {
  if (!/^[a-f0-9]{64}$/u.test(imageHash)) return { status: 400, body: { ok: false, error: "Некорректный SHA-256 изображения." } };
  let lookup;
  try {
    lookup = await guardRequest(env, "get", imageHash);
  } catch (error) {
    return { status: 503, body: { ok: false, error: error.message } };
  }
  if (!lookup.record || Number(lookup.record.expires_at || 0) <= Date.now()) return { status: 404, body: { ok: false, error: "Операция не найдена или истёк срок её хранения." } };
  let record = lookup.record;
  if (record.state === "accepted" && record.publish_id) {
    try {
      const tiktokStatus = await fetchTikTokPhotoStatus(env, record.publish_id, requestUrl);
      let state = "accepted";
      if (tiktokStatus === "SEND_TO_USER_INBOX") state = "inbox";
      else if (tiktokStatus === "PUBLISH_COMPLETE") state = "published";
      else if (tiktokStatus === "FAILED") state = "failed";
      record = {
        ...record,
        state,
        tiktok_status: tiktokStatus,
        status_checked_at: new Date().toISOString(),
      };
      await guardRequest(env, "update", imageHash, record);
    } catch {
      // A failed status lookup never triggers a second upload or downgrades a known state.
    }
  }
  return { status: 200, body: { ok: true, ...publicAgentResult(record) } };
}

function decodeBase64Image(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new DraftBoxError("Передай JPEG как обычную Base64-строку без data URL.");
  }
  let binary;
  try { binary = atob(value); } catch { throw new DraftBoxError("Не удалось прочитать Base64 JPEG."); }
  if (binary.length > MAX_IMAGE_BYTES) throw new DraftBoxError("JPEG превышает лимит 20 МБ.");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function mcpToolResult(id, value, isError = false) {
  const result = {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError,
    structuredContent: value,
  };
  return jsonResponse({ jsonrpc: "2.0", id, result }, 200, { "MCP-Protocol-Version": "2025-03-26" });
}

function mcpTools() {
  return [
    {
      name: "upload_finished_meme_to_inbox",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: "Upload one final, selected 1080×1920 JPEG to the already connected TikTok account's Inbox using DraftBox. This only initiates TikTok MEDIA_UPLOAD with video.upload; it never directly publishes. Do not use for options or previews. The same exact JPEG is protected against duplicate uploads for 24 hours.",
      inputSchema: {
        type: "object",
        properties: {
          image_base64: { type: "string", description: "The exact bytes of the saved final JPEG, encoded as standard Base64 without a data: prefix.", maxLength: Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8 },
        },
        required: ["image_base64"],
        additionalProperties: false,
      },
    },
    {
      name: "check_finished_meme_inbox_status",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: "Check an existing DraftBox upload by its returned image_sha256. Reports TikTok accepted, Inbox notification sent, published, failed, or unknown. It never starts another upload.",
      inputSchema: {
        type: "object",
        properties: {
          image_sha256: { type: "string", pattern: "^[a-f0-9]{64}$", description: "image_sha256 returned by the upload tool." },
        },
        required: ["image_sha256"],
        additionalProperties: false,
      },
    },
  ];
}

async function handleMcpRequest(request, env) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
  if (!await isAgentAuthorized(request, env)) {
    const status = typeof env.AGENT_UPLOAD_TOKEN === "string" && env.AGENT_UPLOAD_TOKEN.length >= 43 ? 401 : 503;
    return jsonResponse({ error: status === 401 ? "Unauthorized" : "Agent upload is not configured." }, status, status === 401 ? { "WWW-Authenticate": "Bearer" } : {});
  }
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: "Content-Type must be application/json." }, 415);
  }
  let body;
  try {
    const bytes = await readLimitedBody(request, MCP_MAX_BODY_BYTES);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    return jsonResponse({ error: error instanceof DraftBoxError ? error.message : "Invalid MCP request." }, error instanceof DraftBoxError ? 413 : 400);
  }
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return jsonResponse({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32600, message: "Invalid Request" } }, 400);
  }
  if (body.method === "notifications/initialized") return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  if (body.method === "ping") return jsonResponse({ jsonrpc: "2.0", id: body.id ?? null, result: {} });
  if (body.method === "initialize") {
    const requested = body.params?.protocolVersion;
    return jsonResponse({
      jsonrpc: "2.0",
      id: body.id ?? null,
      result: {
        protocolVersion: typeof requested === "string" ? requested : "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        instructions: "Only send the one saved, selected final meme. Never send variants or previews. This tool initiates TikTok Inbox upload with video.upload and never publishes. After upload, check status; if unknown, do not retry.",
        serverInfo: { name: "DraftBox TikTok Inbox", version: "1.0.0" },
      },
    }, 200, { "MCP-Protocol-Version": typeof requested === "string" ? requested : "2025-03-26" });
  }
  if (body.method === "tools/list") return jsonResponse({ jsonrpc: "2.0", id: body.id ?? null, result: { tools: mcpTools() } });
  if (body.method !== "tools/call") {
    return jsonResponse({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: "Method not found" } }, 200);
  }
  const name = body.params?.name;
  const args = body.params?.arguments || {};
  if (name === "upload_finished_meme_to_inbox") {
    let jpeg;
    try { jpeg = decodeBase64Image(args.image_base64); }
    catch (error) { return mcpToolResult(body.id ?? null, { ok: false, error: error.message }, true); }
    const submitted = await submitAgentMeme(env, jpeg, request.url);
    return mcpToolResult(body.id ?? null, submitted.body, submitted.status >= 400);
  }
  if (name === "check_finished_meme_inbox_status") {
    const checked = await getAgentStatus(env, String(args.image_sha256 || ""), request.url);
    return mcpToolResult(body.id ?? null, checked.body, checked.status >= 400);
  }
  return jsonResponse({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32602, message: "Unknown tool or invalid arguments" } }, 200);
}

export class AgentUploadGuard {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    let input;
    try { input = await request.json(); } catch { return jsonResponse({ error: "Invalid request" }, 400); }
    const { operation, key, record } = input || {};
    if (!/^[a-f0-9]{64}$/u.test(String(key || ""))) return jsonResponse({ error: "Invalid key" }, 400);
    return this.state.blockConcurrencyWhile(async () => {
      const storage = this.state.storage;
      const storageKey = "upload:" + key;
      const now = Date.now();
      if (operation === "claim") {
        const existing = await storage.get(storageKey);
        if (existing && existing.expires_at > now && existing.state !== "preflight_failed") {
          return jsonResponse({ status: "existing", claimed: false, record: existing });
        }
        const rate = await storage.get("agent_rate_window");
        if (rate && now < rate.reset_at && rate.count >= MAX_AGENT_UPLOADS_PER_HOUR) {
          return jsonResponse({ status: "rate_limited" });
        }
        if (!rate || now >= rate.reset_at) {
          await storage.put("agent_rate_window", { count: 1, reset_at: now + 60 * 60 * 1000 });
        } else {
          await storage.put("agent_rate_window", { count: rate.count + 1, reset_at: rate.reset_at });
        }
        await storage.put(storageKey, record);
        return jsonResponse({ status: "claimed", claimed: true, record });
      }
      if (operation === "get") {
        const existing = await storage.get(storageKey);
        return jsonResponse({ record: existing || null });
      }
      if (operation === "update") {
        const existing = await storage.get(storageKey);
        if (!existing) return jsonResponse({ error: "Operation not found" }, 404);
        const updated = { ...existing, ...record, sha256: key };
        await storage.put(storageKey, updated);
        return jsonResponse({ record: updated });
      }
      return jsonResponse({ error: "Unsupported operation" }, 400);
    });
  }
}

async function handleAgentRequest(request, env, url) {
  if (!await isAgentAuthorized(request, env)) {
    const status = typeof env.AGENT_UPLOAD_TOKEN === "string" && env.AGENT_UPLOAD_TOKEN.length >= 43 ? 401 : 503;
    return jsonResponse({ ok: false, error: status === 401 ? "Unauthorized" : "Agent upload is not configured." }, status, status === 401 ? { "WWW-Authenticate": "Bearer" } : {});
  }
  if (url.pathname === "/agent/upload/") {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
    if ((request.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase() !== "image/jpeg") {
      return jsonResponse({ ok: false, error: "Content-Type must be image/jpeg." }, 415);
    }
    const declaredLength = request.headers.get("Content-Length");
    if (declaredLength && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_IMAGE_BYTES)) {
      return jsonResponse({ ok: false, error: "JPEG exceeds the 20 MB limit." }, 413);
    }
    let jpeg;
    try { jpeg = await readLimitedBody(request, MAX_IMAGE_BYTES); }
    catch (error) { return jsonResponse({ ok: false, error: error.message }, 413); }
    const result = await submitAgentMeme(env, jpeg, request.url);
    return jsonResponse(result.body, result.status);
  }
  const match = url.pathname.match(/^\/agent\/status\/([a-f0-9]{64})$/u);
  if (match && request.method === "GET") {
    const result = await getAgentStatus(env, match[1], request.url);
    return jsonResponse(result.body, result.status);
  }
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
}


async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/healthz" && request.method === "GET") return new Response("ok", { headers: { "Cache-Control": "no-store" } });
  if (url.pathname === "/mcp") return handleMcpRequest(request, env);
  if (url.pathname === "/agent/upload/" || url.pathname.startsWith("/agent/status/")) return handleAgentRequest(request, env, url);
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
};
