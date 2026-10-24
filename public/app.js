const form = document.querySelector("#prepForm");
const notice = document.querySelector("#notice");
const results = document.querySelector("#results");
const workspace = document.querySelector(".workspace");
const operaStatus = document.querySelector("#operaStatus");
const API_BASE = window.location.protocol === "file:" ? "http://localhost:3000" : "";
const apiUrl = (path) => `${API_BASE}${path}`;
async function fetchWithTimeout(path, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(apiUrl(path), { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[char]));
const setNotice = (message = "", tone = "error") => { notice.textContent = message; notice.dataset.tone = tone; };
const instagramStorageKey = "meet-ready-instagram-urls";
let latestOfferRecommendation = null;

function renderOfferRecommendation() {
  document.querySelector("#offerRecommendation").hidden = form.elements.offer.value !== "auto";
  document.querySelector("#offerRecommendationTitle").textContent = latestOfferRecommendation?.offer
    ? `${latestOfferRecommendation.basis === "inferred" ? "おすすめ候補" : "おすすめ"}：${latestOfferRecommendation.offer}`
    : latestOfferRecommendation ? "まだひとつに絞れません" : "相手に合いそうなものを選びます";
  document.querySelector("#offerRecommendationReason").textContent = latestOfferRecommendation?.reason
    || "相手の発信から、どんなことに役立ちそうかを考え、おすすめと理由を表示します。";
}

function setOfferRecommendation(recommendation) {
  latestOfferRecommendation = recommendation || null;
  renderOfferRecommendation();
}

function readSavedInstagramUrls() {
  try { return JSON.parse(localStorage.getItem(instagramStorageKey) || "{}"); } catch { return {}; }
}

function saveInstagramUrl(input) {
  try {
    const saved = readSavedInstagramUrls();
    saved[input.id] = input.value.trim();
    localStorage.setItem(instagramStorageKey, JSON.stringify(saved));
  } catch { /* 保存できない環境でも入力はそのまま使える */ }
}

function restoreInstagramUrls() {
  const saved = readSavedInstagramUrls();
  ["operatorProfileUrl", "profileUrl"].forEach((id) => {
    const input = document.querySelector(`#${id}`);
    if (input && !input.value && saved[id]) input.value = saved[id];
  });
}

function clearInstagramContext() {
  const contextField = document.querySelector("#browserContext");
  if (!contextField) return;
  contextField.value = "";
  document.querySelector("#operatorInstagramContext").value = "";
  document.querySelector("#counterpartInstagramContext").value = "";
  delete contextField.dataset.source;
  setOfferRecommendation(null);
  results.hidden = true;
  document.querySelector("#recommendedOfferCard").hidden = true;
}

async function copyInput(input, { emptyMessage, successMessage, failureMessage }) {
  const value = input.value.trim();
  if (!value) {
    setNotice(emptyMessage);
    input.focus();
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const helper = document.createElement("textarea");
      helper.value = value;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      document.execCommand("copy");
      helper.remove();
    }
    setNotice(successMessage, "success");
  } catch {
    setNotice(failureMessage);
  }
}

const copyInstagramUrl = (input) => copyInput(input, {
  emptyMessage: "先にInstagramのURLを入力してください。",
  successMessage: "InstagramのURLをコピーしました。",
  failureMessage: "コピーできませんでした。URLを長押ししてコピーしてください。"
});

const copyOffer = (input) => copyInput(input.value === "auto"
  ? { value: latestOfferRecommendation?.offer || "", focus: () => form.elements.profileUrl.focus() }
  : input.value === "その他" ? form.elements.otherOffer : input, {
  emptyMessage: input.value === "auto" ? "Instagramを確認しておすすめが決まると、コピーできます。" : "紹介したいものを選ぶか、その他の内容を入力してください。",
  successMessage: "紹介したい内容をコピーしました。",
  failureMessage: "コピーできませんでした。文章を長押ししてコピーしてください。"
});

function updateOtherOffer() {
  const isOther = form.elements.offer.value === "その他";
  const input = form.elements.otherOffer;
  document.querySelector("#otherOfferField").hidden = !isOther;
  input.disabled = !isOther;
  input.required = isOther;
  input.setCustomValidity(isOther && !input.value.trim() ? "紹介したい内容を入力してください。" : "");
  renderOfferRecommendation();
}

form.elements.offer.addEventListener("change", updateOtherOffer);
form.elements.otherOffer.addEventListener("input", updateOtherOffer);
updateOtherOffer();

restoreInstagramUrls();
document.querySelectorAll("#operatorProfileUrl, #profileUrl").forEach((input) => input.addEventListener("input", () => {
  saveInstagramUrl(input);
  // どちらか一方を変えたら、前の組み合わせの確認結果は使わない。
  clearInstagramContext();
}));
document.querySelectorAll(".copy-url").forEach((button) => button.addEventListener("click", () => {
  const input = document.querySelector(`#${button.dataset.copyInput}`);
  if (button.dataset.copyKind === "offer") copyOffer(input);
  else copyInstagramUrl(input);
}));

function openSharedTrial() {
  const trial = new URL(window.location.href).searchParams.get("trial");
  if (!/^[a-z0-9_][a-z0-9._]{0,29}$/i.test(trial || "")) return;
  clearInstagramContext();

  const sharedValues = {
    profileUrl: `https://www.instagram.com/${encodeURIComponent(trial)}/`,
    offer: "auto"
  };
  Object.entries(sharedValues).forEach(([id, value]) => {
    const input = form.elements[id];
    if (!input) return;
    input.value = value;
    if (id === "operatorProfileUrl" || id === "profileUrl") saveInstagramUrl(input);
  });
  updateOtherOffer();
  setNotice("試した相手のInstagramで準備ノートを作っています…", "info");
  window.setTimeout(() => form.requestSubmit(), 250);
}

async function checkOpera() {
  if (!operaStatus) return;
  try {
    const response = await fetchWithTimeout("/api/opera-status", {}, 8_000);
    const data = await response.json();
    operaStatus.innerHTML = data.available ? `<i></i> Opera Neonを確認できました` : data.cliAvailable ? `<i></i> Opera Neonに接続できていません` : `<i></i> はじめに接続の設定が必要です`;
    operaStatus.classList.toggle("ready", Boolean(data.available));
  } catch { operaStatus.textContent = "接続状態を確認できません"; }
}

function formData() {
  const data = Object.fromEntries(new FormData(form).entries());
  if (data.offer === "その他") data.offer = (data.otherOffer || "").trim();
  delete data.otherOffer;
  return data;
}

function oneLine(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const firstSentence = text.split(/[。！!]/u)[0].trim() || text;
  return firstSentence;
}

function itemPhrase(item, max = 64) {
  if (typeof item === "string") return oneLine(item, max);
  const title = item?.title || item?.name || item?.objection || "";
  const detail = item?.detail || item?.comparison || item?.response || "";
  if (title && detail) return oneLine(`${title}：${detail}`, max);
  return oneLine(title || detail, max);
}

function itemList(items) {
  const rows = (items || []).map((item) => `<li><span class="compact-bullet" aria-hidden="true">•</span><span class="compact-text">${escapeHtml(itemPhrase(item))}</span></li>`).join("");
  return `<ul class="compact-list">${rows}</ul>`;
}

function commonGroundList(items) {
  const frames = [
    "自分も同じような経験がある",
    "相手と同じことで困っている",
    "相手と同じ方向を目指している"
  ];
  const sourceItems = Array.isArray(items) ? items : [];
  const findItem = (frame, index) => sourceItems.find((item) => {
    const value = String(item?.frame || "").replace(/\s/g, "");
    const target = frame.replace(/\s/g, "");
    return value === target || value.includes(target) || target.includes(value);
  }) || sourceItems[index];
  const rows = frames.map((frame, index) => {
    const item = findItem(frame, index) || { detail: "会話の中で、実際にはどう感じているか確かめてみましょう。" };
    const phrase = item.detail ? `${frame}：${item.detail}` : frame;
    return `<li><span class="compact-bullet" aria-hidden="true">•</span><span class="compact-text">${escapeHtml(oneLine(phrase))}</span></li>`;
  }).join("");
  return `<ul class="compact-list common-ground-list">${rows}</ul>`;
}

function conversationPlanList(items) {
  return (items || []).map((item, index) => {
    return `<div class="plan-step"><div class="plan-top"><span class="plan-number">${String(index + 1).padStart(2, "0")}</span><span class="plan-time">${escapeHtml(item.time || "")}</span><span class="plan-priority">${escapeHtml(item.priority || "")}</span></div>${item.topic ? `<strong>${escapeHtml(oneLine(item.topic))}</strong>` : ""}${item.detail ? `<span class="plan-detail"><b>話す内容：</b>${escapeHtml(oneLine(item.detail))}</span>` : ""}</div>`;
  }).join("");
}

function newsList(items) {
  const rows = (items || []).map((item) => `<li><span class="compact-bullet" aria-hidden="true">•</span><span class="compact-text">${escapeHtml(itemPhrase(item))}</span></li>`).join("");
  return `<ul class="compact-list">${rows}</ul>`;
}

function instagramInsightsList(items) {
  const phrases = (items || []).map((item) => {
    if (typeof item === "string") return oneLine(item);
    const title = String(item?.title || item?.name || "").trim();
    const detail = oneLine(item?.detail || "");
    if (title && !/から$|公開情報から/.test(title)) return oneLine(title);
    const shortDetail = detail
      .replace(/^公開プロフィール・投稿・ストーリーズに[「『"]?/, "")
      .replace(/[」』"]?がありました$/, "")
      .replace(/^公開プロフィール・投稿・ストーリーズから/, "")
      .trim();
    return shortDetail || "公開情報を確認しました";
  }).filter(Boolean).slice(0, 3);
  const rows = [...new Set(phrases)].map((phrase) => `<li><span class="compact-bullet" aria-hidden="true">•</span><span class="compact-text">${escapeHtml(phrase)}</span></li>`).join("");
  return `<ul class="compact-list">${rows}</ul>`;
}

function impactPhrasesList(items) {
  const phrases = (items || []).map((item) => {
    if (typeof item === "string") return oneLine(item);
    return oneLine(item?.phrase || item?.text || item?.detail || item?.title || "");
  }).filter(Boolean).slice(0, 3);
  const rows = phrases.map((phrase) => `<li><span class="compact-bullet" aria-hidden="true">•</span><span class="compact-text">${escapeHtml(phrase)}</span></li>`).join("");
  return `<ul class="compact-list impact-phrases-list">${rows}</ul>`;
}

function objectionsList(items) {
  const rows = (items || []).map((item) => {
    const objection = oneLine(item?.objection || item?.title || "相手が言いそうなこと");
    const response = oneLine(item?.response || item?.detail || "相手の事情を聞いてから、合う方法を一緒に考える。");
    return `<li class="objection-item"><span class="objection-label">相手が言いそうなこと</span><strong>${escapeHtml(objection)}</strong><span class="objection-label response-label">切り返し</span><span class="objection-response">${escapeHtml(response)}</span></li>`;
  }).join("");
  return `<ul class="objection-list">${rows}</ul>`;
}

function preMeetingVideosList(items) {
  const rows = (items || []).map((item) => {
    const title = escapeHtml(oneLine(item?.title || "会話の準備動画"));
    const reason = escapeHtml(oneLine(item?.reason || item?.detail || "会話のヒントをつかむため"));
    const query = item?.query == null ? String(item?.title || "会話 聞き方").trim() : String(item.query).trim();
    const action = query ? `<a class="video-link" href="${escapeHtml(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`)}" target="_blank" rel="noreferrer">YouTubeで探す ↗</a>` : `<span class="video-link video-link-muted">会話で聞いてみる</span>`;
    return `<li class="video-item"><span class="compact-bullet" aria-hidden="true">•</span><span class="video-item-main"><strong>${title}</strong><span class="video-reason">${reason}</span></span>${action}</li>`;
  }).join("");
  return `<ul class="compact-list video-list">${rows}</ul>`;
}

function renderBrief(brief) {
  if (brief.offerRecommendation) setOfferRecommendation(brief.offerRecommendation);
  const recommendation = brief.offerRecommendation;
  document.querySelector("#recommendedOfferCard").hidden = !brief.productPending && (!recommendation?.applied || !recommendation?.offer);
  document.querySelector("#recommendedOfferTitle").textContent = brief.productPending ? "紹介するものは、あとで決めても大丈夫" : `${recommendation?.basis === "inferred" ? "おすすめ候補" : "おすすめ"}：${recommendation?.offer || ""}`;
  document.querySelector("#recommendedOfferReason").textContent = brief.productPending ? "まずは相手を知ることから。必要なら、紹介したいものを手動で選べます。" : recommendation?.reason || "";
  document.querySelector("#summary").textContent = oneLine(brief.summary || "—", 72);
  document.querySelector("#objective").textContent = oneLine(brief.objective || "—", 72);
  document.querySelector("#conversationPlan").innerHTML = conversationPlanList(brief.conversationPlan);
  document.querySelector("#instagramInsights").innerHTML = instagramInsightsList(brief.instagramInsights);
  document.querySelector("#impactPhrases").innerHTML = impactPhrasesList(brief.impactPhrases);
  document.querySelector("#objections").innerHTML = objectionsList(brief.objections);
  document.querySelector("#objectionsCard").hidden = Boolean(brief.productPending);
  document.querySelector('.result-flow a[href="#objections"]').hidden = Boolean(brief.productPending);
  document.querySelector("#preMeetingVideos").innerHTML = preMeetingVideosList(brief.preMeetingVideos);
  document.querySelector("#commonGround").innerHTML = commonGroundList(brief.commonGround);
  document.querySelector("#resultsMeta").textContent = `${brief.meta?.source || "入力情報"}  /  ${brief.meta?.generatedAt || "今"}`;
  results.hidden = false;
  document.querySelector("#resultsTitle").focus({ preventScroll: true });
  results.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
}

document.querySelector("#demoBtn").addEventListener("click", async () => {
  const button = document.querySelector("#demoBtn");
  button.disabled = true;
  setNotice("");
  try {
    const response = await fetch(apiUrl("/api/demo"));
    if (!response.ok) throw new Error("入力例を読み込めませんでした。もう一度試してみてください。");
    const demo = await response.json();
    form.elements.offer.value = "AI";
    updateOtherOffer();
    renderBrief(demo);
  } catch (error) { setNotice(error.message || "入力例を読み込めませんでした"); }
  finally { button.disabled = false; }
});

document.querySelector("#resetBtn").addEventListener("click", () => {
  results.hidden = true;
  form.elements.profileUrl.focus({ preventScroll: true });
  workspace.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
});

async function inspectInstagram({ silent = false } = {}) {
  const operatorProfileUrl = document.querySelector("#operatorProfileUrl").value.trim();
  const profileUrl = document.querySelector("#profileUrl").value.trim();
  const contextField = document.querySelector("#browserContext");
  const sourceKey = `${operatorProfileUrl}\n${profileUrl}`;
  if (!operatorProfileUrl && !profileUrl) {
    clearInstagramContext();
    if (!silent) setNotice("あなたか、話す相手のInstagramのURLを入れてください。");
    return { ok: false, skipped: true };
  }
  // 確認に失敗しても、前のアカウントの情報を送信しない。
  clearInstagramContext();
  // Instagramの投稿・ストーリーズは変わるため、送信のたびに最新情報を確認する。
  if (!silent) setNotice("Instagramを確認しています…", "info");
  try {
    const response = await fetchWithTimeout("/api/inspect-instagram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operatorProfileUrl, profileUrl }) }, 120_000);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "確認できませんでした");
    if (sourceKey !== `${form.elements.operatorProfileUrl.value.trim()}\n${form.elements.profileUrl.value.trim()}`) {
      return { ok: false, stale: true, error: "確認中にInstagramのURLが変わりました。もう一度ボタンを押してください。" };
    }
    contextField.value = data.context;
    document.querySelector("#operatorInstagramContext").value = data.operatorInstagramContext || "";
    document.querySelector("#counterpartInstagramContext").value = data.counterpartInstagramContext || "";
    contextField.dataset.source = sourceKey;
    setOfferRecommendation(data.offerRecommendation);
    if (!silent) {
      const accounts = (data.profiles || []).map((profile) => `${profile.label}（@${profile.username}）`).join("と");
      setNotice(accounts ? `${accounts}をそれぞれ確認しました。${data.compared ? "共通点のヒントを準備ノートに反映しました。" : "公開情報を準備ノートに反映しました。"}` : "公開プロフィール・投稿・ストーリーズを準備ノートに反映しました。", "success");
    }
    return data;
  } catch (error) {
    const message = error.name === "AbortError" ? "Instagramの確認に時間がかかっています。URLを確認するか、いったん入力だけで準備ノートを作ってみてください。" : error.message;
    if (!silent) setNotice(message);
    return { ok: false, error: message };
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (form.elements.offer.value === "auto" && !form.elements.profileUrl.value.trim()) {
    setNotice("自動でおすすめするには、話す相手のInstagramを入れてください。手動でも選べます。");
    form.elements.profileUrl.focus();
    return;
  }
  const submit = form.querySelector(".primary-button");
  submit.disabled = true; form.setAttribute("aria-busy", "true");
  try {
    const operatorProfileUrl = form.elements.operatorProfileUrl.value.trim();
    const profileUrl = form.elements.profileUrl.value.trim();
    const contextField = document.querySelector("#browserContext");
    const sourceKey = `${operatorProfileUrl}\n${profileUrl}`;
    if ((operatorProfileUrl || profileUrl) && (!contextField.value.trim() || contextField.dataset.source !== sourceKey)) {
      submit.querySelector("span").textContent = "Instagramを確認中…";
      setNotice("Instagramを確認してから、準備ノートを作ります。", "info");
      const inspected = await inspectInstagram({ silent: true });
      if (inspected?.stale) throw new Error(inspected.error);
      if (!inspected?.ok && form.elements.offer.value === "auto") throw new Error("相手のInstagramを確認できませんでした。もう一度試すか、紹介したいものを手動で選んでください。");
      if (!inspected?.ok) setNotice("Instagramを確認できなかったため、入力内容だけで準備ノートを作ります。", "info");
    }
    const data = formData();
    submit.querySelector("span").textContent = "ノートをまとめています…";
    if (!data.browserContext) setNotice("少しお待ちください。会話のヒントを考えています。", "info");
    const response = await fetchWithTimeout("/api/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }, 60_000);
    const payload = await response.json();
    if (payload.offerRecommendation) setOfferRecommendation(payload.offerRecommendation);
    if (!response.ok) throw new Error(payload.error || "生成に失敗しました");
    setNotice(payload.productPending ? "相手の興味をまとめました。紹介するものは、あとで選べます。" : payload.meta?.fallback ? "AIの返事に時間がかかったので、入力内容から先に準備ノートを作りました。" : "準備ノートができました。ゆっくり目を通してみてください。", "success");
    renderBrief(payload);
  } catch (error) { setNotice(error.name === "AbortError" ? "少し時間がかかっています。入力を短くして、もう一度試してみてください。" : error.message); }
  finally { submit.disabled = false; submit.querySelector("span").textContent = "確認して準備ノートをつくる"; form.removeAttribute("aria-busy"); }
});

checkOpera();
openSharedTrial();

