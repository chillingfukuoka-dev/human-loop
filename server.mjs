import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createOfferRecommender } from "./lib/offer-recommendation.mjs";
import { offerGuidanceFor } from "./lib/offer-guidance.mjs";
import { analyzeInstagramInterests, createInterestAnalyzer, interestConversation, interestPhrases, interestVideos } from "./lib/instagram-interests.mjs";
import { extractInstagramSources, matchesInstagramPage } from "./lib/instagram-evidence.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const publicDir = join(root, "public");

function loadLocalEnv() {
  const envPath = join(root, ".env.local");
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

loadLocalEnv();

const recommendOffer = createOfferRecommender({
  enabled: (process.env.AI_PROVIDER || "ollama").toLowerCase() === "ollama",
  baseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  model: process.env.OLLAMA_MODEL || "qwen3:4b-instruct"
});

const analyzeInterests = createInterestAnalyzer({
  enabled: (process.env.AI_PROVIDER || "ollama").toLowerCase() === "ollama",
  baseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  model: process.env.OLLAMA_MODEL || "qwen3:4b-instruct"
});

const port = Number(process.env.PORT || 3000);
let instagramInspectionBusy = false;

// 2つのInstagram情報を、見出し単位で厳密に分けて扱う。
// 空行の位置に依存すると、投稿文の改行や読み込み失敗時に別アカウントが混ざるため。
function instagramSectionFor(context, label) {
  const text = String(context || "");
  const marker = `【${label}のInstagram公開情報】`;
  const start = text.indexOf(marker);
  if (start < 0) return "";
  const rest = text.slice(start);
  const next = rest.search(/\n\s*\n【[^】]+のInstagram公開情報】/);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

function instagramContextFor(input, label) {
  const key = label === "あなた" ? "operatorInstagramContext" : "counterpartInstagramContext";
  const dedicated = String(input?.[key] || "").trim();
  if (dedicated) return dedicated;
  return instagramSectionFor(input?.browserContext, label);
}

function conversationPlanFor(duration = "30分", input = {}) {
  const { topic: icebreakerTopic, detail: icebreakerDetail } = interestConversation(instagramInsightsFor(input));
  const inputOffer = String(input.offer || "").trim();
  const guidance = offerGuidanceFor(inputOffer);
  const serviceName = inputOffer || "紹介したいサービス";

  const proposalTopic = serviceName === "紹介したいサービス" ? "提案を1つ" : `提案：${serviceName}`;
  const proposalDetail = guidance?.proposal || (serviceName === "紹介したいサービス"
    ? "聞いた困りごとに合わせて、「ここならお手伝いできます」と紹介する。"
    : `相手の困りごとを聞いてから、「${serviceName}でお手伝いできます」と紹介する。`);
  const plans = {
    "5分": [
      { time: "0〜1分", priority: "最優先", topic: "あいさつ・共通点", detail: "「最近、力を入れていることは何ですか？」と聞く。" },
      { time: "1〜3分", priority: "最優先", topic: "いちばんの困りごと", detail: "「今、いちばん時間がかかることは何ですか？」と聞く。" },
      { time: "3〜4分", priority: "大切", topic: "提案を1つ", detail: "「この部分ならお手伝いできます」と、サービスを1つだけ紹介する。" },
      { time: "4〜5分", priority: "最後に", topic: "次にできること", detail: "「まず何から試すのがよさそうですか？」と相談する。" }
    ],
    "30分": [
      { time: "0〜5分", priority: "最優先", topic: "アイスブレイク・共通点", detail: "「最近、力を入れていることは何ですか？」と聞き、自分の体験をひとこと返す。" },
      { time: "5〜15分", priority: "最優先", topic: "今の困りごと", detail: "「いつ・どんな場面で困りますか？」と、具体的な場面を聞く。" },
      { time: "15〜25分", priority: "できれば", topic: "提案を1つ", detail: "聞いた困りごとに合わせて、「ここならお手伝いできます」と紹介する。" },
      { time: "25〜30分", priority: "最後に", topic: "次にできること", detail: "「まず試すなら、何からがよさそうですか？」と一緒に決める。" }
    ],
    "1時間": [
      { time: "0〜10分", priority: "最優先", topic: "アイスブレイク・共通点", detail: "「最近の投稿で気になったのですが、何がきっかけでしたか？」と聞く。" },
      { time: "10〜30分", priority: "最優先", topic: "今の状況と困りごと", detail: "今のやり方・困る場面・かかる時間を順番に聞く。" },
      { time: "30〜45分", priority: "大切", topic: "提案とサービスの違い", detail: "「今のやり方を残しつつ、ここだけ楽にできます」と提案する。" },
      { time: "45〜55分", priority: "余裕があれば", topic: "質問と迷っていること", detail: "「気になる点や不安はありますか？」と、判断材料を聞く。" },
      { time: "55〜60分", priority: "最後に", topic: "次にできること", detail: "「次回までに試せそうなことは何ですか？」と確認する。" }
    ],
    "2時間": [
      { time: "0〜15分", priority: "最優先", topic: "アイスブレイク・共通点", detail: "「最近、大切にしていることは何ですか？」と聞き、自分の体験も短く話す。" },
      { time: "15〜40分", priority: "最優先", topic: "今の状況", detail: "これまでのやり方・うまくいったこと・続けたいことを聞く。" },
      { time: "40〜65分", priority: "最優先", topic: "困りごとと目指したいこと", detail: "「どうなったらうれしいですか？」と、理想の状態を一緒に整理する。" },
      { time: "65〜95分", priority: "大切", topic: "提案を一緒に考える", detail: "相手の状況に合わせて、サービスの使い方を1つずつ具体化する。" },
      { time: "95〜110分", priority: "余裕があれば", topic: "違いと不安の確認", detail: "「始める前に気になることはありますか？」と、不安を聞く。" },
      { time: "110〜120分", priority: "最後に", topic: "次にできること", detail: "話した内容をまとめ、「次は何を試しますか？」と相談する。" }
    ]
  };
  return (plans[duration] || plans["30分"]).map((item) => {
    if (/アイスブレイク|あいさつ・共通点/.test(item.topic)) return { ...item, topic: icebreakerTopic, detail: icebreakerDetail };
    if (input.productPending && /提案/.test(item.topic)) return { ...item, topic: "大切にしていることを聞く", detail: "「これから、どんなことに力を入れたいですか？」と聞く。紹介するものは急いで決めない。" };
    if (input.productPending && /次にできること/.test(item.topic)) return { ...item, detail: "「また聞いてみたいことはありますか？」と、次につながる話題を相談する。" };
    if (guidance && /困りごと/.test(item.topic)) return { ...item, topic: guidance.topic, detail: `「${guidance.question}」と聞く。` };
    if (/提案/.test(item.topic)) return { ...item, topic: proposalTopic, detail: proposalDetail };
    return item;
  });
}

const listeningGuide = [
  { title: "まずは聞く", detail: "相手が7〜8割話せるように聞く。" },
  { title: "受け止める", detail: "「そうだったんですね」と返す。" },
  { title: "体験談を添える", detail: "自分の体験を短く話し、「あなたはどうですか？」と聞く。" }
];

function interestContextFor(input, label = "話す相手") {
  const dedicated = instagramContextFor(input, label);
  if (dedicated) return dedicated;
  const raw = String(input.browserContext || "");
  return label === "話す相手" && !/【(?:あなた|話す相手)のInstagram公開情報】/.test(raw) ? raw : "";
}

function instagramInsightsFor(input) {
  // API内で検証した興味を、AI成功時も簡易版も共通して使う。
  const interests = Array.isArray(input.resolvedInterests) ? input.resolvedInterests
    : analyzeInstagramInterests(interestContextFor(input), instagramUsername(input.profileUrl));
  return interests.length ? interests.slice(0, 3) : [{
    title: "相手の関心はまだ確認できません",
    detail: "本人のプロフィールや投稿から、関心を確認できませんでした。",
    source: "確認できた根拠がありません", evidence: [],
    check: "最近、いちばん関心があることは何ですか？"
  }];
}

function listeningGuideFor(input) {
  const topics = instagramInsightsFor(input)
    .filter((item) => !/未確認/.test(item.title || ""))
    .map((item) => {
      const title = String(item.title || "").replace(/から$/, "").trim();
      return /^(プロフィール|投稿|ストーリーズ)$/.test(title) ? "" : title;
    })
    .filter(Boolean);
  const fallbackTopics = ["最近力を入れていること", "今困っていること", "これからやりたいこと"];
  const selectedTopics = [...new Set([...topics, ...fallbackTopics])].slice(0, 3);
  return selectedTopics.map((topic) => ({
    title: `${topic}の話`,
    detail: `${topic}のきっかけや今の様子を聞く。返すときは自分の体験をひとこと。`
  }));
}

const commonGroundFrames = [
  "自分も同じような経験がある",
  "相手と同じことで困っている",
  "相手と同じ方向を目指している"
];

function commonGroundFor(input) {
  const operatorSection = interestContextFor(input, "あなた");
  const counterpartSection = interestContextFor(input);
  if (!operatorSection || !counterpartSection) return commonGroundFrames.map((frame) => ({
    frame, detail: "2人分の公開情報がそろうと、共通する話題を探せます。", opener: "最近、力を入れていることは何ですか？"
  }));
  const operator = analyzeInstagramInterests(operatorSection, instagramUsername(input.operatorProfileUrl), { label: "あなた" });
  const counterpart = instagramInsightsFor(input).filter((item) => item.evidence?.length);
  const shared = counterpart.filter((item) => operator.some((own) => own.title === item.title)).map((item) => item.title);
  const movement = /ボクシング|ランニング|ヨガ|ピラティス|サッカー|運動・体づくり|登山・アウトドア/;
  if (!shared.length && operator.some((item) => movement.test(item.title)) && counterpart.some((item) => movement.test(item.title))) shared.push("体を動かすこと");
  if (!shared.length) return commonGroundFrames.map((frame) => ({
    frame, detail: "公開情報だけでは共通点を確認できませんでした。", opener: "最近、大切にしていることは何ですか？"
  }));
  const topics = shared.slice(0, 3).join("・");
  return [
    { frame: commonGroundFrames[0], detail: "共通して話せそうなのは、" + topics + "です。経験が同じかは会話で確かめます。", opener: topics + "を始めたきっかけは何ですか？" },
    { frame: commonGroundFrames[1], detail: "同じ悩みがあるかは、まだわかりません。", opener: topics + "を続ける中で、大変なことはありますか？" },
    { frame: commonGroundFrames[2], detail: "目指していることが近いか、会話で確かめます。", opener: topics + "で、これからやってみたいことは何ですか？" }
  ];
}

function preMeetingVideosFor(input) {
  return interestVideos(instagramInsightsFor(input));
}

function impactPhrasesFor(input) {
  return interestPhrases(instagramInsightsFor(input));
}

function objectionsFor(input) {
  if (input.productPending) return [];
  const guidance = offerGuidanceFor(input.offer);
  if (guidance) return guidance.objections;
  const rawOffer = String(input.offer || "").replace(/\s+/g, " ").trim();
  const offer = rawOffer && !/紹介したいサービス|紹介したい商品/.test(rawOffer)
    ? rawOffer.slice(0, 42)
    : "このサービス";
  const rows = [
    {
      objection: `${offer}は、今のやり方で足りています。`,
      response: `今のやり方は残して、負担が大きい部分だけ${offer}で楽にできるか見てみましょう。`
    },
    {
      objection: `${offer}を使いこなせるか不安です。`,
      response: "最初から全部変えず、まずは一つの場面だけで試して、合うか一緒に確認しましょう。"
    },
    {
      objection: "費用や時間に見合うか分かりません。",
      response: "いきなり決めず、困っている時間や変化を小さく比べてから判断しましょう。"
    }
  ];
  return rows;
}

const demoBrief = {
  meta: { generatedAt: "デモ", source: "入力情報 + Opera Neonメモ" },
  summary: "困りごとを1つ聞き、役立つことを一緒に探す。",
  objective: "困りごとを1つ見つけ、次の一歩を相談する。",
  instagramInsights: [
    { title: "公開情報の見方", detail: "プロフィール・投稿・ストーリーズから話題を整理します。", source: "デモ", check: "実際の関心を会話で確認" }
  ],
  impactPhrases: [
    "投稿を拝見して、人とのつながりを大切にされているのが伝わりました。",
    "日々の活動を、無理なく続ける工夫が素敵ですね。",
    "大切にしていることを、もう少し聞かせていただきたいです。"
  ],
  preMeetingVideos: [
    { title: "相手の興味に近い動画", reason: "デモでは相手の関心を確認する例を表示します。", query: "相手の興味を知る 会話" }
  ],
  commonGround: [
    { frame: "自分も同じような経験がある", detail: "話す前に整理したい気持ちが近そうです。", opener: "私も話す前に整理してから臨みます。" },
    { frame: "相手と同じことで困っている", detail: "準備に時間がかかる悩みが近そうです。", opener: "私たちも準備に時間がかかることがあります。" },
    { frame: "相手と同じ方向を目指している", detail: "準備を楽にし、話す時間を増やしたい方向が近そうです。", opener: "準備を楽にして、話す時間を増やせたらよさそうですね。" }
  ],
  hypotheses: [
    { title: "担当者に負担が集まっているかも", detail: "投稿や対応が、特定の人に頼っているかも。", confidence: "中" },
    { title: "成果までの道筋が見えにくいかも", detail: "活動が会話や受注にどうつながるか、見えにくいかも。", confidence: "中" }
  ],
  proposal: [
    { title: "まずは小さく整理する", detail: "今ある情報から、役立つ型を1つ探す。" },
    { title: "変化を伝える", detail: "機能より、準備や会話がどう楽になるかを話す。" }
  ],
  questions: [
    "今の営業準備で、特に時間がかかっているところはありますか？",
    "そこが少し楽になるとしたら、どんな変化があるとうれしいですか？",
    "理想の会話に近づけるなら、まず何ができるとよさそうですか？",
    "社内で相談するとき、どんな点が判断材料になりそうですか？"
  ],
  competitors: [
    { name: "内製・手作業", comparison: "費用は抑えやすいが、時間と品質に差が出やすい。", angle: "今のやり方を残し、一部だけ楽にする" },
    { name: "汎用AI", comparison: "自由だが、準備の形を整える手間がある。", angle: "会話準備の形が整っている点を伝える" }
  ],
  objections: [
    { objection: "今のやり方でも何とか回っています", response: "今のやり方は残し、負担の大きい部分だけ楽にできるか見てみましょう。" },
    { objection: "AIの回答をそのまま信じるのが不安です", response: "事実と仮説を分け、最後は人が確認する形にしましょう。" },
    { objection: "費用や時間に見合うか分かりません", response: "いきなり決めず、小さく試してから判断しましょう。" }
  ],
  nextSteps: [
    "まずは気になる課題を1つ選ぶ",
    "次回までに今の準備時間をざっくり見ておく",
    "小さなケースで試してみる"
  ],
  news: [
    { title: "気軽に渡せるお菓子", detail: "好みを決めつけず、個包装で持ち帰りやすいものを選ぶ。", source: "会話で好みを確認", opener: "甘いものはお好きですか？" },
    { title: "準備を短くする工夫", detail: "投稿テーマに近いニュースを1本探す。", source: "投稿テーマから探す候補", opener: "準備を短くする記事に興味はありますか？" }
  ],
  listeningGuide,
  conversationPlan: conversationPlanFor("30分")
};

function localBriefFor(input) {
  const person = input.counterpart || input.company || "お相手";
  const offer = input.offer || "紹介したいサービス";
  const duration = input.duration || "30分";
  const guidance = offerGuidanceFor(offer);
  return {
    ...demoBrief,
    meta: { generatedAt: "今", source: input.productPending ? "Instagramの公開情報" : "入力情報 + かんたん版", fallback: !input.productPending },
    instagramInsights: instagramInsightsFor(input),
    impactPhrases: impactPhrasesFor(input),
    preMeetingVideos: preMeetingVideosFor(input),
    commonGround: commonGroundFor(input),
    summary: input.productPending ? "まずは相手の活動や、大切にしていることを聞く。" : `${person}さんの困りごとを聞き、${offer}が役立つか一緒に探す。`,
    objective: input.productPending ? "相手を知ってから、役立てそうなことを考える。" : `困りごとを1つ見つけ、${offer}が合うか相談する。`,
    hypotheses: input.productPending ? [] : demoBrief.hypotheses,
    competitors: input.productPending ? [] : demoBrief.competitors,
    proposal: input.productPending ? [] : [
      { title: "まずは話を聞く", detail: "困りごとを聞き、必要な部分だけ紹介する。" },
      { title: "小さく紹介する", detail: guidance?.proposal || `${offer}から、合いそうな部分を1つ紹介する。` }
    ],
    questions: input.productPending ? ["今、いちばん力を入れていることは何ですか？", "これからやってみたいことはありますか？"] : guidance?.questions || [
      "今、特に時間がかかっていることや困っていることはありますか？",
      "そこが少し楽になるとしたら、どんな変化があるとうれしいですか？",
      `${offer}について、気になることや不安なことはありますか？`
    ],
    objections: objectionsFor(input),
    news: [
      { title: "気軽に渡せるお菓子", detail: "好みを聞き、個包装で持ち帰りやすいものを選ぶ。", source: "会話で好みを確認", opener: "甘いものはお好きですか？" },
      { title: "投稿テーマに近いニュース", detail: "投稿やストーリーズのテーマから、ニュースを1本探す。", source: "Instagramから探す候補", opener: "このテーマのニュースに興味はありますか？" }
    ],
    conversationPlan: conversationPlanFor(duration, input),
    listeningGuide: listeningGuideFor(input)
  };
}

function ensureInstagramInsights(brief, input) {
  return {
    ...brief,
    instagramInsights: instagramInsightsFor(input),
    impactPhrases: impactPhrasesFor(input),
    objections: objectionsFor(input),
    preMeetingVideos: preMeetingVideosFor(input),
    // 共通点はAIに任せず、2つの専用欄を比較して決める。
    commonGround: commonGroundFor(input)
  };
}

function json(res, status, payload) {
  allowLocalApi(res);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("入力が大きすぎます"));
    });
    req.on("end", () => {
      try { resolveBody(body ? JSON.parse(body) : {}); } catch { reject(new Error("JSON形式が正しくありません")); }
    });
    req.on("error", reject);
  });
}

function commandAvailable(command, timeoutMs = 5_000) {
  return new Promise((resolveAvailable) => {
    const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveAvailable(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ available: false, version: "" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", () => finish({ available: false, version: "" }));
    child.on("close", (code) => finish({ available: code === 0, version: output.trim() }));
  });
}

function runOpera(command, args, timeoutMs = 20_000) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); resolveRun({ ok: false, stderr: "Opera Neonの確認がタイムアウトしました" }); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); resolveRun({ ok: false, stderr: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolveRun({ ok: code === 0, stdout, stderr, code }); });
  });
}

function normalizeInstagramUrl(value) {
  return value.startsWith("@") ? `https://www.instagram.com/${value.slice(1)}` : value;
}

function instagramUsername(value) {
  try {
    const url = new URL(normalizeInstagramUrl(value));
    const username = url.pathname.split("/").filter(Boolean)[0] || "";
    if (["p", "reel", "reels", "stories", "explore", "accounts"].includes(username.toLowerCase())) return "";
    return decodeURIComponent(username).toLowerCase();
  } catch {
    return "";
  }
}

function instagramStoriesUrl(value) {
  try {
    const url = new URL(normalizeInstagramUrl(value));
    const username = url.pathname.split("/").filter(Boolean)[0];
    if (!username || ["p", "reel", "reels", "stories", "explore"].includes(username)) return "";
    return `https://www.instagram.com/stories/${username}/`;
  } catch {
    return "";
  }
}

function isInstagramUrl(value) {
  try {
    const url = new URL(normalizeInstagramUrl(value));
    return url.hostname === "instagram.com" || url.hostname === "www.instagram.com";
  } catch {
    return false;
  }
}

function parseCliJson(text) {
  const raw = text.trim();
  if (!raw) return null;
  const parseValue = (value) => {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "string") return parseValue(parsed);
      if (parsed && typeof parsed.message === "string") {
        const fenced = parsed.message.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (fenced) return parseValue(fenced[1]);
      }
      return parsed;
    } catch {
      return null;
    }
  };
  const direct = parseValue(raw);
  if (direct && typeof direct === "object" && !("message" in direct)) return direct;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    const parsed = parseValue(fenced[1]);
    if (parsed) return parsed;
  }
  try {
    const parsed = parseValue(raw);
    if (parsed) return parsed;
  } catch {
    const lines = raw.split(/\r?\n/).reverse();
    for (const line of lines) {
      const parsed = parseValue(line);
      if (parsed) return parsed;
    }
  }
  return null;
}

const instagramPageCaptureScript = `async () => {
  // 公開プロフィールの「続きを読む」だけを開く。登録・ログインは操作しない。
  if (location.pathname.split("/").filter(Boolean).length === 1) {
    const more = Array.from(document.querySelectorAll('main button, main [role="button"]'))
      .find((button) => (button.innerText || "").trim() === "続きを読む");
    if (more) {
      more.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  const absoluteUrl = (href) => {
    try {
      const url = new URL(href, location.href);
      if (url.hostname !== "instagram.com" && url.hostname !== "www.instagram.com") return "";
      return url.href;
    } catch { return ""; }
  };
  const links = Array.from(document.querySelectorAll("main a[href]"))
    .map((anchor) => ({
      href: absoluteUrl(anchor.getAttribute("href")),
      label: (anchor.getAttribute("aria-label") || anchor.innerText || "").trim().replace(/\\s+/g, " ")
    }))
    .filter((item) => item.href);
  const unique = (items) => Array.from(new Map(items.map((item) => [item.href, item])).values());
  const posts = unique(links.filter((item) => /\\/(p|reel)\\//.test(item.href))).slice(0, 6);
  const stories = unique(links.filter((item) => /\\/stories\\//.test(item.href))).slice(0, 6);
  const storyLabels = Array.from(document.querySelectorAll("[aria-label], button"))
    .map((element) => (element.getAttribute("aria-label") || element.innerText || "").trim().replace(/\\s+/g, " "))
    .filter((label) => /story|ストーリ/i.test(label))
    .filter((label) => !/プロフィール写真|profile picture|ユーザーのアバター|Meta AI/i.test(label))
    .slice(0, 8);
  const media = Array.from(document.querySelectorAll("img[alt], video[aria-label]"))
    .map((element) => (element.getAttribute("alt") || element.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " "))
    // Instagram also exposes the logged-in viewer's profile image and UI
    // labels here. They are not interests of the account being inspected.
    .filter((label) => !/プロフィール写真|profile picture|ストーリーズ写真のハイライト|story highlight|ユーザーのアバター|Meta AI/i.test(label))
    .filter(Boolean)
    .slice(0, 12);
  const pageText = (document.querySelector("main")?.innerText || document.body?.innerText || "")
    .replace(/\\s+/g, " ").trim().slice(0, 2200);
  return {
    url: location.href,
    title: document.title,
    // サイドバー・フッター（Meta AI）や操作者のプロフィールは対象外にする。
    text: pageText,
    posts,
    stories,
    storyLabels,
    media
  };
}`;

async function captureInstagramPage(pageUrl) {
  // evaluate_script reads the currently selected page. Keep the inspected page
  // in the foreground so the profile and its posts cannot be mixed up with the
  // app page or the other Instagram account.
  const opened = await runOpera("opera-browser-cli", ["new_page", pageUrl, "--output-format", "json"], 30_000);
  if (!opened.ok) return { ok: false, error: opened.stderr || "InstagramをOpera Neonで開けませんでした" };
  const openedData = parseCliJson(opened.stdout);
  const openedPage = openedData?.pages?.find((page) => page.selected);
  if (!openedPage || !matchesInstagramPage(pageUrl, openedPage.url)) return { ok: false, error: "確認する画面が切り替わりました。操作を止めて、もう一度お試しください。" };
  const pageId = openedPage?.id;
  try {
    if (pageId !== undefined && pageId !== null) {
      const selected = await runOpera("opera-browser-cli", ["select_page", String(pageId)], 10_000);
      if (!selected.ok) return { ok: false, error: selected.stderr || "Opera Neonで確認するページを選べませんでした" };
    }
    const captured = await runOpera("opera-browser-cli", ["evaluate_script", instagramPageCaptureScript, "--output-format", "json", "--waitForStableDom", "true"], 20_000);
    if (!captured.ok) return { ok: false, error: captured.stderr || "Instagramの公開情報を読み取れませんでした" };
    const data = parseCliJson(captured.stdout);
    if (!data || !matchesInstagramPage(pageUrl, data.url)) return { ok: false, error: "確認する画面が切り替わったため、この読み取りは使いません。もう一度お試しください。" };
    return { ok: true, data };
  } finally {
    if (pageId !== undefined && pageId !== null) {
      await runOpera("opera-browser-cli", ["close_page", String(pageId)], 10_000);
    }
  }
}

async function collectInstagramInfo(profileUrl) {
  const profile = await captureInstagramPage(profileUrl);
  if (!profile.ok) return profile;
  const profileData = profile.data;
  const requestedUsername = instagramUsername(profileUrl);
  const loadedUsername = instagramUsername(profileData.url);
  if (!requestedUsername || loadedUsername !== requestedUsername) {
    return {
      ok: false,
      error: `読み取ったInstagramが一致しませんでした（指定: @${requestedUsername || "不明"} / 読み取り: @${loadedUsername || "不明"}）。もう一度お試しください。`
    };
  }
  const posts = [];
  const stories = [];
  const ownedPosts = (profileData.posts || []).filter((item) => {
    try { return new URL(item.href).pathname.split("/").filter(Boolean)[0]?.toLowerCase() === requestedUsername; }
    catch { return false; }
  });
  for (const item of ownedPosts.slice(0, 3)) {
    const page = await captureInstagramPage(item.href);
    if (page.ok) posts.push({ url: item.href, data: page.data });
  }
  const storyLinks = [...(profileData.stories || [])];
  if (!storyLinks.length) {
    const fallbackStoryUrl = instagramStoriesUrl(profileUrl);
    if (fallbackStoryUrl) storyLinks.push({ href: fallbackStoryUrl, label: "公開ストーリーズ" });
  }
  for (const item of storyLinks.slice(0, 3)) {
    const page = await captureInstagramPage(item.href);
    if (page.ok) stories.push({ url: item.href, data: page.data });
  }
  return { ok: true, profile: profileData, posts, stories };
}

function formatInstagramInfo(label, info) {
  const lines = [`【${label}のInstagram公開情報】`, "プロフィール・公開投稿・公開ストーリーズを確認しました。"];
  const profile = info.profile;
  if (profile?.text) lines.push(`プロフィール画面：${profile.text}`);
  if (profile?.media?.length) lines.push(`プロフィール上の画像説明：${profile.media.join(" / ")}`);
  if (info.posts.length) {
    lines.push("公開投稿：");
    info.posts.forEach((post, index) => {
      const text = post.data.text || "本文は確認できませんでした。";
      lines.push(`${index + 1}. ${text.slice(0, 1400)}`);
    });
  } else {
    lines.push("公開投稿：ページ上で取得できる投稿はありませんでした。");
  }
  if (info.stories.length) {
    lines.push("公開ストーリーズ：");
    info.stories.forEach((story, index) => {
      const text = story.data.text || "本文は確認できませんでした。";
      lines.push(`${index + 1}. ${text.slice(0, 1400)}`);
    });
  } else if (profile?.storyLabels?.length) {
    lines.push(`公開ストーリーズの表示：${profile.storyLabels.join(" / ")}`);
  } else {
    lines.push("公開ストーリーズ：表示が確認できませんでした。ログインが必要な情報や非公開情報は対象にしません。");
  }
  return lines.join("\n");
}

function extractJson(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  const candidate = fenced?.[1] || text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) throw new Error("AIの出力をJSONとして解釈できませんでした");
  return JSON.parse(candidate);
}

async function buildBrief(input) {
  const prompt = `あなたは営業の会話準備コーチです。以下の情報だけを使い、事実と仮説を明確に分けて、日本語で準備ノートを作ってください。Instagramのプロフィール・投稿・ストーリーズは本人の発言ではなく公開情報なので、断定せず「公開情報から読み取れる可能性」として扱ってください。

文章の雰囲気は、かしこまりすぎない、やわらかく自然な日本語にしてください。人と話す前に読んで、そのまま会話に使える言い方を優先してください。中学生でも意味がわかるくらい、簡単な言葉を選んでください。難しい専門用語、業界用語、英語やカタカナ語はできるだけ使わないでください。たとえば「KPI」は「目標の数字」、「リード」は「見込みのあるお客さま」、「コンバージョン」は「問い合わせや申し込み」のように言い換えてください。どうしても専門用語が必要なときは、必ずすぐ後ろに短い説明を添えてください。官公庁の報告書のような硬い表現、過度な敬語、断定的・上から目線の言い方も避けてください。「〜かもしれません」「まずは〜を伺ってみましょう」「もし近ければ〜」のように、相手に寄り添う表現を使ってください。質問は尋問のようにせず、自然な会話として聞ける形にしてください。反論への返しも、説得するより相手の事情を受け止めて一緒に確認するトーンにしてください。会話は基本的に傾聴に徹し、相手が7〜8割話せるようにしてください。返答は「相手の話を受け止める → 自分の実体験を短く添える → もう一度相手に聞く」の順にしてください。入力に自分の体験がない場合は、AIが体験談を作らず、「ここに自分の体験をひとこと添える」とわかる形で提案してください。仮説のタイトルも短く、やさしい言葉にしてください。

出力はJSONのみ。\n\n必須キー: meta, summary, objective, commonGround, hypotheses, proposal, questions, competitors, objections, nextSteps, conversationPlan, news, listeningGuide\ncommonGroundは、会話の中で見つけたい共通点を、次の3つの要素で整理してください。順番とframeは必ず「自分も同じような経験がある」「相手と同じことで困っている」「相手と同じ方向を目指している」にしてください。入力に根拠がないことは断定せず、「近そう」「会話の中で確かめたい」と書いてください。各項目には会話を始める一言をopenerとして入れてください。\nお話しする時間は${input.duration || "30分"}です。この時間に合わせて、話す順番と優先度を時間軸で決めてください。短い時間なら、アイスブレイク・困りごと・提案1つ・次の一歩を優先し、長い時間なら相手の状況や不安を丁寧に聞く時間を増やしてください。conversationPlanでは、各項目に時間帯・priority（最優先／大切／できれば／余裕があれば／最後に）・topic・detailを入れてください。\n相手が気になりそうなニュースの候補を、Instagramの公開プロフィール・投稿・ストーリーズに出てきたテーマから1〜3件作ってください。入力のbrowserContextに具体的なニュースの事実がない場合は、ニュース名・日付・数字を作らず、「調べるとよさそうなニュースの切り口」として書いてください。各項目にtitle・detail・source・openerを入れ、sourceには「投稿テーマから探す候補」など、根拠の種類を書いてください。\nlisteningGuideには、傾聴→受け止める→実体験を短く添える→もう一度聞く、という返答の型を3項目で入れてください。体験談は入力に根拠がある場合だけ具体化し、根拠がなければ作らないでください。\n形式:\n{\n  "meta": {"generatedAt":"", "source":""},\n  "summary":"", "objective":"",\n  "commonGround":[{"frame":"自分も同じような経験がある|相手と同じことで困っている|相手と同じ方向を目指している","detail":"","opener":""}],\n  "hypotheses":[{"title":"","detail":"","confidence":"高|中|低"}],\n  "proposal":[{"title":"","detail":""}],\n  "questions":[""],\n  "competitors":[{"name":"","comparison":"","angle":""}],\n  "objections":[{"objection":"","response":""}],\n  "nextSteps":[""],\n  "conversationPlan":[{"time":"0〜5分","priority":"最優先|大切|できれば|余裕があれば|最後に","topic":"","detail":""}],\n  "news":[{"title":"","detail":"","source":"","opener":""}],\n  "listeningGuide":[{"title":"","detail":""}]\n}\n\n入力:\n${JSON.stringify(input, null, 2)}`;
  const commonGroundRule = "補足：入力のbrowserContextに「あなたのInstagram公開情報」と「話す相手のInstagram公開情報」が含まれている場合は、1つ目の「自分も同じような経験がある」で、両方から読み取れる共通点の候補を優先してください。ただし、プロフィール・投稿・ストーリーズだけでは経験を断定できないため、「公開情報では〜が近そう」「実際に経験したか会話で確かめたい」と書いてください。片方しか情報がない場合や根拠が弱い場合は、無理に共通点を作らず、会話で確かめる質問につなげてください。";
  const promptWithCommonGroundRule = prompt.replace("\n\n入力:", `\n\n${commonGroundRule}\n\n入力:`);
  const giftInstruction = "補足：newsには、相手が気になりそうなニュースだけでなく、気軽に渡せるお菓子の候補も入れてください。お菓子は相手の好みを断定せず、個包装・持ち帰りやすさなど、会話で確認しやすい選び方として書いてください。各項目のtitle・detail・source・openerは必ず入れてください。";
  const promptWithGiftRule = `${promptWithCommonGroundRule}\n\n${giftInstruction}`;
  const compactInstruction = "補足：文章は短く、1項目1〜2文までにしてください。1文はできれば40文字以内にし、結論を先に書いてください。同じ意味の言い換えは省き、難しい言葉は使わず、話すときにそのまま使える一言にしてください。hypotheses・proposal・competitors・objections・newsのdetailは短く、questionsは3〜4個、nextStepsは3個以内にしてください。";
  const instagramInstruction = "重要：Instagram情報は専用欄で分けています。counterpartInstagramContext（話す相手）だけをinstagramInsights・impactPhrases・listeningGuide・動画・ニュースの根拠に使い、operatorInstagramContext（あなた）はそこに絶対に混ぜないでください。あなたと相手の両方を比べるのはcommonGroundだけです。相手のプロフィール・公開投稿・公開ストーリーズから読み取れる関心を、似た内容ごとにまとめて3つ程度の短い箇条書きにしてください。細かな投稿文、日付、服装、画面の案内文などはそのまま並べないでください。各項目はtitle・detail・source・checkを持たせ、どの情報からわかったかを短く書いてください。listeningGuideでは、相手が話しそうな内容を3つ想定し、それぞれに『まず聞くこと』と『返すときは自分の体験をひとこと』を入れてください。これを根拠に、相手の情報整理、困りごとの仮説、刺さりそうな提案、質問、競合との比較、反論への返し、ニュース、3つの共通点を作ってください。共通点だけは、あなたと相手の両方の情報を比べ、根拠が弱ければ断定せず会話で確かめる形にしてください。専用欄とbrowserContextが空なら、Instagramからわかったふりをせず未確認と書いてください。出力JSONには必ずinstagramInsightsを含めてください。";
  const impactPhraseInstruction = "重要：impactPhrasesには、話す相手のInstagram公開プロフィール・投稿・ストーリーズを根拠に、会話の入口で使えるやわらかい言葉を3つだけ入れてください。相手を決めつける営業文句ではなく、『〜が伝わりました』『〜が素敵ですね』『〜を聞いてみたいです』のように自然に書いてください。あなたのInstagram、画面のサイドバー、Meta AI、ユーザー名は使わないでください。";
  const objectionInstruction = "重要：objectionsは、入力されたoffer（紹介したいサービス・商品）に対して相手が言いそうな反論を3つ作り、それぞれにobjectionとresponseを入れてください。responseは反論を否定せず、相手の不安を受け止めてから、小さく試せる提案につなげてください。offerがAIなら、最後は人が確認することも含めてください。";
  const promptWithCompactRule = `${promptWithGiftRule}\n\n${instagramInstruction}\n\n${impactPhraseInstruction}\n\n${objectionInstruction}\n\n${compactInstruction}`;
  const promptInput = {
    ...input,
    browserContext: "", // 同じ情報を重複させず、自動画像説明やコメントも渡さない。
    operatorInstagramContext: extractInstagramSources(interestContextFor(input, "あなた"), { username: instagramUsername(input.operatorProfileUrl), label: "あなた" }).map((source) => source.text).join("\n").slice(0, 650),
    counterpartInstagramContext: extractInstagramSources(interestContextFor(input), { username: instagramUsername(input.profileUrl) }).map((source) => source.text).join("\n").slice(0, 1300),
    resolvedInterests: instagramInsightsFor(input).map(({ title, detail }) => ({ title, detail }))
  };
  const compactPrompt = promptWithCompactRule.replace(JSON.stringify(input, null, 2), JSON.stringify(promptInput, null, 2));
  const provider = (process.env.AI_PROVIDER || "ollama").toLowerCase();

  if (provider === "ollama") {
    const baseUrl = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
    const model = process.env.OLLAMA_MODEL || "qwen3:4b-instruct";
    let response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: compactPrompt }],
          stream: false,
          format: "json",
          think: false,
          options: { temperature: 0.2, num_predict: 2200 }
        }),
        signal: controller.signal
      });
    } catch (error) {
      if (error.name === "AbortError") throw new Error("Ollamaの返答に時間がかかっています。少し短い入力で、もう一度試してください。");
      throw new Error("Ollamaが起動していません。ollama serveを実行し、モデルをollama pullしてください。");
    } finally {
      clearTimeout(timeout);
    }
    const body = await response.text();
    if (!response.ok) {
      let detail = body;
      try { detail = JSON.parse(body).error || body; } catch { /* keep raw text */ }
      throw new Error(`Ollamaの応答エラー: ${detail}`);
    }
    let payload;
    try { payload = JSON.parse(body); } catch { throw new Error("Ollamaの応答を読み取れませんでした"); }
    return { ...ensureInstagramInsights(extractJson(payload.message?.content || ""), input), conversationPlan: conversationPlanFor(input.duration, input), listeningGuide: listeningGuideFor(input) };
  }

  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEYが未設定です。.env.localに設定してください。");
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-6-astra";
    const response = await client.responses.create({ model, input: compactPrompt });
    return { ...ensureInstagramInsights(extractJson(response.output_text), input), conversationPlan: conversationPlanFor(input.duration, input), listeningGuide: listeningGuideFor(input) };
  }

  throw new Error(`未対応のAI_PROVIDERです: ${provider}（ollama または openai を指定してください）`);
}

function contentType(path) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" })[extname(path)] || "text/plain; charset=utf-8";
}

function allowLocalApi(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

async function prepareNote(rawInput) {
  const automatic = rawInput.offer === "auto";
  const recommendation = await recommendOffer(instagramContextFor(rawInput, "話す相手"), instagramUsername(rawInput.profileUrl));
  const resolvedInterests = await analyzeInterests(interestContextFor(rawInput), instagramUsername(rawInput.profileUrl));
  // 商品を選べなくても、確認できた興味・会話の入口は返す。
  // クライアントから送られた判定結果ではなく、ここで検証した結果だけを使う。
  const productPending = automatic && !recommendation.offer;
  const input = { ...rawInput, resolvedInterests, productPending, offer: automatic ? recommendation.offer || "" : rawInput.offer };
  let brief;
  if (productPending) {
    brief = localBriefFor(input);
  } else {
    try {
      brief = await buildBrief(input);
    } catch (error) {
      console.error(error.message);
      brief = localBriefFor(input);
    }
  }
  return { ...brief, productPending, selectedOffer: input.offer || null, offerRecommendation: { ...recommendation, applied: automatic && Boolean(recommendation.offer) } };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") {
    allowLocalApi(res);
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/api/opera-status") {
    const cli = await commandAvailable("opera-browser-cli");
    if (!cli.available) return json(res, 200, { available: false, cliAvailable: false });
    const doctor = await runOpera("opera-browser-cli", ["doctor"], 8_000);
    const status = await runOpera("opera-browser-cli", ["status"], 8_000);
    const diagnostics = `${doctor.stdout}\n${doctor.stderr}\n${status.stdout}\n${status.stderr}`;
    const daemonReady = status.ok && /daemon is running/i.test(`${status.stdout}\n${status.stderr}`) && !/not running/i.test(`${status.stdout}\n${status.stderr}`);
    const cliNeedsMigration = /compatibility launcher/i.test(cli.version);
    const browserReady = daemonReady && !cliNeedsMigration && !/executable:\s+warn|Opera Neon not found|not running|Timeout: daemon not ready|タイムアウト/i.test(diagnostics);
    return json(res, 200, { available: browserReady, cliAvailable: true, browserReady, version: cli.version, message: browserReady ? "Opera Neon接続済み" : "Opera Neonに接続できていません" });
  }
  if (req.method === "GET" && url.pathname === "/api/demo") return json(res, 200, demoBrief);
  if (req.method === "POST" && url.pathname === "/api/prepare") {
    try {
      const rawInput = await readBody(req);
      return json(res, 200, await prepareNote(rawInput));
    } catch (error) {
      console.error(error.message);
      return json(res, 500, { error: error.message || "準備ブリーフの生成に失敗しました" });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/inspect-instagram") {
    if (instagramInspectionBusy) return json(res, 409, { error: "いま別のInstagramを確認しています。少し待ってからお試しください。" });
    instagramInspectionBusy = true;
    try {
      const input = await readBody(req);
      const profiles = [
        { label: "あなた", value: input.operatorProfileUrl || "" },
        { label: "話す相手", value: input.profileUrl || "" }
      ].filter((profile) => profile.value);
      if (!profiles.length) return json(res, 400, { error: "あなたか、話す相手のInstagramのURLを入力してください" });
      const invalid = profiles.find((profile) => !isInstagramUrl(profile.value));
      if (invalid) return json(res, 400, { error: `${invalid.label}のInstagramの公開プロフィールURLを確認してください` });
      const available = await commandAvailable("opera-browser-cli");
      if (!available.available) return json(res, 503, { error: "Opera Neon CLIが見つかりません。READMEのセットアップ手順を実行してください。", setup: "npm install -g opera-browser-cli && opera-browser-cli setup" });

      const contexts = [];
      for (const profile of profiles) {
        const inspected = await collectInstagramInfo(normalizeInstagramUrl(profile.value));
        if (!inspected.ok) return json(res, 502, { error: inspected.error || `${profile.label}のInstagramをOpera Neonで確認できませんでした` });
        contexts.push(formatInstagramInfo(profile.label, inspected));
      }
      const contextByLabel = Object.fromEntries(profiles.map((profile, index) => [profile.label, contexts[index] || ""]));
      const resolvedInterests = await analyzeInterests(contextByLabel["話す相手"] || "", instagramUsername(input.profileUrl));
      return json(res, 200, {
        ok: true,
        compared: profiles.length === 2,
        profiles: profiles.map((profile) => ({ label: profile.label, username: instagramUsername(profile.value) })),
        context: contexts.join("\n\n"),
        operatorInstagramContext: contextByLabel["あなた"] || "",
        counterpartInstagramContext: contextByLabel["話す相手"] || "",
        instagramInsights: resolvedInterests,
        offerRecommendation: await recommendOffer(contextByLabel["話す相手"] || "", instagramUsername(input.profileUrl)),
        source: profiles.length === 2 ? "Opera Neon（2つの公開プロフィール）" : "Opera Neon"
      });
    } catch (error) {
      return json(res, 500, { error: error.message });
    } finally {
      instagramInspectionBusy = false;
    }
  }
  if (req.method !== "GET") return json(res, 405, { error: "Method Not Allowed" });

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = normalize(join(publicDir, pathname));
  if (!filePath.startsWith(publicDir) || !existsSync(filePath) || !statSync(filePath).isFile()) return json(res, 404, { error: "Not Found" });
  res.writeHead(200, { "content-type": contentType(filePath) });
  res.end(readFileSync(filePath));
}

createServer((req, res) => { handle(req, res).catch((error) => json(res, 500, { error: error.message })); }).listen(port, () => {
  console.log(`Sales Prep AI: http://localhost:${port}`);
});

