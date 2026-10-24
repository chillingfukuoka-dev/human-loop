import test from "node:test";
import assert from "node:assert/strict";
import { createOfferRecommender } from "../lib/offer-recommendation.mjs";

const profile = (text) => `【話す相手のInstagram公開情報】\nプロフィール画面：${text}`;
const responseFor = (answer) => ({ ok: true, json: async () => ({ message: { content: JSON.stringify(answer) } }) });

test("Ollama infers a use for AI from preparation phrased without a preset keyword", async () => {
  const quote = "生徒ごとのプリントを毎晩用意しています。";
  const requests = [];
  const recommend = createOfferRecommender({ fetchImpl: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return responseFor({ needId: "work_drafting", sourceId: "1", quote });
  } });
  const result = await recommend(profile(quote), "teacher");
  assert.equal(result.offer, "AI");
  assert.equal(result.method, "ollama");
  assert.equal(result.confidence, "possible");
  assert.match(result.reason, /準備を楽にする/);
  assert.equal(result.evidence[0].quote, quote);
  assert.equal(requests[0].body.options.num_ctx, 4096);
});

test("Ollama can connect the counterpart's body training or endurance to the right product", async () => {
  for (const [quote, needId, offer] of [
    ["体の軸をぶらさず動く練習をしています。", "body_control", "ピラティス"],
    ["山道を長く歩けるように練習しています。", "endurance", "ランニング"]
  ]) {
    const recommend = createOfferRecommender({ fetchImpl: async () => responseFor({ needId, sourceId: "1", quote }) });
    const result = await recommend(profile(quote));
    assert.equal(result.offer, offer);
    assert.equal(result.method, "ollama");
  }
});

test("only counterpart sources reach the local AI", async () => {
  let sent;
  const recommend = createOfferRecommender({ fetchImpl: async (_, options) => {
    sent = JSON.parse(options.body).messages[1].content;
    return responseFor({ needId: "body_control", sourceId: "1", quote: "プロボクサー" });
  } });
  const result = await recommend(`【あなたのInstagram公開情報】\nプロフィール画面：operator-secret ChatGPT 自動化\n\n${profile("プロボクサー。")}`);
  assert.equal(result.offer, "ピラティス");
  assert.doesNotMatch(sent, /operator-secret|ChatGPT|自動化/);
});

test("does not accept a fabricated quote or an unrelated use of a real quote", async () => {
  for (const answer of [
    { needId: "work_drafting", sourceId: "1", quote: "教材の準備が大変です" },
    { needId: "work_admin", sourceId: "1", quote: "プロボクサー" },
    { needId: "body_control", sourceId: "99", quote: "身体づくり・体の使い方" }
  ]) {
    const recommend = createOfferRecommender({ fetchImpl: async () => responseFor(answer) });
    const result = await recommend(profile("プロボクサー。"));
    assert.equal(result.offer, "ピラティス");
    assert.equal(result.method, "connections");
  }
});

test("can identify an exact unique source even if a small model confuses its id", async () => {
  const quote = "生徒ごとのプリントを毎晩用意しています。";
  const recommend = createOfferRecommender({ fetchImpl: async () => responseFor({ needId: "work_drafting", sourceId: "work_drafting", quote }) });
  const result = await recommend(profile(quote));
  assert.equal(result.offer, "AI");
  assert.equal(result.method, "ollama");
  assert.equal(result.evidence[0].source, "公開プロフィール");
});

test("falls back to grounded activity connections if Ollama is unavailable or malformed", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("offline"); },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => ({ message: { content: "not JSON" } }) })
  ]) {
    const recommend = createOfferRecommender({ fetchImpl });
    const result = await recommend(profile("登山が好き。"));
    assert.equal(result.offer, "ランニング");
    assert.equal(result.method, "connections");
  }
});

test("does not invoke AI for generic occupations, generic health, direct or rejected interests", async () => {
  let calls = 0;
  const recommend = createOfferRecommender({ fetchImpl: async () => { calls++; throw new Error("should not be called"); } });
  for (const text of ["料理が好き。", "起業しています。", "健康が大切。", "英語講師。", "登山が好き。ランニングは苦手。"] ) {
    assert.equal((await recommend(profile(text))).offer, null);
  }
  assert.equal((await recommend(profile("ランニングが好き。"))).offer, "ランニング");
  assert.equal(calls, 0);
});

test("rejects negative activity quotes rather than inventing interest", async () => {
  const recommend = createOfferRecommender({ fetchImpl: async () => responseFor({ needId: "endurance", sourceId: "1", quote: "登山は嫌い" }) });
  assert.equal((await recommend(profile("登山は嫌い。"))).offer, null);
});

test("reuses only identical account and source snapshots between inspect and prepare", async () => {
  let calls = 0;
  const recommend = createOfferRecommender({ fetchImpl: async () => {
    calls++;
    return responseFor({ needId: "body_control", sourceId: "1", quote: "プロボクサー" });
  } });
  await Promise.all([recommend(profile("プロボクサー。"), "person1"), recommend(profile("プロボクサー。"), "person1")]);
  assert.equal(calls, 1);
  await recommend(profile("プロボクサー。"), "person2");
  assert.equal(calls, 2);
  await recommend(profile("プロボクサー。体づくり。"), "person1");
  assert.equal(calls, 3);
});

test("local AI is optional and does not silently call a paid API", async () => {
  const recommend = createOfferRecommender({ enabled: false, fetchImpl: async () => { throw new Error("must not call"); } });
  const result = await recommend(profile("レッスン準備をしています。"));
  assert.equal(result.offer, "AI");
  assert.equal(result.method, "connections");
});

test("checks rejections in the whole source, even beyond the shortened model input", async () => {
  const recommend = createOfferRecommender({ fetchImpl: async () => responseFor({ needId: "body_control", sourceId: "1", quote: "プロボクサー" }) });
  const result = await recommend(profile(`プロボクサー。${"紹介文。".repeat(200)}ピラティスはやらない。`));
  assert.equal(result.offer, null);
});

test("invalidates the decision when source text changes beyond the model excerpt", async () => {
  let calls = 0;
  const recommend = createOfferRecommender({ fetchImpl: async () => {
    calls++;
    return responseFor({ needId: "body_control", sourceId: "1", quote: "プロボクサー" });
  } });
  const text = `プロボクサー。${"紹介文。".repeat(200)}`;
  await recommend(profile(`${text}ひとつめ。`), "person1");
  await recommend(profile(`${text}ふたつめ。`), "person1");
  assert.equal(calls, 2);
});
