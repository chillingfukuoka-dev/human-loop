import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnerGate, OWNER_COOKIE } from "../lib/owner-access.mjs";
import { createMobileGateway } from "../lib/mobile-gateway.mjs";

const password = "example-owner-password-2026";
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "human-loop-owner-test-"));
  const stateFile = join(dir, "private", "owner-auth.json");
  const calls = [];
  let time = Date.now();
  const server = createServer(createOwnerGate({
    stateFile, assetsDir: new URL("../public/", import.meta.url).pathname, now: () => time,
    handler(req, res) { calls.push(req.url); res.writeHead(200); res.end("real-operation"); }
  }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); rmSync(dir, { recursive: true }); });
  function send(path, method, data, headers) {
    return new Promise((resolve, reject) => {
      const body = data === undefined ? undefined : JSON.stringify(data);
      const req = request({ hostname: "127.0.0.1", port: server.address().port, path, method, headers: {
        Host: new URL(origin).host, ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}), ...headers
      } }, res => {
        let text = "";
        res.on("data", chunk => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, headers: { get(name) { const value = res.headers[name.toLowerCase()]; return Array.isArray(value) ? value.join(", ") : value ?? null; } }, async text() { return text; }, async json() { return JSON.parse(text); } }));
      });
      req.on("error", reject); req.end(body);
    });
  }
  const get = (path, headers = {}) => send(path, "GET", undefined, headers);
  const post = (path, data, headers = {}) => send(path, "POST", data, { Origin: origin, "Content-Type": "application/json", ...headers });
  const setup = () => post("/api/auth/setup", { password });
  return { calls, get, post, setup, stateFile, port: server.address().port, later() { time += 13 * 60 * 60 * 1000; } };
}

test("anonymous and guest-code requests cannot invoke real APIs or start Opera", async t => {
  const { get, post, calls } = await fixture(t);
  assert.match(await (await get("/")).text(), /本人用ログイン/);
  for (const path of ["/api/demo", "/api/opera-status", "/app.js"]) assert.equal((await get(path)).status, 401);
  for (const path of ["/api/inspect-instagram", "/api/prepare"]) assert.equal((await post(path, { guestCode: "HUMANLOOP" }, { Cookie: `${OWNER_COOKIE}=forged` })).status, 401);
  assert.deepEqual(calls, []);
});

test("only local first setup is allowed; the password is hashed and stored privately", async t => {
  const f = await fixture(t);
  const remote = await f.post("/api/auth/setup", { password }, { Host: "mobile.example.test", Origin: "https://mobile.example.test", "X-Human-Loop-Gateway": "1" });
  assert.equal(remote.status, 403);
  assert.equal((await f.post("/api/auth/setup", { password: "short" })).status, 400);
  const response = await f.setup();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const saved = readFileSync(f.stateFile, "utf8");
  assert.ok(!saved.includes(password));
  assert.equal(JSON.parse(saved).hash.length, 128);
  assert.equal(statSync(f.stateFile).mode & 0o777, 0o600);
  assert.equal((await f.setup()).status, 409);
});

test("the owner can log in, call real functions, and revoke the session by logging out", async t => {
  const f = await fixture(t);
  await f.setup();
  const response = await f.post("/api/auth/login", { password });
  const Cookie = response.headers.get("set-cookie").split(";")[0];
  assert.equal((await f.post("/api/inspect-instagram", {}, { Cookie })).status, 200);
  assert.deepEqual(f.calls, ["/api/inspect-instagram"]);
  await f.post("/api/auth/logout", {}, { Cookie });
  assert.equal((await f.post("/api/prepare", {}, { Cookie })).status, 401);
});

test("origin, host, expired sessions and login guessing are rejected before real operations", async t => {
  const f = await fixture(t);
  assert.equal((await f.post("/api/auth/setup", { password }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await f.get("/", { Host: "evil.example" })).status, 421);
  const response = await f.setup();
  const Cookie = response.headers.get("set-cookie").split(";")[0];
  assert.equal((await f.post("/api/prepare", {}, { Cookie, Origin: "null" })).status, 403);
  f.later();
  assert.equal((await f.post("/api/prepare", {}, { Cookie })).status, 401);
  for (let i = 0; i < 6; i++) assert.equal((await f.post("/api/auth/login", { password: "wrong-password" })).status, 401);
  assert.equal((await f.post("/api/auth/login", { password })).status, 429);
  assert.deepEqual(f.calls, []);
});

test("HTTPS mobile logins use Secure cookies and do not enable CORS", async t => {
  const f = await fixture(t);
  await f.setup();
  const response = await f.post("/api/auth/login", { password }, { Host: "mobile.example.test", Origin: "https://mobile.example.test", "X-Human-Loop-Gateway": "1" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /; Secure/);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("simultaneous guesses cannot bypass the password hashing rate limit", async t => {
  const f = await fixture(t);
  await f.setup();
  const results = await Promise.all(Array.from({ length: 12 }, () => f.post("/api/auth/login", { password: "wrong-password" })));
  assert.equal(results.filter(response => response.status === 401).length, 6);
  assert.equal(results.filter(response => response.status === 429).length, 6);
  assert.deepEqual(f.calls, []);
});

test("the complete mobile path denies guests but relays only the owner session", async t => {
  const f = await fixture(t);
  await f.setup();
  const gateway = createMobileGateway({ upstreamPort: f.port });
  const origin = "https://mobile.example.test";
  gateway.setPublicOrigin(origin);
  await new Promise(resolve => gateway.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { gateway.server.close(resolve); gateway.server.closeAllConnections(); }));
  function post(path, body, Cookie) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = request({ hostname: "127.0.0.1", port: gateway.server.address().port, path, method: "POST", headers: {
        Host: "mobile.example.test", Origin: origin, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...(Cookie ? { Cookie } : {})
      } }, res => { res.resume(); res.on("end", () => resolve({ status: res.statusCode, cookie: res.headers["set-cookie"]?.[0] })); });
      req.on("error", reject); req.end(data);
    });
  }
  assert.equal((await post("/api/inspect-instagram", { guestCode: "HUMANLOOP" })).status, 401);
  assert.equal((await post("/api/auth/setup", { password })).status, 403);
  assert.deepEqual(f.calls, []);
  const login = await post("/api/auth/login", { password });
  assert.equal(login.status, 200);
  assert.match(login.cookie, /HttpOnly; SameSite=Strict; Max-Age=43200; Secure/);
  const cookie = login.cookie.split(";")[0];
  assert.equal((await post("/api/inspect-instagram", {}, `sessionid=private-instagram-cookie; ${cookie}`)).status, 200);
  assert.deepEqual(f.calls, ["/api/inspect-instagram"]);
  await post("/api/auth/logout", {}, cookie);
  assert.equal((await post("/api/prepare", {}, cookie)).status, 401);
});
