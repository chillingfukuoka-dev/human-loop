import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createMobileGateway } from "../lib/mobile-gateway.mjs";

const origin = "https://mobile.example.test";
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

async function fixture(t) {
  const calls = [];
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      calls.push({ path: req.url, method: req.method, headers: req.headers, body });
      if (req.url === "/api/auth/login") res.setHeader("Set-Cookie", ["human_loop_owner=" + "A".repeat(43) + "; HttpOnly; Secure", "sessionid=should-not-be-relayed"]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await listen(upstream);
  const gateway = createMobileGateway({ upstreamPort: upstream.address().port });
  gateway.setPublicOrigin(origin);
  await listen(gateway.server);
  t.after(async () => { await close(gateway.server); await close(upstream); });
  async function send(path, { method = "GET", body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: gateway.server.address().port, path, method, headers: {
        Host: new URL(origin).host, ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}), ...headers,
      } }, res => {
        let text = "";
        res.on("data", chunk => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }
  return { send, calls };
}

test("requires an HTTPS public origin and valid upstream port", () => {
  assert.throws(() => createMobileGateway({ upstreamPort: 0 }));
  const gateway = createMobileGateway();
  assert.throws(() => gateway.setPublicOrigin("http://mobile.example.test"));
});

test("mobile gateway forwards only the approved app and login routes", async t => {
  const { send, calls } = await fixture(t);
  for (const path of ["/", "/index.html", "/app.js", "/styles.css", "/meeting-note.svg", "/flower.svg", "/api/demo", "/api/opera-status", "/api/auth/status", "/login.js", "/login.html"]) {
    assert.equal((await send(path)).status, 200);
  }
  assert.equal((await send("/mobile/login")).status, 404);
  for (const path of ["/.env.local", "/../server.mjs", "/.mobile/access.json", "/%2e%2e%2fserver.mjs", "/unknown", "/api/admin"]) {
    assert.equal((await send(path)).status, 404);
  }
  assert.equal(calls.length, 11);
});

test("only the owner cookie is relayed, never Instagram cookies or setup requests", async t => {
  const { send, calls } = await fixture(t);
  const token = "A".repeat(43);
  const response = await send("/api/auth/login", { method: "POST", body: "{}", headers: {
    Origin: origin, "Content-Type": "application/json", Cookie: `sessionid=private; human_loop_owner=${token}; csrftoken=private`
  } });
  assert.equal(response.status, 200);
  assert.equal(calls[0].headers.cookie, `human_loop_owner=${token}`);
  assert.equal(calls[0].headers.host, "mobile.example.test");
  assert.equal(calls[0].headers.origin, origin);
  assert.equal(response.headers["set-cookie"].length, 1);
  assert.match(response.headers["set-cookie"][0], /^human_loop_owner=/);
  assert.equal((await send("/api/auth/setup", { method: "POST", body: "{}", headers: { Origin: origin, "Content-Type": "application/json" } })).status, 403);
  assert.equal(calls.length, 1);
});

test("forwards valid JSON writes without exposing incoming cookies", async t => {
  const { send, calls } = await fixture(t);
  const response = await send("/api/prepare", {
    method: "POST",
    body: JSON.stringify({ counterpart: "テスト" }),
    headers: { Origin: origin, Cookie: "old-session=secret", "Content-Type": "application/json" },
  });
  assert.equal(response.status, 200);
  assert.equal(calls[0].path, "/api/prepare");
  assert.equal(calls[0].headers.cookie, undefined);
  assert.equal(calls[0].headers.authorization, undefined);
});

test("protects state-changing requests with Origin and validates input", async t => {
  const { send, calls } = await fixture(t);
  for (const headers of [{}, { Origin: "null" }, { Origin: "https://evil.example" }]) {
    assert.equal((await send("/api/prepare", { method: "POST", body: "{}", headers })).status, 403);
  }
  assert.equal((await send("/api/prepare", { method: "POST", body: "{}", headers: { Origin: origin, "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await send("/api/prepare", { method: "POST", body: "not json", headers: { Origin: origin, "Content-Type": "application/json" } })).status, 400);
  assert.equal((await send("/api/prepare", { method: "POST", body: "x".repeat(70000), headers: { Origin: origin, "Content-Type": "application/json" } })).status, 413);
  assert.equal(calls.length, 0);
});

test("blocks spoofed hosts, absolute proxy requests and unsupported methods", async t => {
  const { send, calls } = await fixture(t);
  assert.equal((await send("/api/demo", { headers: { Host: "evil.example" } })).status, 421);
  assert.equal((await send("http://127.0.0.1:11434/")).status, 400);
  assert.equal((await send("//evil.example/")).status, 400);
  assert.equal((await send("/", { method: "OPTIONS" })).status, 405);
  assert.equal(calls.length, 0);
});
