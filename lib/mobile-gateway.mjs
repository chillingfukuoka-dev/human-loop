import { createServer, request as httpRequest } from "node:http";

const PUBLIC_FILES = new Set(["/", "/index.html", "/app.js", "/styles.css", "/meeting-note.svg", "/flower.svg", "/login.html", "/login.js"]);
const API_GET = new Set(["/api/demo", "/api/opera-status", "/api/auth/status"]);
const API_POST = new Set(["/api/prepare", "/api/inspect-instagram", "/api/auth/login", "/api/auth/logout"]);
const OWNER_COOKIE = "human_loop_owner";

function readLimitedBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on("data", chunk => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        const error = new Error("入力が長すぎます。短くしてお試しください。");
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!tooLarge) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("aborted")));
  });
}

// This loopback-only gateway is exposed by the temporary tunnel.
// Only the owner's HttpOnly session cookie is relayed. Browser/Instagram
// cookies, arbitrary URLs, credentials and filesystem paths are not relayed.
export function createMobileGateway({ upstreamPort = 3000 } = {}) {
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) throw new Error("Invalid upstream port");
  let origin = null;
  let host = null;
  let busy = false;

  function headers(res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader("Strict-Transport-Security", "max-age=86400");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  }
  function send(res, status, message) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: message }));
  }
  async function proxy(req, res, path, body) {
    if (req.method === "POST" && busy) return send(res, 409, "いま別の準備をしています。少し待ってからお試しください。");
    const exclusive = req.method === "POST";
    if (exclusive) busy = true;
    await new Promise(resolve => {
      let finished = false;
      function finish() {
        if (finished) return;
        finished = true;
        if (exclusive) busy = false;
        resolve();
      }
      const cookie = req.headers.cookie?.split(";").map(value => value.trim()).find(value => new RegExp(`^${OWNER_COOKIE}=[A-Za-z0-9_-]{43}$`).test(value));
      const upstream = httpRequest({
        hostname: "127.0.0.1", port: upstreamPort, path, method: req.method,
        headers: {
          Host: host, "X-Human-Loop-Gateway": "1", ...(req.method === "POST" ? { Origin: origin } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body ? { "Content-Type": "application/json", "Content-Length": body.length } : {})
        },
      }, response => {
        const cookies = (response.headers["set-cookie"] || []).filter(value => value.startsWith(`${OWNER_COOKIE}=`));
        res.writeHead(response.statusCode || 502, {
          "Content-Type": response.headers["content-type"] || "text/plain; charset=utf-8",
          ...(cookies.length ? { "Set-Cookie": cookies } : {}),
          ...(response.headers.location === "/" ? { Location: "/" } : {})
        });
        response.pipe(res);
        response.on("end", finish);
        response.on("error", error => { res.destroy(error); finish(); });
      });
      upstream.setTimeout(180_000, () => upstream.destroy(new Error("timeout")));
      upstream.on("error", () => {
        if (!res.headersSent && !res.destroyed) send(res, 503, "Mac側の準備ができていません。少し待ってから開き直してください。");
        else if (!res.destroyed) res.end();
        finish();
      });
      res.on("close", () => { upstream.destroy(); finish(); });
      upstream.end(body);
    });
  }

  async function handle(req, res) {
    headers(res);
    if (!origin) return send(res, 503, "接続を準備しています。");
    if (req.headers.host !== host) return send(res, 421, "この接続先は利用できません。");
    if (!req.url.startsWith("/") || req.url.startsWith("//")) return send(res, 400, "接続先を確認してください。");
    const url = new URL(req.url, origin);
    if (url.origin !== origin) return send(res, 400, "接続先を確認してください。");
    if (!["GET", "POST"].includes(req.method)) return send(res, 405, "この操作は利用できません。");

    // The upstream enforces owner authentication on every real operation.
    if (req.method === "POST" && req.headers.origin !== origin) return send(res, 403, "この画面を開き直してからお試しください。");

    const path = url.pathname;
    if (path === "/api/auth/setup") return send(res, 403, "最初の設定はMacの本人用ページで行ってください。");
    if (req.method === "GET" && (PUBLIC_FILES.has(path) || API_GET.has(path))) return proxy(req, res, path);
    if (req.method === "POST" && API_POST.has(path)) {
      if (req.headers["content-type"]?.split(";")[0] !== "application/json") return send(res, 415, "入力画面からお試しください。");
      const body = await readLimitedBody(req, 64 * 1024);
      try { JSON.parse(body.toString("utf8")); } catch { return send(res, 400, "入力内容を確認してください。"); }
      return proxy(req, res, path, body);
    }
    return send(res, 404, "ページが見つかりません。");
  }

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000, maxHeaderSize: 16 * 1024 }, (req, res) => {
    handle(req, res).catch(error => {
      if (!res.headersSent && !res.destroyed) send(res, error.status || 500, error.status === 413 ? error.message : "接続を確認して、もう一度お試しください。");
      else if (!res.destroyed) res.end();
    });
  });
  server.maxConnections = 50;
  return {
    server,
    setPublicOrigin(value) {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("An HTTPS origin is required");
      origin = url.origin;
      host = url.host;
    },
  };
}
