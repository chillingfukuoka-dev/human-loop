import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { analyzeInstagramInterests, interestConversation, interestPhrases, interestVideos } from "../lib/instagram-interests.mjs";
import { recommendOffer } from "../lib/offer-recommendation.mjs";
import { offerGuidanceFor } from "../lib/offer-guidance.mjs";

const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
const block = (from, to) => server.slice(server.indexOf(from), server.indexOf(to, server.indexOf(from) + from.length));
const code = [
  block("function instagramSectionFor(", "function json("),
  block("function normalizeInstagramUrl(", "function instagramStoriesUrl("),
  block("async function prepareNote(", "async function handle(")
].join("\n");
const context = "【話す相手のInstagram公開情報】\nプロフィール画面：スキンケアブランド。広報PR事業。";
const input = { offer: "auto", profileUrl: "https://www.instagram.com/brand_person/", counterpartInstagramContext: context };

function runtime(rawInput, extra = {}) {
  return { input: rawInput, URL, console, analyzeInstagramInterests, interestConversation, interestPhrases, interestVideos, offerGuidanceFor,
    recommendOffer, analyzeInterests: async (...args) => analyzeInstagramInterests(...args),
    buildBrief: async () => { throw new Error("must not build a product pitch for an unselected product"); }, ...extra };
}

test("automatic preparation returns interests and useful conversation even with no matching product", async () => {
  const brief = await runInNewContext(`${code}\nprepareNote(input)`, runtime(input));
  assert.equal(brief.productPending, true);
  assert.equal(brief.selectedOffer, null);
  assert.equal(brief.offerRecommendation.applied, false);
  assert.ok(brief.instagramInsights.some((item) => item.title === "スキンケア・美容"));
  assert.ok(brief.instagramInsights.some((item) => item.title === "広報・PR"));
  assert.equal(brief.impactPhrases.length, 3);
  assert.match(brief.preMeetingVideos[0].query, /スキンケア|広報/);
  assert.equal(brief.objections.length, 0);
  assert.equal(brief.proposal.length, 0);
  assert.equal(brief.competitors.length, 0);
  assert.equal(brief.meta.fallback, false);
  assert.doesNotMatch(JSON.stringify([brief.summary, brief.objective, brief.questions, brief.conversationPlan]), /AI|ランニング|ピラティス|auto|サービス|提案/);
});

test("all four time plans remain listening-first when a product is pending", async () => {
  for (const duration of ["5分", "30分", "1時間", "2時間"]) {
    const brief = await runInNewContext(`${code}\nprepareNote(input)`, runtime({ ...input, duration }));
    assert.match(brief.conversationPlan[0].topic, /スキンケア|広報/);
    assert.ok(brief.conversationPlan.some((item) => item.topic === "大切にしていることを聞く"));
    assert.doesNotMatch(JSON.stringify(brief.conversationPlan), /提案：|サービスを|何から試す/);
  }
});

test("ambiguous recommendations also return a note without inventing a selected product", async () => {
  const ambiguous = { status: "ambiguous", offer: null, alternatives: ["AI", "ピラティス"] };
  const brief = await runInNewContext(`${code}\nprepareNote(input)`, runtime(input, { recommendOffer: async () => ambiguous }));
  assert.equal(brief.productPending, true);
  assert.equal(brief.selectedOffer, null);
  assert.ok(brief.instagramInsights.length);
});

test("manual product choice and successful auto-choice keep the existing product preparation path", async () => {
  for (const [rawInput, recommendation, applied] of [
    [{ ...input, offer: "ピラティス", productPending: true }, { status: "insufficient", offer: null }, false],
    [input, { status: "recommended", offer: "AI" }, true]
  ]) {
    let called;
    const brief = await runInNewContext(`${code}\nprepareNote(input)`, runtime(rawInput, {
      recommendOffer: async () => recommendation,
      buildBrief: async (resolved) => { called = resolved; return { summary: "prepared" }; }
    }));
    assert.equal(brief.productPending, false);
    assert.equal(called.offer, rawInput.offer === "auto" ? "AI" : "ピラティス");
    assert.equal(called.productPending, false);
    assert.equal(brief.offerRecommendation.applied, applied);
  }
});

test("the form submits preparation even when the recommendation has no product", async () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const submitCode = app.slice(app.indexOf('form.addEventListener("submit",'), app.indexOf("\ncheckOpera();"));
  let handler, requested, rendered, message;
  const span = {};
  const button = { querySelector: () => span };
  const profileUrl = input.profileUrl;
  const form = {
    elements: { offer: { value: "auto" }, operatorProfileUrl: { value: "" }, profileUrl: { value: profileUrl } },
    addEventListener: (_, callback) => { handler = callback; },
    querySelector: () => button, setAttribute() {}, removeAttribute() {}
  };
  const payload = { productPending: true, offerRecommendation: { offer: null }, instagramInsights: [{ title: "スキンケア・美容" }] };
  runInNewContext(submitCode, {
    form, document: { querySelector: () => ({ value: context, dataset: { source: `\n${profileUrl}` } }) },
    latestOfferRecommendation: { offer: null }, formData: () => input,
    fetchWithTimeout: async (path) => { requested = path; return { ok: true, json: async () => payload }; },
    setOfferRecommendation() {}, setNotice: (value) => { message = value; }, renderBrief: (value) => { rendered = value; }
  });
  await handler({ preventDefault() {} });
  assert.equal(requested, "/api/prepare");
  assert.equal(rendered, payload);
  assert.match(message, /相手の興味をまとめました/);
  assert.equal(button.disabled, false);
});

test("the result view shows a pending-product note and restores objections after manual choice", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const renderCode = app.slice(app.indexOf("function renderBrief("), app.indexOf('document.querySelector("#demoBtn").addEventListener'));
  const nodes = new Map();
  const get = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, { focus() {}, scrollIntoView() {} });
    return nodes.get(selector);
  };
  const context = { document: { querySelector: get }, results: get("#results"), window: { matchMedia: () => ({ matches: false }) },
    setOfferRecommendation() {}, oneLine: (value) => value,
    conversationPlanList: () => "", instagramInsightsList: () => "", impactPhrasesList: () => "", objectionsList: () => "", preMeetingVideosList: () => "", commonGroundList: () => "" };
  runInNewContext(`${renderCode}\nrenderBrief({productPending:true,offerRecommendation:{offer:null}})`, context);
  assert.equal(get("#results").hidden, false);
  assert.equal(get("#recommendedOfferCard").hidden, false);
  assert.match(get("#recommendedOfferTitle").textContent, /あとで決めて/);
  assert.equal(get("#objectionsCard").hidden, true);
  assert.equal(get('.result-flow a[href="#objections"]').hidden, true);
  runInNewContext(`${renderCode}\nrenderBrief({productPending:false,offerRecommendation:{offer:null,applied:false}})`, context);
  assert.equal(get("#recommendedOfferCard").hidden, true);
  assert.equal(get("#objectionsCard").hidden, false);
  assert.equal(get('.result-flow a[href="#objections"]').hidden, false);
});
