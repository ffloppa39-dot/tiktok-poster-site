import test from "node:test";
import assert from "node:assert/strict";
import worker, { AgentUploadGuard } from "../src/index.js";

const APP_ORIGIN = "https://drafts.example.test";

class MemoryKV {
  values = new Map();
  async get(key, type) {
    const value = this.values.get(key)?.value;
    if (value == null) return null;
    if (type === "json") return JSON.parse(value);
    if (type === "arrayBuffer") {
      if (value instanceof ArrayBuffer) return value.slice(0);
      if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      return new TextEncoder().encode(value).buffer;
    }
    return value;
  }
  async put(key, value, options = {}) {
    const stored = value instanceof ArrayBuffer
      ? value.slice(0)
      : ArrayBuffer.isView(value)
        ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
        : value;
    this.values.set(key, { value: stored, options });
  }
}


class MemoryDOStorage {
  values = new Map();
  async get(key) { return this.values.get(key) ?? null; }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async list({ prefix = "" } = {}) {
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix)));
  }
}

class MemoryDurableState {
  storage = new MemoryDOStorage();
  queue = Promise.resolve();
  blockConcurrencyWhile(callback) {
    const pending = this.queue.then(callback);
    this.queue = pending.catch(() => {});
    return pending;
  }
}

class MemoryGuardNamespace {
  state = new MemoryDurableState();
  instance = new AgentUploadGuard(this.state);
  idFromName(name) { return name; }
  get() { return { fetch: (url, init) => this.instance.fetch(new Request(url, init)) }; }
}

function agentJpeg(width = 1080, height = 1920) {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00];
  const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
  return Uint8Array.from([0xff, 0xd8, ...sof, ...sos, 0x00, 0xff, 0xd9]);
}

async function storeConnectedTestAccount(env) {
  const now = Math.floor(Date.now() / 1000);
  await env.TOKENS.put("tiktok_tokens", JSON.stringify({
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    open_id: "existing-connected-open-id",
    scope: "video.upload",
    access_expires_at: now + 86400,
    refresh_expires_at: now + 31536000,
  }));
}

function makeEnv() {
  return {
    APP_PASSWORD: "a-long-test-password-for-draftbox",
    SESSION_SECRET: "test-session-secret-that-is-at-least-32-characters",
    TIKTOK_CLIENT_KEY: "client-key",
    TIKTOK_CLIENT_SECRET: "client-secret",
    PUBLIC_ORIGIN: "",
    AGENT_UPLOAD_TOKEN: "A".repeat(60),
    AGENT_UPLOAD_GUARD: new MemoryGuardNamespace(),
    TOKENS: new MemoryKV(),
  };
}

function cookieFrom(response) {
  const value = response.headers.get("Set-Cookie");
  assert.ok(value, "response should set a session cookie");
  return value.split(";", 1)[0];
}

function csrfFrom(html) {
  const match = html.match(/name="csrf_token" value="([^"]+)"/u);
  assert.ok(match, "response should include CSRF token");
  return match[1];
}

async function call(env, path, options = {}) {
  const headers = new Headers(options.headers || {});
  const request = new Request(`${APP_ORIGIN}${path}`, { ...options, headers });
  return worker.fetch(request, env);
}

async function login(env) {
  const page = await call(env, "/login/");
  let cookie = cookieFrom(page);
  const csrf = csrfFrom(await page.text());
  const form = new URLSearchParams({ csrf_token: csrf, password: env.APP_PASSWORD });
  const response = await call(env, "/login/", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  assert.equal(response.status, 302);
  cookie = cookieFrom(response);
  return cookie;
}

test("OAuth, photo draft upload, and TikTok media fetch work end to end", async () => {
  const env = makeEnv();
  const oldFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (String(url) === "https://open.tiktokapis.com/v2/oauth/token/") {
      return Response.json({
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        open_id: "test-open-id",
        scope: "video.upload",
        expires_in: 86400,
        refresh_expires_in: 31536000,
      });
    }
    if (String(url) === "https://open.tiktokapis.com/v2/post/publish/content/init/") {
      return Response.json({ data: { publish_id: "publish_test-123" }, error: { code: "ok" } });
    }
    throw new Error(`Unexpected outbound request: ${String(url)}`);
  };

  try {
    let cookie = await login(env);
    const connect = await call(env, "/connect/", { headers: { Cookie: cookie } });
    assert.equal(connect.status, 302);
    cookie = cookieFrom(connect);
    const authorize = new URL(connect.headers.get("Location"));
    assert.equal(authorize.origin + authorize.pathname, "https://www.tiktok.com/v2/auth/authorize/");
    assert.equal(authorize.searchParams.get("scope"), "video.upload");
    assert.equal(authorize.searchParams.get("redirect_uri"), `${APP_ORIGIN}/oauth/callback/`);

    const callback = await call(env, `/oauth/callback/?code=temporary-code&state=${authorize.searchParams.get("state")}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(callback.status, 200);
    assert.match(await callback.text(), /TikTok подключён/u);
    cookie = cookieFrom(callback);
    assert.equal((await env.TOKENS.get("tiktok_tokens", "json")).scope, "video.upload");

    const home = await call(env, "/", { headers: { Cookie: cookie } });
    assert.equal(home.status, 200);
    const csrf = csrfFrom(await home.text());
    const form = new FormData();
    form.set("csrf_token", csrf);
    form.set("image", new Blob([Uint8Array.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9])], { type: "image/jpeg" }), "meme.jpg");
    const uploaded = await call(env, "/upload/", { method: "POST", headers: { Cookie: cookie }, body: form });
    assert.equal(uploaded.status, 200);
    assert.match(await uploaded.text(), /TikTok принял мем для черновика/u);

    const photoCall = fetchCalls.find((entry) => entry.url.endsWith("/content/init/"));
    assert.ok(photoCall);
    assert.equal(photoCall.options.headers.Authorization, "Bearer test-access-token");
    const apiBody = JSON.parse(photoCall.options.body);
    assert.equal(apiBody.post_mode, "MEDIA_UPLOAD");
    assert.equal(apiBody.media_type, "PHOTO");
    assert.equal(apiBody.source_info.source, "PULL_FROM_URL");
    assert.deepEqual(apiBody.post_info, {});
    const mediaUrl = new URL(apiBody.source_info.photo_images[0]);
    assert.equal(mediaUrl.origin, APP_ORIGIN);
    assert.match(mediaUrl.pathname, /^\/tiktok\/media\/[A-Za-z0-9_-]{43}\.jpg$/u);

    const storedKey = `media/${mediaUrl.pathname.match(/([A-Za-z0-9_-]{43})\.jpg$/u)[1]}.jpg`;
    assert.equal(env.TOKENS.values.get(storedKey).options.expirationTtl, 2 * 60 * 60);
    const media = await call(env, mediaUrl.pathname);
    assert.equal(media.status, 200);
    assert.equal(media.headers.get("Content-Type"), "image/jpeg");
    assert.deepEqual(new Uint8Array(await media.arrayBuffer()), Uint8Array.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]));
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("uploads require a signed-in session and reject invalid CSRF", async () => {
  const env = makeEnv();
  const denied = await call(env, "/upload/", { method: "POST" });
  assert.equal(denied.status, 302);
  assert.equal(denied.headers.get("Location"), "/login/");

  const cookie = await login(env);
  const invalid = new FormData();
  invalid.set("csrf_token", "not-the-session-token");
  const response = await call(env, "/upload/", { method: "POST", headers: { Cookie: cookie }, body: invalid });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Форма устарела/u);
});

test("an expired access token is refreshed before the photo draft upload", async () => {
  const env = makeEnv();
  const now = Math.floor(Date.now() / 1000);
  await env.TOKENS.put("tiktok_tokens", JSON.stringify({
    access_token: "expired-access-token",
    refresh_token: "old-refresh-token",
    open_id: "test-open-id",
    scope: "video.upload",
    access_expires_at: now - 1,
    refresh_expires_at: now + 86400,
  }));
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === "https://open.tiktokapis.com/v2/oauth/token/") {
      return Response.json({ access_token: "fresh-access-token", refresh_token: "rotated-refresh-token", expires_in: 86400 });
    }
    if (String(url) === "https://open.tiktokapis.com/v2/post/publish/content/init/") {
      return Response.json({ data: { publish_id: "publish_after_refresh" }, error: { code: "ok" } });
    }
    throw new Error(`Unexpected outbound request: ${String(url)}`);
  };
  try {
    const cookie = await login(env);
    const home = await call(env, "/", { headers: { Cookie: cookie } });
    const form = new FormData();
    form.set("csrf_token", csrfFrom(await home.text()));
    form.set("image", new Blob([Uint8Array.from([0xff, 0xd8, 0x10, 0x20, 0xff, 0xd9])], { type: "image/jpeg" }), "meme.jpg");
    const result = await call(env, "/upload/", { method: "POST", headers: { Cookie: cookie }, body: form });
    assert.equal(result.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.body.get("grant_type"), "refresh_token");
    assert.equal(calls[0].options.body.get("refresh_token"), "old-refresh-token");
    assert.equal(calls[1].options.headers.Authorization, "Bearer fresh-access-token");
    const stored = await env.TOKENS.get("tiktok_tokens", "json");
    assert.equal(stored.refresh_token, "rotated-refresh-token");
    assert.equal(stored.scope, "video.upload");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("media route only serves stored files with a random key", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "/tiktok/media/not-a-token.jpg")).status, 404);
  assert.equal((await call(env, `/tiktok/media/${"A".repeat(43)}.jpg`)).status, 404);
});

test("TikTok URL-prefix verification file is served only at its exact public path", async () => {
  const env = makeEnv();
  const content = new TextEncoder().encode("tiktok-verification-signature");
  await env.TOKENS.put("verification/tiktok-domain-check.txt", content.buffer);

  const verified = await call(env, "/tiktok/tiktok-domain-check.txt");
  assert.equal(verified.status, 200);
  assert.equal(verified.headers.get("Content-Type"), "application/octet-stream");
  assert.equal(await verified.text(), "tiktok-verification-signature");
  assert.equal((await call(env, "/tiktok/not-found.txt")).status, 404);
});


test("agent upload requires bearer auth, JPEG MIME, and exact final dimensions", async () => {
  const env = makeEnv();
  const unauthenticated = await call(env, "/agent/upload/", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: agentJpeg(),
  });
  assert.equal(unauthenticated.status, 401);

  const wrongMime = await call(env, "/agent/upload/", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.AGENT_UPLOAD_TOKEN, "Content-Type": "image/png" },
    body: agentJpeg(),
  });
  assert.equal(wrongMime.status, 415);

  const wrongDimensions = await call(env, "/agent/upload/", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.AGENT_UPLOAD_TOKEN, "Content-Type": "image/jpeg" },
    body: agentJpeg(500, 500),
  });
  assert.equal(wrongDimensions.status, 400);
});

test("agent uploads are atomically deduplicated and status distinguishes Inbox from publication", async () => {
  const env = makeEnv();
  await storeConnectedTestAccount(env);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === "https://open.tiktokapis.com/v2/post/publish/content/init/") {
      return Response.json({ data: { publish_id: "p_pub_url~meme-test" }, error: { code: "ok" } });
    }
    if (String(url) === "https://open.tiktokapis.com/v2/post/publish/status/fetch/") {
      return Response.json({ data: { status: "SEND_TO_USER_INBOX" }, error: { code: "ok" } });
    }
    throw new Error("Unexpected outbound request");
  };

  try {
    const bytes = agentJpeg();
    const headers = { Authorization: "Bearer " + env.AGENT_UPLOAD_TOKEN, "Content-Type": "image/jpeg" };
    const first = await call(env, "/agent/upload/", { method: "POST", headers, body: bytes });
    assert.equal(first.status, 202);
    const firstResult = await first.json();
    assert.equal(firstResult.state, "accepted");
    assert.equal(firstResult.publish_id, "p_pub_url~meme-test");

    const duplicate = await call(env, "/agent/upload/", { method: "POST", headers, body: bytes });
    assert.equal(duplicate.status, 202);
    const duplicateResult = await duplicate.json();
    assert.equal(duplicateResult.duplicate_suppressed, true);
    assert.equal(duplicateResult.state, "accepted");
    assert.equal(calls.filter((item) => item.url.endsWith("/content/init/")).length, 1);

    const status = await call(env, "/agent/status/" + firstResult.image_sha256, {
      headers: { Authorization: "Bearer " + env.AGENT_UPLOAD_TOKEN },
    });
    assert.equal(status.status, 200);
    const statusResult = await status.json();
    assert.equal(statusResult.state, "inbox");
    assert.equal(statusResult.tiktok_status, "SEND_TO_USER_INBOX");
    assert.equal(calls.filter((item) => item.url.endsWith("/status/fetch/")).length, 1);
    assert.equal(calls.some((item) => item.url.includes("/publish/") && !item.url.endsWith("/status/fetch/") && !item.url.endsWith("/content/init/")), false);
    const account = await env.TOKENS.get("tiktok_tokens", "json");
    assert.equal(account.open_id, "existing-connected-open-id");
    assert.equal(account.scope, "video.upload");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("concurrent identical agent uploads call TikTok init only once", async () => {
  const env = makeEnv();
  await storeConnectedTestAccount(env);
  const originalFetch = globalThis.fetch;
  let initCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url) === "https://open.tiktokapis.com/v2/post/publish/content/init/") {
      initCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({ data: { publish_id: "p_pub_url~concurrent" }, error: { code: "ok" } });
    }
    throw new Error("Unexpected outbound request");
  };
  try {
    const headers = { Authorization: "Bearer " + env.AGENT_UPLOAD_TOKEN, "Content-Type": "image/jpeg" };
    const [left, right] = await Promise.all([
      call(env, "/agent/upload/", { method: "POST", headers, body: agentJpeg() }),
      call(env, "/agent/upload/", { method: "POST", headers, body: agentJpeg() }),
    ]);
    assert.equal(left.status, 202);
    assert.equal(right.status, 202);
    assert.equal(initCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote MCP exposes only guarded upload and status tools", async () => {
  const env = makeEnv();
  const denied = await call(env, "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(denied.status, 401);

  const headers = { Authorization: "Bearer " + env.AGENT_UPLOAD_TOKEN, "Content-Type": "application/json" };
  const initialized = await call(env, "/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }),
  });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.headers.get("MCP-Protocol-Version"), "2025-03-26");

  const listed = await call(env, "/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  const toolNames = (await listed.json()).result.tools.map((tool) => tool.name);
  assert.deepEqual(toolNames, ["upload_finished_meme_to_inbox", "check_finished_meme_inbox_status"]);
  assert.equal(toolNames.some((name) => name.includes("publish")), false);
});


test("ambiguous TikTok timeout is not retried and stays marked unknown", async () => {
  const env = makeEnv();
  await storeConnectedTestAccount(env);
  const originalFetch = globalThis.fetch;
  let initCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url) === "https://open.tiktokapis.com/v2/post/publish/content/init/") {
      initCalls += 1;
      throw new Error("simulated timeout");
    }
    throw new Error("Unexpected outbound request");
  };
  try {
    const headers = { Authorization: "Bearer " + env.AGENT_UPLOAD_TOKEN, "Content-Type": "image/jpeg" };
    const first = await call(env, "/agent/upload/", { method: "POST", headers, body: agentJpeg() });
    assert.equal(first.status, 502);
    const firstResult = await first.json();
    assert.equal(firstResult.state, "unknown");

    const repeated = await call(env, "/agent/upload/", { method: "POST", headers, body: agentJpeg() });
    assert.equal(repeated.status, 202);
    const repeatedResult = await repeated.json();
    assert.equal(repeatedResult.duplicate_suppressed, true);
    assert.equal(repeatedResult.state, "unknown");
    assert.equal(initCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
