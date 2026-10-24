import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDemoNote, samples, GUEST_CODE } from "../guest/data.js";

test("guest samples cover three fictional people, all durations and every offered product", () => {
  assert.equal(Object.keys(samples).length, 3);
  for (const personId of Object.keys(samples)) {
    for (const [duration, minutes] of [["5分", 5], ["30分", 30], ["1時間", 60], ["2時間", 120]]) {
      for (const offer of ["auto", "ランニング", "ピラティス", "AI", "その他"]) {
        const note = makeDemoNote({ personId, duration, offer, customOffer: "英会話レッスン" });
        assert.equal(note.sample, true);
        assert.equal(note.person.interests.length, 3);
        assert.equal(note.person.phrases.length, 3);
        assert.ok(note.person.role.includes("架空"));
        assert.match(note.timeline.at(-1).time, new RegExp(`${minutes}分$`));
        assert.ok(note.selectedOffer);
      }
    }
  }
  assert.throws(() => makeDemoNote({ personId: "real_account" }));
  assert.throws(() => makeDemoNote({ personId: "yoga", offer: "その他", customOffer: "" }));
});

test("the guest bundle has no network clients, live endpoints or owner account defaults", () => {
  const source = ["app.js", "data.js"].map(name => readFileSync(new URL(`../guest/${name}`, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|localhost|127\.0\.0\.1|\/api\/|ryuji__|chillingfukuoka/);
  assert.doesNotMatch(source, /localStorage|OPENAI_API_KEY|OLLAMA_BASE_URL|human_loop_owner/);
  const html = readFileSync(new URL("../guest/index.html", import.meta.url), "utf8");
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /Instagramの読み取り・新しいAI分析は行いません/);
  assert.match(html, /個人情報を守るためのログインではありません/);
  assert.equal(GUEST_CODE, "HUMANLOOP");
});

test("sample interests do not change when the visitor manually selects a product", () => {
  for (const offer of ["AI", "ランニング", "ピラティス"]) {
    const note = makeDemoNote({ personId: "boxing", offer });
    assert.equal(note.person.interests[0], "ボクシング");
    assert.equal(note.selectedOffer, offer);
    assert.match(note.reason, /手動/);
  }
});

test("Vercel publishes only the isolated guest build and excludes private local files", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.framework, null);
  assert.equal(config.buildCommand, "npm run build:guest");
  assert.equal(config.outputDirectory, ".guest-build");
  assert.equal(config.functions, undefined);
  assert.equal(config.rewrites, undefined);
  const headers = config.headers.flatMap(rule => rule.headers);
  assert.match(headers.find(header => header.key === "Content-Security-Policy").value, /connect-src 'none'/);
  const ignored = readFileSync(new URL("../.vercelignore", import.meta.url), "utf8").split(/\r?\n/);
  for (const pattern of [".env", ".env.*", ".private/", ".mobile/", "artifacts/"]) assert.ok(ignored.includes(pattern));
});
