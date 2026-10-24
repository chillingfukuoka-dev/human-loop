import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { matchesInstagramPage } from "../lib/instagram-evidence.mjs";

const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
const start = server.indexOf("const instagramPageCaptureScript =");
const end = server.indexOf("async function captureInstagramPage(", start);
const code = `${server.slice(start, end)}\ninstagramPageCaptureScript`;

async function capture(pathname) {
  let expanded = false;
  let loginClicks = 0;
  const main = { get innerText() { return expanded ? "編集長。取材・出版。高校とつくる本の活動。" : "編集長。取材・出版。... 続きを読む"; } };
  const buttons = [
    { innerText: "ログイン", click() { loginClicks++; } },
    { innerText: "続きを読む", click() { expanded = true; } }
  ];
  const context = { URL, setTimeout: (callback) => callback(),
    location: { pathname, href: `https://www.instagram.com${pathname}` },
    document: { title: "公開プロフィール", querySelector: () => main, querySelectorAll: (selector) => selector === 'main button, main [role="button"]' ? buttons : [] }
  };
  const script = runInNewContext(code, context);
  const data = await runInNewContext(`(${script})()`, context);
  return { data, expanded, loginClicks };
}

test("capture expands the public biography before reading it, without clicking sign-in", async () => {
  const result = await capture("/book_person/");
  assert.equal(result.expanded, true);
  assert.match(result.data.text, /高校とつくる本/);
  assert.equal(result.loginClicks, 0);
});

test("capture does not expand unrelated buttons on posts and stories", async () => {
  for (const path of ["/book_person/p/abc/", "/stories/book_person/"]) {
    const result = await capture(path);
    assert.equal(result.expanded, false);
    assert.equal(result.loginClicks, 0);
  }
});

test("page identity cannot switch to the operator, another post, a login gate or the app", () => {
  assert.equal(matchesInstagramPage("https://www.instagram.com/person/", "https://www.instagram.com/person/?hl=ja"), true);
  assert.equal(matchesInstagramPage("https://www.instagram.com/person/p/AbC/", "https://www.instagram.com/p/AbC/"), true);
  assert.equal(matchesInstagramPage("https://www.instagram.com/stories/person/", "https://www.instagram.com/stories/person/123/"), true);
  for (const actual of ["http://localhost:3000/", "https://www.instagram.com/operator/", "https://www.instagram.com/accounts/login/", "https://example.com/person/"]) {
    assert.equal(matchesInstagramPage("https://www.instagram.com/person/", actual), false);
  }
  assert.equal(matchesInstagramPage("https://www.instagram.com/person/p/AbC/", "https://www.instagram.com/operator/p/DEF/"), false);
  assert.equal(matchesInstagramPage("https://www.instagram.com/person/p/AbC/", "https://www.instagram.com/p/abc/"), false);
  assert.equal(matchesInstagramPage("https://www.instagram.com/stories/person/", "https://www.instagram.com/stories/operator/123/"), false);
});

test("the actual capture pipeline discards mismatched data and closes only its target tab", async () => {
  const from = server.indexOf("async function captureInstagramPage(");
  const to = server.indexOf("async function collectInstagramInfo(", from);
  const expected = "https://www.instagram.com/person/p/AbC/";
  for (const actual of [expected, "https://www.instagram.com/operator/p/DEF/", "http://localhost:3000/"]) {
    const closed = [];
    const context = { matchesInstagramPage, instagramPageCaptureScript: "capture", parseCliJson: JSON.parse,
      runOpera: async (_, [command, value]) => {
        if (command === "new_page") return { ok: true, stdout: JSON.stringify({ pages: [{ id: 7, selected: true, url: expected }] }) };
        if (command === "evaluate_script") return { ok: true, stdout: JSON.stringify({ url: actual, text: "body" }) };
        if (command === "close_page") closed.push(value);
        return { ok: true };
      }
    };
    const result = await runInNewContext(`${server.slice(from, to)}\ncaptureInstagramPage(${JSON.stringify(expected)})`, context);
    assert.equal(result.ok, actual === expected);
    if (actual !== expected) assert.equal(result.data, undefined);
    assert.deepEqual(closed, ["7"]);
  }
});

test("an unexpected selected tab is neither read nor closed", async () => {
  const from = server.indexOf("async function captureInstagramPage(");
  const to = server.indexOf("async function collectInstagramInfo(", from);
  const commands = [];
  const context = { matchesInstagramPage, instagramPageCaptureScript: "capture", parseCliJson: JSON.parse,
    runOpera: async (_, [command]) => {
      commands.push(command);
      return { ok: true, stdout: JSON.stringify({ pages: [{ id: 99, selected: true, url: "http://localhost:3000/" }] }) };
    }
  };
  const result = await runInNewContext(`${server.slice(from, to)}\ncaptureInstagramPage("https://www.instagram.com/person/")`, context);
  assert.equal(result.ok, false);
  assert.deepEqual(commands, ["new_page"]);
});

test("concurrent API inspections cannot interleave two accounts, and the lock is released", async () => {
  const from = server.indexOf("async function handle(");
  const to = server.indexOf("const ownerHandler", from);
  const handler = server.slice(from, to);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const context = { URL, console, instagramInspectionBusy: false,
    readBody: async () => ({ profileUrl: "https://www.instagram.com/person/" }),
    isInstagramUrl: () => true, normalizeInstagramUrl: (value) => value, instagramUsername: () => "person",
    commandAvailable: async () => ({ available: true }),
    collectInstagramInfo: async () => { await pending; return { ok: true }; },
    formatInstagramInfo: () => "公開プロフィール", analyzeInterests: async () => [], recommendOffer: async () => ({ offer: null }),
    json: (res, status, data) => Object.assign(res, { status, data })
  };
  runInNewContext(`${handler}\nthis.inspect = handle`, context);
  const req = { method: "POST", url: "/api/inspect-instagram", headers: { host: "localhost:3000" } };
  const first = {}, second = {}, third = {};
  const active = context.inspect(req, first);
  await context.inspect(req, second);
  assert.equal(second.status, 409);
  release();
  await active;
  assert.equal(first.status, 200);
  assert.equal(context.instagramInspectionBusy, false);
  await context.inspect(req, third);
  assert.equal(third.status, 200);
});
