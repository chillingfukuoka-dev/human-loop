import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { extractInstagramSources } from "../lib/instagram-evidence.mjs";
import { analyzeInstagramInterests, createInterestAnalyzer, interestConversation, interestPhrases, interestVideos } from "../lib/instagram-interests.mjs";
import { offerGuidanceFor } from "../lib/offer-guidance.mjs";
import { recommendOffer } from "../lib/offer-recommendation.mjs";

const profile = (text) => `【話す相手のInstagram公開情報】\nプロフィール画面：${text}`;
const boxingContext = `${profile("sports_person フォロワー3826人 フォロー中926人 Sana | Pro Boxer Professional Boxer Ex-WBC Silver Champion my son")}
プロフィール上の画像説明：Video by sports_person。ヨガをしている人、ランニングマシン、pilates、1人以上の画像のようです。
公開投稿：
1. sports_person 3週間前 世界へ挑戦。#ボクシング #Prove コメントはまだありません。
2. sports_person 2週間前 ドキュメンタリー映画 #boxing other_person 1週間前 ヨガとランニングが好きです。子供のサッカーも応援。
3. sports_person 1週間前 Son. You are my strength. 息子よ、あなたが私の強さです。#boxing
公開ストーリーズ：
1. ハイライトをもっと見よう。AIのストーリーズハイライトをもっと見るには登録してください。`;
const titles = (items) => items.map((item) => item.title);

test("boxer's public bio and repeated captions put boxing first, without filling three slots", () => {
  const interests = analyzeInstagramInterests(boxingContext, "sports_person");
  assert.deepEqual(titles(interests), ["ボクシング", "家族・子育て"]);
  assert.equal(interests[0].evidence[0].kind, "profile");
  assert.match(interests[0].evidence[0].quote, /Boxer/);
  assert.ok(interests[0].score > interests[1].score);
});

test("recognizes the main sport in an English-only profile", () => {
  assert.equal(analyzeInstagramInterests(profile("Professional Boxer 🇯🇵"))[0].title, "ボクシング");
  assert.equal(analyzeInstagramInterests(profile("プロボクサー。"))[0].title, "ボクシング");
});

test("automatic image labels and other people's comments are not interests", () => {
  const sources = extractInstagramSources(boxingContext, { username: "sports_person" });
  const text = sources.map((source) => source.text).join(" ");
  assert.doesNotMatch(text, /ヨガ|ランニング|pilates|サッカー|フォロワー|フォロー中|ハイライト/);
  assert.match(text, /息子|boxing/);
});

test("interests, conversation, phrases and video all follow the same main topic", () => {
  const interests = analyzeInstagramInterests(boxingContext, "sports_person");
  assert.match(interestConversation(interests).topic, /ボクシング/);
  for (const phrase of interestPhrases(interests)) assert.match(phrase, /ボクシング/);
  assert.match(interestVideos(interests)[0].query, /ボクシング/);
  assert.doesNotMatch(JSON.stringify([interestConversation(interests), interestPhrases(interests), interestVideos(interests)]), /ヨガ|ランニング|ピラティス/);
});

test("product suggestions remain separate from observed interests", () => {
  const recommendation = recommendOffer(boxingContext, "sports_person");
  assert.equal(recommendation.offer, "ピラティス");
  assert.equal(analyzeInstagramInterests(boxingContext, "sports_person")[0].title, "ボクシング");
  assert.ok(!titles(analyzeInstagramInterests(boxingContext, "sports_person")).includes("ピラティス"));
});

test("the operator does not influence counterpart themes", () => {
  const context = `【あなたのInstagram公開情報】\nプロフィール画面：生成AIとランニングとピラティス。\n\n${boxingContext}`;
  assert.deepEqual(titles(analyzeInstagramInterests(context, "sports_person")), ["ボクシング", "家族・子育て"]);
  assert.deepEqual(analyzeInstagramInterests("【あなたのInstagram公開情報】\nプロフィール画面：ボクシング。"), []);
});

test("works across cooking, English, yoga and running, without account-specific seeds", () => {
  for (const [text, expected] of [
    ["料理研究家。毎日レシピを紹介。", "料理・食事"],
    ["English teacher 英語講師。英会話を教えています。", "英語・語学"],
    ["ヨガインストラクター。ヨガと呼吸のレッスン。", "ヨガ"],
    ["ランナー。マラソンとランニングが好き。", "ランニング"]
  ]) {
    const result = analyzeInstagramInterests(profile(text));
    assert.equal(result[0].title, expected);
    assert.match(interestVideos(result)[0].title, new RegExp(expected));
  }
});

test("does not treat a timestamp as a work-efficiency interest or a treadmill as running", () => {
  const context = `${profile("プロボクサー。") }\nプロフィール上の画像説明：ランニングマシン、ヨガ、AI。\n公開投稿：\n1. sports_person 5時間前 今日は練習しました。`;
  assert.deepEqual(titles(analyzeInstagramInterests(context, "sports_person")), ["ボクシング"]);
});

const skincareContext = `${profile('経営広報事業│椿油ナチュラルスキンケア「BRAND」 高等学校非常勤講師。出版社の広報PR＆サポート。広報PR担当。')}
公開投稿：
1. 大好きだった読書とラジオに救われた。
2. 作ったお料理でお願いします。
3. 女性起業家。美容講師として活動する傍ら、スキンケアを紹介。`;

test("skincare and PR in the bio outrank incidental reading and cooking", () => {
  const interests = analyzeInstagramInterests(skincareContext);
  assert.deepEqual(new Set(titles(interests).slice(0, 2)), new Set(["スキンケア・美容", "広報・PR"]));
  assert.ok(!titles(interests).includes("学びや発信"));
  assert.ok(!titles(interests).includes("料理・食事"));
  assert.ok(interests.slice(0, 2).every((item) => item.evidence.some((evidence) => evidence.kind === "profile")));
  assert.match(interestVideos(interests)[0].query, /スキンケア|広報/);
  assert.doesNotMatch(interestVideos(interests)[0].query, /AI|ランニング|ピラティス/);
});

test("specialist themes are preserved when Ollama is unavailable or returns side topics", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("offline"); },
    async () => answer([{ title: "読書", sourceId: "2", quote: "大好きだった読書とラジオに救われた。" }])
  ]) {
    const interests = await createInterestAnalyzer({ fetchImpl })(skincareContext);
    assert.deepEqual(new Set(titles(interests).slice(0, 2)), new Set(["スキンケア・美容", "広報・PR"]));
  }
});

test("does not infer beauty or PR from usernames, image descriptions or the operator", () => {
  const context = `【あなたのInstagram公開情報】\nプロフィール画面：化粧品ブランド。広報PR担当。\n\n${profile("ヨガインストラクター。PRince。")}
プロフィール上の画像説明：化粧品、コスメ、スキンケア。`;
  assert.deepEqual(titles(analyzeInstagramInterests(context)), ["ヨガ"]);
});

test("does not replace generic fitness with Pilates, or generic occupation with AI", () => {
  assert.deepEqual(titles(analyzeInstagramInterests(profile("パーソナルトレーナー。fitness。"))), ["運動・体づくり"]);
  assert.ok(!titles(analyzeInstagramInterests(profile("英語講師。"))).includes("AIや新しい技術"));
  assert.deepEqual(analyzeInstagramInterests(profile("ヨガはやらない。")), []);
});

const editorialContext = `${profile("地域メディア編集長・仕事図鑑著者。取材・編集。知らない仕事や生き方との出会いをつくる。高校とつくる本。")}
公開投稿：
1. book_person 編集済み • 1週間前 子どもたちに知らない仕事の可能性を伝えたい。01号は学習帳を思わせるデザイン。02号では取材した方の写真を主役に。本の企画・編集を担当しました。
2. book_person 1週間前 子どもたちの将来につながるキャリア教育。編集長として本を出版。
3. book_person 2週間前 学校に仕事図鑑を届ける。取材先の方の物語を紹介。`;

test("publishing a career-education book is not inferred as personal parenting or studying", () => {
  const interests = analyzeInstagramInterests(editorialContext, "book_person");
  assert.equal(interests[0].title, "取材・編集・出版");
  assert.ok(titles(interests).includes("教育・学びの支援"));
  assert.ok(!titles(interests).includes("家族・子育て"));
  assert.ok(!titles(interests).includes("学びや発信"));
  assert.match(interestConversation(interests).topic, /取材・編集・出版/);
  assert.match(interestVideos(interests)[0].query, /取材|本づくり/);
});

test("Instagram's edited timestamp is not editorial work", () => {
  const context = `${profile("ヨガインストラクター。") }\n公開投稿：\n1. yoga_person 編集済み • 3週間前 ヨガの練習。`;
  assert.deepEqual(titles(analyzeInstagramInterests(context, "yoga_person")), ["ヨガ"]);
});

test("education does not erase explicitly described personal parenting", () => {
  const context = `${profile("二児の母。子育てと教育を大切にしています。") }\n公開投稿：\n1. 息子の学校の授業参観に行きました。`;
  assert.ok(titles(analyzeInstagramInterests(context)).includes("家族・子育て"));
});

test("a kimono artist's explicit field is recognized without padding or double-counting broad art", () => {
  const context = `${profile("KIMONO Artist。伝統を現代に生かし未来へ。着物を裁断せず、現代アート・空間へ再構築。") }\n公開投稿：\n1. artist_person 1週間前 着物の作品を展示します。\n2. artist_person 編集済み • 1週間前 帯の模様を生かした着物アート。`;
  const interests = analyzeInstagramInterests(context, "artist_person");
  assert.deepEqual(titles(interests), ["着物・和の文化"]);
  assert.match(interestConversation(interests).topic, /着物/);
  assert.match(interestVideos(interests)[0].query, /着物アート/);
  assert.equal(recommendOffer(context, "artist_person").offer, null);
});

test("general art remains available when no more specific art field is stated", () => {
  assert.equal(analyzeInstagramInterests(profile("現代アートの作品制作。Artist。"))[0].title, "アート・作品づくり");
});

test("an incidental specialized subject does not hide the artist's main profession", () => {
  const interests = analyzeInstagramInterests(`${profile("現代アートの作品制作。Artist。") }\n公開投稿：\n1. 今日は着物を着てみました。`);
  assert.equal(interests[0].title, "アート・作品づくり");
});

test("a publicly stated astrology practice is not reduced to only parenting", () => {
  const context = `${profile("子育て向けの星の専門家。やさしい占星術。西洋占星術士。ホロスコープ鑑定士。星読みと育児について発信しています。") }\n公開投稿：\n1. 女性の人生と子育てを星読みする専門家です。占星術の観点から個性についてお話しします。\n2. 子育ての相談と星読みのイベントを行います。`;
  const interests = analyzeInstagramInterests(context, "consultant_person");
  assert.equal(interests[0].title, "占星術・星読み");
  assert.ok(titles(interests).includes("家族・子育て"));
  assert.match(interestConversation(interests).topic, /星読み/);
  assert.match(interestVideos(interests)[0].query, /占星術|星読み/);
  assert.ok(interestPhrases(interests).every((phrase) => /星読み|占星術/.test(phrase)));
  assert.equal(recommendOffer(context, "consultant_person").offer, null);
});

test("stars or parenting alone do not imply astrology or religious beliefs", () => {
  assert.deepEqual(analyzeInstagramInterests(profile("星空を見るのが好きです。")), []);
  assert.ok(!titles(analyzeInstagramInterests(profile("子育てと育児を発信。"))).includes("占星術・星読み"));
  assert.deepEqual(analyzeInstagramInterests(profile("占星術はやらない。")), []);
});

const answer = (topics) => ({ ok: true, json: async () => ({ message: { content: JSON.stringify({ topics }) } }) });

test("AI can add an unfamiliar topic when it is grounded in the owner's actual words", async () => {
  const quote = "陶芸家として、土と釉薬の表現を探しています。";
  const analyze = createInterestAnalyzer({ fetchImpl: async () => answer([{ title: "陶芸", sourceId: "1", quote }]) });
  assert.equal((await analyze(profile(quote)))[0].title, "陶芸");
});

test("a directly stated brand or specialist business is also a grounded unfamiliar theme", async () => {
  for (const quote of ["銀細工ブランドを運営しています。", "銀細工の制作が仕事です。"]) {
    const analyze = createInterestAnalyzer({ fetchImpl: async () => answer([{ title: "銀細工", sourceId: "1", quote }]) });
    assert.equal((await analyze(profile(quote)))[0].title, "銀細工");
  }
});

test("English role suffixes ground unfamiliar creative professions too", async () => {
  const quote = "盆栽 Artist。植物の形を生かした作品を制作しています。";
  const analyze = createInterestAnalyzer({ fetchImpl: async () => answer([{ title: "盆栽", sourceId: "1", quote }]) });
  assert.equal((await analyze(profile(quote)))[0].title, "盆栽");
});

test("does not let an AI response erase the primary profession or invent interests", async () => {
  const analyze = createInterestAnalyzer({ fetchImpl: async () => answer([
    { title: "ヨガ", sourceId: "1", quote: "Professional Boxer" },
    { title: "ピラティス", sourceId: "1", quote: "ピラティスが大好きです" }
  ]) });
  assert.deepEqual(titles(await analyze(boxingContext, "sports_person")), ["ボクシング", "家族・子育て"]);
});

test("AI only receives cleaned counterpart text, not image descriptions or the operator", async () => {
  let sent;
  const analyze = createInterestAnalyzer({ fetchImpl: async (_, options) => {
    sent = JSON.parse(options.body).messages[1].content;
    return answer([]);
  } });
  const context = `【あなたのInstagram公開情報】\nプロフィール画面：operator-secret。ChatGPT。\n\n${boxingContext}`;
  await analyze(context, "sports_person");
  assert.doesNotMatch(sent, /operator-secret|ChatGPT|ヨガ|ランニング|pilates/);
  assert.match(sent, /Professional Boxer|boxing/);
});

test("Ollama failures do not lose the central profession", async () => {
  const analyze = createInterestAnalyzer({ fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal((await analyze(profile("Professional Boxer")))[0].title, "ボクシング");
});

test("reuses decisions only for identical cleaned evidence and the same account", async () => {
  let calls = 0;
  const analyze = createInterestAnalyzer({ fetchImpl: async () => { calls++; return answer([]); } });
  await analyze(profile("Professional Boxer"), "person1");
  await analyze(profile("Professional Boxer"), "person1");
  assert.equal(calls, 1);
  await analyze(profile("English teacher"), "person1");
  await analyze(profile("Professional Boxer"), "person2");
  assert.equal(calls, 3);
});

// 実際のサーバー関数を、ポートやモデルを起動せずに検証する。
const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
const block = (from, to) => server.slice(server.indexOf(from), server.indexOf(to, server.indexOf(from) + from.length));
const pureServer = [
  block("function instagramSectionFor(", "const listeningGuide ="),
  block("function interestContextFor(", "function objectionsFor("),
  block("function normalizeInstagramUrl(", "function instagramStoriesUrl("),
  block("function ensureInstagramInsights(", "function json(")
].join("\n");
const serverContext = (input) => ({ input, URL, analyzeInstagramInterests, interestConversation, interestPhrases, interestVideos, offerGuidanceFor, objectionsFor: () => [] });

test("all four time plans and the final AI-output path preserve boxing, not the offered product", () => {
  const input = { offer: "ピラティス", browserContext: boxingContext, counterpartInstagramContext: boxingContext, profileUrl: "https://www.instagram.com/sports_person/" };
  const result = runInNewContext(`${pureServer}\n({plans:['5分','30分','1時間','2時間'].map(duration=>conversationPlanFor(duration,input)), brief:ensureInstagramInsights({instagramInsights:[{title:'ヨガ'}]},input)})`, serverContext(input));
  for (const plan of result.plans) {
    assert.match(plan[0].topic, /ボクシング/);
    assert.ok(plan.some((item) => item.topic === "提案：ピラティス"));
  }
  assert.equal(result.brief.instagramInsights[0].title, "ボクシング");
  assert.match(result.brief.preMeetingVideos[0].query, /ボクシング/);
  assert.match(result.brief.impactPhrases[0], /ボクシング/);
});

test("verified analysis for an unfamiliar topic is not overwritten by the old categories", () => {
  const input = { browserContext: profile("陶芸家。"), resolvedInterests: [{ title: "陶芸", evidence: [{ kind: "profile", quote: "陶芸家" }] }] };
  const result = runInNewContext(`${pureServer}\nensureInstagramInsights({instagramInsights:[{title:'料理・食事'}]},input)`, serverContext(input));
  assert.equal(result.instagramInsights[0].title, "陶芸");
  assert.match(result.preMeetingVideos[0].query, /陶芸/);
});
