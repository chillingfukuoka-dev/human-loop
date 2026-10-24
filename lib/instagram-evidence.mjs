const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function matchesInstagramPage(expectedUrl, actualUrl) {
  try {
    const expected = new URL(expectedUrl);
    const actual = new URL(actualUrl);
    if (![expected, actual].every((url) => ["instagram.com", "www.instagram.com"].includes(url.hostname))) return false;
    const parts = (url) => url.pathname.split("/").filter(Boolean);
    const a = parts(expected), b = parts(actual);
    const postId = (url) => url.pathname.match(/\/(?:p|reel)\/([^/]+)/)?.[1];
    const id = postId(expected);
    if (id) return postId(actual) === id;
    if (a[0] === "stories" && a.length === 2 && a[1] !== "highlights") return b[0] === "stories" && b[1]?.toLowerCase() === a[1].toLowerCase();
    return a.length === b.length && a.every((part, index) => index === 0 ? part.toLowerCase() === b[index].toLowerCase() : part === b[index]);
  } catch { return false; }
}

export function cleanInstagramText(value, usernames = []) {
  let text = String(value || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/@[a-z0-9._]+/gi, " ")
    .replace(/\b[a-z0-9]+_+[a-z0-9_]+\b/gi, " ")
    .replace(/Meta\s*AI|AIコンテンツ|AI情報|AI\s+info|Made\s+with\s+AI/gi, " ")
    .replace(/編集済み\s*•?/g, " ")
    .replace(/(?:フォロワー|フォロー中)\s*[\d.,万億]+\s*人?/g, " ")
    .replace(/\d+\s*(?:秒|分|時間|日|週間|週|か月|ヶ月|年)前/g, " ");
  for (const username of usernames.filter(Boolean)) text = text.replace(new RegExp(`\\b${escapeRegExp(username)}\\b`, "gi"), " ");
  return normalize(text);
}

function ownerText(value, username, kind) {
  let text = normalize(value);
  if (/本文は確認できません|取得できる投稿はありません|表示が確認できません|投稿ページを確認しました|ストーリーズを確認しました/.test(text)) return "";
  if (/ハイライトをもっと見|ログインして.*ストーリーズ|このプロフィールは非公開|このストーリーズは利用できません/.test(text)) return "";
  // 画面の案内・フッターを、本人の発信と混ぜない。
  text = text.replace(/^.*?次に進むことで、Instagramの利用規約.*?同意するものとします。\s*登録する\s*ログイン\s*/u, "");
  if (kind !== "profile") {
    const comments = /\s([a-z0-9._]{2,30})\s+(?:編集済み\s*•?\s*)?\d+\s*(?:秒|分|時間|日|週間|週|か月|ヶ月|年)前(?=\s|$)/gi;
    for (const match of text.matchAll(comments)) {
      if (!username || match[1].toLowerCase() !== username.toLowerCase()) {
        text = text.slice(0, match.index);
        break;
      }
    }
  }
  text = text.split(/コメントはまだありません|他のコメントを見る|コメントを追加|ログインすると|の他の投稿|Meta 基本データ|Instagram Lite/)[0];
  // 「Photo by … 画像のようです」は本文でなく、自動画像説明。
  if (/^(?:Photo|Video) by\b/i.test(text) && /画像のようです|May be an image of/i.test(text)) return "";
  return text;
}

// roleごとに独立させ、プロフィール本文・投稿本文・読めたストーリーズだけを返す。
export function extractInstagramSources(context, { username = "", label = "話す相手" } = {}) {
  let text = String(context || "");
  if (/【(?:あなた|話す相手)のInstagram公開情報】/.test(text)) {
    const marker = `【${label}のInstagram公開情報】`;
    if (!text.includes(marker)) return [];
    text = text.slice(text.indexOf(marker) + marker.length).split(/【[^】]+のInstagram公開情報】/)[0];
  }
  const sources = [];
  let kind = "";
  const append = (value, type) => {
    const cleaned = cleanInstagramText(ownerText(value, username, type), [username]);
    if (!cleaned) return;
    const source = { profile: "公開プロフィール", post: "公開投稿", story: "公開ストーリーズ" }[type] || "相手の公開情報";
    sources.push({ id: String(sources.length + 1), kind: type, source, text: cleaned, weight: type === "profile" ? 3 : 1 });
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^公開投稿[：:]/.test(line)) { kind = "post"; continue; }
    if (/^公開ストーリーズ[：:]/.test(line)) { kind = "story"; continue; }
    if (/^(?:プロフィール上の画像説明|公開ストーリーズの表示|画像の自動説明)[：:]/.test(line)) continue;
    if (/^(?:プロフィール画面|公開プロフィールで確認できた範囲)[：:]/.test(line)) {
      append(line.replace(/^[^：:]+[：:]\s*/, ""), "profile");
    } else if (kind && /^\d+[.)]\s*/.test(line)) {
      append(line.replace(/^\d+[.)]\s*/, ""), kind);
    }
  }
  if (!sources.length && !/プロフィール画面|公開投稿|公開ストーリーズ|画像説明|【[^】]+】/.test(text)) append(text, "note");
  return sources;
}

export function positiveKeyword(text, keyword) {
  const escaped = escapeRegExp(keyword);
  const expression = /^[a-z ]+$/i.test(keyword)
    ? new RegExp(`(^|[^a-z])(${escaped})(?=$|[^a-z])`, "gi")
    : new RegExp(`(${escaped})`, "gi");
  for (const match of text.matchAll(expression)) {
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 24);
    const before = text.slice(Math.max(0, match.index - 16), match.index);
    if (/^(?:に(?:は)?|は|が|を)?(?:興味がない|興味はない|関心がない|苦手|嫌い|しない|やらない|使わない|使っていない|未確認)/.test(after)) continue;
    if (/興味がない|関心がない|確認できない|\b(?:not|never|no)\s*$/i.test(before)) continue;
    return true;
  }
  return false;
}
