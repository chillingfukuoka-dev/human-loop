import test from "node:test";
import assert from "node:assert/strict";
import { recommendOffer } from "../lib/offer-recommendation.mjs";

const profile = (text) => `【話す相手のInstagram公開情報】\nプロフィール画面：${text}`;

test("uses only the counterpart when both accounts are present", () => {
  const context = `【あなたのInstagram公開情報】\nプロフィール画面：AI、ChatGPT、業務自動化。\n\n${profile("ランニングが好き。フルマラソンに挑戦中。")}`;
  assert.equal(recommendOffer(context).offer, "ランニング");
  assert.equal(recommendOffer("【あなたのInstagram公開情報】\nプロフィール画面：AIとピラティス").offer, null);
});

test("relates yoga and body care to Pilates with a visible reason", () => {
  const result = recommendOffer(profile("ヨガ・ストレッチ・姿勢改善。"));
  assert.equal(result.offer, "ピラティス");
  assert.match(result.reason, /公開プロフィール/);
  assert.ok(result.evidence.length > 0);
});

test("recommends AI for explicit interest in AI or reducing manual work", () => {
  assert.equal(recommendOffer(profile("ChatGPTを使った仕事の時短。" )).offer, "AI");
  assert.equal(recommendOffer(profile("資料作成を効率化したい。" )).offer, "AI");
});

test("does not assume an entrepreneur or a fashion account needs AI", () => {
  for (const text of ["起業・事業づくり。自分らしい働き方。", "料理・レシピの紹介。", "スニーカーとストリートファッションが好き。", "健康が大切。", ""]) {
    const result = recommendOffer(profile(text));
    assert.equal(result.offer, null, text);
    assert.equal(result.status, "insufficient");
  }
});

test("ignores usernames, links, Meta AI and image descriptions", () => {
  const context = `${profile("sample__ai ファッションが好き。https://www.instagram.com/ai/ Meta AI")}\nプロフィール上の画像説明：Video by AI・ピラティス・マラソンの先生`;
  assert.equal(recommendOffer(context, "sample__ai").offer, null);
});

test("does not mistake Instagram's AI content label for an interest in AI", () => {
  assert.equal(recommendOffer(profile("プロボクサー。AIコンテンツ" )).offer, "ピラティス");
  assert.equal(recommendOffer(profile("料理が好き。AI情報 Made with AI" )).offer, null);
});

test("does not recommend an explicitly rejected interest", () => {
  assert.equal(recommendOffer(profile("AIは使わない。ランニングが好き。" )).offer, "ランニング");
  assert.equal(recommendOffer(profile("ランニングは苦手。AIに興味がない。" )).offer, null);
});

test("ignores other people's comments below the owner's caption", () => {
  const context = `${profile("ヨガをしています。 ")}\n公開投稿：\n1. yoga_teacher 3週間前 ヨガを楽しみました。 other_person 2週間前 AI ChatGPT Claude 自動化が便利です。 いいね！ 返信`;
  assert.equal(recommendOffer(context, "yoga_teacher").offer, "ピラティス");
});

test("asks the user to choose when two candidates are equally supported", () => {
  const result = recommendOffer(profile("ランニングとピラティスを楽しんでいます。"));
  assert.equal(result.offer, null);
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(new Set(result.alternatives), new Set(["ランニング", "ピラティス"]));
});

test("does not treat a sign-in gate as a readable story", () => {
  const context = `${profile("ファッションが好き。 ")}\n公開ストーリーズ：\n1. ハイライトをもっと見よう。AIのストーリーズハイライトをもっと見るには登録してください。`;
  assert.equal(recommendOffer(context).offer, null);
});

test("can recommend Pilates from the owner's exercise post without changing their main interests", () => {
  const context = `${profile("ファッションとスニーカーが好き。 ")}\n公開投稿：\n1. 運動不足を解消したくて、体幹トレーニングに参加しました。`;
  assert.equal(recommendOffer(context).offer, "ピラティス");
});

test("connects boxing and body training to Pilates without claiming an existing interest", () => {
  for (const activity of ["プロボクサー。WBA女子ミニマム級チャンピオン。", "毎日の身体づくり。", "体作りを頑張っています。", "ダンスを続けています。"] ) {
    const result = recommendOffer(profile(activity));
    assert.equal(result.offer, "ピラティス", activity);
    assert.equal(result.basis, "inferred");
    assert.match(result.reason, /身体づくり・体の使い方/);
    assert.match(result.reason, /候補/);
    assert.ok(result.evidence[0].quote);
  }
});

test("connects hiking, stamina and exercise habits to running", () => {
  for (const activity of ["週末は登山。", "スタミナをつけたい。", "体力づくりに取り組んでいます。", "ウォーキングを続けています。"] ) {
    const result = recommendOffer(profile(activity));
    assert.equal(result.offer, "ランニング", activity);
    assert.equal(result.basis, "inferred");
    assert.match(result.reason, /候補/);
  }
});

test("connects real preparation and administration tasks to AI, not just an occupation", () => {
  for (const activity of ["英語講師。毎日のレッスンの準備をしています。", "予約の管理に時間がかかっています。", "告知文を毎日考えています。"] ) {
    const result = recommendOffer(profile(activity));
    assert.equal(result.offer, "AI", activity);
    assert.equal(result.basis, "inferred");
    assert.match(result.reason, /候補/);
  }
  assert.equal(recommendOffer(profile("英語講師です。" )).offer, null);
});

test("keeps stronger direct interests ahead of indirect activities", () => {
  assert.equal(recommendOffer(profile("ボクサー。ランニングが大好き。" )).offer, "ランニング");
  assert.equal(recommendOffer(profile("登山が趣味。ヨガもしています。" )).offer, "ピラティス");
});

test("does not use the operator or other people's comments for indirect recommendations", () => {
  const context = `【あなたのInstagram公開情報】\nプロフィール画面：ボクサー。登山と教材づくり。\n\n${profile("料理が好き。")}`;
  assert.equal(recommendOffer(context).offer, null);
  const comments = `${profile("旅行が好き。 ")}\n公開投稿：\n1. traveler 3週間前 旅行しました。 other_person 2週間前 ボクシングと登山と教材づくり。`;
  assert.equal(recommendOffer(comments, "traveler").offer, null);
});

test("does not infer an offer that is explicitly declined", () => {
  assert.equal(recommendOffer(profile("登山が好き。ランニングは苦手。" )).offer, null);
  assert.equal(recommendOffer(profile("ボクサー。ピラティスはやらない。" )).offer, null);
  assert.equal(recommendOffer(profile("レッスン準備をしています。AIは使わない。" )).offer, null);
  assert.equal(recommendOffer(profile("ボクシングはやらない。登山は嫌い。" )).offer, null);
});
