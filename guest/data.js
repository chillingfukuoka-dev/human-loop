// All people, profile descriptions and results below are fictional examples.
// No Instagram requests, inference, owner URLs or credentials belong here.
export const GUEST_CODE = "HUMANLOOP";
export const samples = {
  yoga: {
    name: "はるかさん", role: "ヨガ講師（架空の人物）", bio: "呼吸を大切にするヨガ講師。体を整えること、無理なく運動を続けることに関心がある、という設定です。",
    interests: ["ヨガ", "呼吸と体のケア", "無理なく続ける運動"],
    common: ["体を整えたい", "運動を長く続けたい"],
    phrases: ["無理なく続けられる形がいいですよね。", "体の変化に気づけると、うれしいですね。", "呼吸で大切にしていることは何ですか？"],
    opener: "ヨガを続ける中で、大切にしていることは何ですか？",
    offer: "ピラティス", reason: "体を整えることに関心がある設定なので、姿勢や体の使い方から紹介する例です。"
  },
  cooking: {
    name: "そうたさん", role: "料理教室の先生（架空の人物）", bio: "季節の料理を教える先生。毎日の献立を工夫しながら、教室の告知や予約管理にも時間を使っている、という設定です。",
    interests: ["料理・献立づくり", "季節の食材", "料理教室の運営"],
    common: ["毎日の小さな工夫が好き", "仕事の準備を少し楽にしたい"],
    phrases: ["料理に向き合う時間を、もっと大切にしたいですね。", "最近、気に入っている食材はありますか？", "教室の準備で、時間がかかることは何ですか？"],
    opener: "最近、生徒さんに喜ばれた料理はありますか？",
    offer: "AI", reason: "料理への関心とは別に、告知文や予約の準備に時間がかかる設定なので、仕事を手伝う使い方を紹介する例です。"
  },
  boxing: {
    name: "あおいさん", role: "ボクサー（架空の人物）", bio: "ボクシングの練習に打ち込む人。動きの安定や、練習後の体のケアを大切にしている、という設定です。",
    interests: ["ボクシング", "体の使い方・練習", "練習後の体のケア"],
    common: ["運動を習慣にしている", "体の使い方を良くしたい"],
    phrases: ["練習で、今いちばん意識していることは何ですか？", "続けてきた積み重ねって、大きいですよね。", "練習後は、どんなケアをしていますか？"],
    opener: "ボクシングを始めたきっかけは何ですか？",
    offer: "ピラティス", reason: "中心の興味はボクシングのまま、体の安定や動きの練習を補う候補として紹介する例です。"
  }
};
const offers = {
  "ランニング": { proposal: "「気分転換に、短い距離から一緒に走ってみませんか？」", question: "日頃、気分転換にしていることはありますか？", objections: [["走るのは苦手です。", "そうですよね。無理に走らず、歩くところからでも大丈夫です。"], ["時間がありません。", "まずは5分くらいから、できそうな日だけでもどうでしょう？"]] },
  "ピラティス": { proposal: "「姿勢や体の使い方を、短い体験で確かめてみませんか？」", question: "体の動きで、気になっていることはありますか？", objections: [["体が硬くてもできますか？", "気になりますよね。無理のない動きから、先生に相談してみましょう。"], ["今の運動と何が違いますか？", "今の運動を大切にしながら、姿勢や動きの確認に使えるかを見てみましょう。"]] },
  "AI": { proposal: "「まずは、よく書く文章ひとつだけ、一緒に下書きしてみませんか？」", question: "いつもの準備で、時間がかかることは何ですか？", objections: [["難しそうです。", "最初は、いつも書く短い文章ひとつだけで試してみましょう。"], ["自分らしい文章になりますか？", "下書きだけ手伝ってもらい、最後はご自身の言葉に直す形がよさそうです。"]] }
};
const durations = { "5分": [1, 3, 4, 5], "30分": [5, 15, 25, 30], "1時間": [10, 35, 50, 60], "2時間": [15, 65, 100, 120] };

export function makeDemoNote({ personId, duration = "30分", offer = "auto", customOffer = "" }) {
  const person = samples[personId];
  if (!person || !durations[duration] || !["auto", "ランニング", "ピラティス", "AI", "その他"].includes(offer)) throw new Error("サンプルと時間を選んでください。");
  const selectedOffer = offer === "auto" ? person.offer : offer === "その他" ? String(customOffer).trim().slice(0, 60) : offer;
  if (!selectedOffer) throw new Error("紹介したい内容を入力してください。");
  const guidance = offers[selectedOffer] || { proposal: `「${selectedOffer}が、どんな場面で役立ちそうか一緒に考えてみませんか？」`, question: "今、少し楽にしたいことはありますか？", objections: [["今すぐは決められません。", "もちろんです。気になる点を聞いて、必要になったときに考えましょう。"], ["自分に合うか分かりません。", "どんなことを大切にしたいか、まず聞かせてください。"]] };
  let from = 0;
  const steps = [
    ["アイスブレイク", person.opener],
    ["相手の話を聞く", guidance.question],
    [`${selectedOffer}をひとつ紹介`, guidance.proposal],
    ["次の一歩を相談", "まず試すなら、どんな形がよさそうですか？"]
  ];
  const timeline = durations[duration].map((to, index) => { const item = { time: `${from}〜${to}分`, title: steps[index][0], detail: steps[index][1] }; from = to; return item; });
  return { person, duration, selectedOffer, reason: offer === "auto" ? person.reason : "手動で選んだ内容を使うサンプルです。相手に本当に合うかは、会話で確かめます。", proposal: guidance.proposal, timeline, objections: guidance.objections, sample: true };
}
