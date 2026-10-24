import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const state = JSON.parse(readFileSync(new URL("../.mobile/access.json", import.meta.url), "utf8"));
const origin = new URL(state.url);
assert.equal(state.status, "ready");
assert.equal(origin.protocol, "https:");
assert.ok(origin.hostname.endsWith(".trycloudflare.com"));
const requestOptions = () => ({ redirect: "manual", signal: AbortSignal.timeout(15000) });
async function get(path) {
  return fetch(new URL(path, origin), requestOptions());
}
try {
  const anonymous = await get("/api/demo");
  assert.equal(anonymous.status, 401, "Real APIs must require the owner session");
  await anonymous.arrayBuffer();
  const index = await get("/");
  assert.equal(index.status, 200);
  await index.arrayBuffer();
  const css = await get("/styles.css");
  assert.equal(css.status, 200);
  await css.arrayBuffer();
  const secretFile = await get("/.mobile/access.json");
  assert.equal(secretFile.status, 404);
  await secretFile.arrayBuffer();
  const inspect = await fetch(new URL("/api/inspect-instagram", origin), { ...requestOptions(), method: "POST", headers: { Origin: origin.origin, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(inspect.status, 401, "Anonymous callers must never start Opera");
  await inspect.arrayBuffer();
  console.log("Owner HTTPS checks passed: login page, authenticated APIs, CSS, and private-file blocking.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
