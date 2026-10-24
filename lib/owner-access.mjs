import { randomBytes, scrypt as deriveKey, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

const scrypt = promisify(deriveKey);
export const OWNER_COOKIE = "human_loop_owner";
const SESSION_MS = 12 * 60 * 60 * 1000;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const tokenHash = value => createHash("sha256").update(value).digest("hex");

export function createOwnerGate({ handler, stateFile, assetsDir, now = Date.now }) {
  let owner = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null;
  if (owner && (!/^[a-f0-9]{32}$/.test(owner.salt) || !/^[a-f0-9]{128}$/.test(owner.hash))) throw new Error("本人用のログイン設定を確認してください。");
  const sessions = new Map();
  const attempts = new Map();
  let settingUp = false;

  function authenticated(req) {
    const token = req.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith(`${OWNER_COOKIE}=`))?.slice(OWNER_COOKIE.length + 1) || "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const expires = sessions.get(tokenHash(token));
    return Boolean(expires && expires > now());
  }
  function sessionCookie(req, res) {
    for (const [key, expires] of sessions) if (expires <= now()) sessions.delete(key);
    if (sessions.size >= 12) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString("base64url");
    sessions.set(tokenHash(token), now() + SESSION_MS);
    res.setHeader("Set-Cookie", `${OWNER_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${req.headers["x-human-loop-gateway"] === "1" ? "; Secure" : ""}`);
  }
  function send(res, status, value) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }
  function file(res, name, type) {
    res.writeHead(200, { "Content-Type": type });
    res.end(readFileSync(join(assetsDir, name)));
  }
  async function readPassword(req) {
    if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw Object.assign(new Error("入力画面からお試しください。"), { status: 415 });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) throw Object.assign(new Error("入力が長すぎます。"), { status: 413 });
      chunks.push(chunk);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("入力内容を確認してください。"), { status: 400 }); }
    if (typeof data?.password !== "string" || data.password.length > 256) throw Object.assign(new Error("パスワードを確認してください。"), { status: 400 });
    return data.password;
  }

  return async function ownerGate(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      // This service is intentionally loopback-only. Only the constrained
      // mobile gateway may relay an external host, never an arbitrary website.
      if (!LOOPBACK.has(req.socket.remoteAddress)) return send(res, 403, { error: "本人用ページからお試しください。" });
      const proxied = req.headers["x-human-loop-gateway"] === "1";
      const origin = `${proxied ? "https" : "http"}://${req.headers.host}`;
      const base = new URL(origin);
      if (!proxied && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) return send(res, 421, { error: "接続先を確認してください。" });
      if (!req.url.startsWith("/") || req.url.startsWith("//")) return send(res, 400, { error: "接続先を確認してください。" });
      const url = new URL(req.url, base);
      if (!["GET", "POST"].includes(req.method)) return send(res, 405, { error: "この操作は使えません。" });
      if (req.method === "POST" && req.headers.origin !== origin) return send(res, 403, { error: "本人用ページを開き直してください。" });
      const path = url.pathname;
      if (req.method === "GET" && path === "/api/auth/status") return send(res, 200, { authenticated: authenticated(req), needsSetup: !owner, setupAllowed: !proxied, mode: "owner" });
      if (req.method === "GET" && path === "/login.js") return file(res, "login.js", "text/javascript; charset=utf-8");
      if (req.method === "GET" && path === "/styles.css") return file(res, "styles.css", "text/css; charset=utf-8");
      if (req.method === "GET" && path === "/flower.svg") return file(res, "flower.svg", "image/svg+xml");
      if (req.method === "POST" && ["/api/auth/login", "/api/auth/setup"].includes(path)) {
        const key = req.socket.remoteAddress;
        for (const [id, attempt] of attempts) if (attempt.until <= now()) attempts.delete(id);
        if ((attempts.get(key)?.count || 0) >= 6) {
          res.setHeader("Retry-After", "900");
          return send(res, 429, { error: "少し時間をあけてからお試しください。" });
        }
        // Count before awaiting the body/hash so simultaneous guesses cannot
        // all pass the limit and consume unbounded password-hashing work.
        const previous = attempts.get(key);
        attempts.set(key, { count: (previous?.count || 0) + 1, until: previous?.until || now() + 900_000 });
        const password = await readPassword(req);
        if (path === "/api/auth/setup") {
          if (proxied) return send(res, 403, { error: "最初の設定はMacの http://localhost:3000 で行ってください。" });
          if (owner || settingUp) return send(res, 409, { error: "設定済みです。ログインしてください。" });
          if (password.length < 12) return send(res, 400, { error: "パスワードは12文字以上にしてください。" });
          settingUp = true;
          try {
            const salt = randomBytes(16).toString("hex");
            const hash = (await scrypt(password, salt, 64)).toString("hex");
            mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
            chmodSync(dirname(stateFile), 0o700);
            writeFileSync(stateFile, JSON.stringify({ salt, hash }) + "\n", { flag: "wx", mode: 0o600 });
            owner = { salt, hash };
          } finally { settingUp = false; }
        } else {
          if (!owner) return send(res, 403, { error: "先にMac側で本人用パスワードを設定してください。" });
          const hash = await scrypt(password, owner.salt, 64);
          if (!timingSafeEqual(hash, Buffer.from(owner.hash, "hex"))) {
            return send(res, 401, { error: "パスワードが違います。" });
          }
        }
        attempts.delete(key);
        sessionCookie(req, res);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && path === "/api/auth/logout") {
        const raw = req.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith(`${OWNER_COOKIE}=`))?.slice(OWNER_COOKIE.length + 1) || "";
        sessions.delete(tokenHash(raw));
        res.setHeader("Set-Cookie", `${OWNER_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${proxied ? "; Secure" : ""}`);
        return send(res, 200, { ok: true });
      }
      if (!authenticated(req)) {
        if (req.method === "GET" && ["/", "/index.html", "/login.html"].includes(path)) return file(res, "login.html", "text/html; charset=utf-8");
        return send(res, 401, { error: "本人用のログインが必要です。", loginRequired: true });
      }
      if (path === "/login.html") { res.writeHead(303, { Location: "/" }); return res.end(); }
      return await handler(req, res);
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : "ログイン設定を確認して、もう一度お試しください。" });
      else if (!res.destroyed) res.end();
    }
  };
}
