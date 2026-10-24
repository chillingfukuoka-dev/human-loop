import { GUEST_CODE, samples, makeDemoNote } from "./data.js";

const $ = selector => document.querySelector(selector);
const gate = $("#gate");
const demo = $("#demo");
const form = $("#demoForm");
const key = "human-loop-guest-demo-admission";
const normalize = value => String(value || "").normalize("NFKC").trim().toUpperCase();

function enter() { gate.hidden = true; demo.hidden = false; $("#guestCode").value = ""; }
try { if (sessionStorage.getItem(key) === GUEST_CODE) enter(); } catch { /* The demo also works without storage. */ }
$("#guestLogin").addEventListener("submit", event => {
  event.preventDefault();
  if (normalize($("#guestCode").value) !== GUEST_CODE) { $("#gateNotice").textContent = "ゲストコードをもう一度確認してください。"; return; }
  try { sessionStorage.setItem(key, GUEST_CODE); } catch { /* Optional, demo-only memory. */ }
  $("#gateNotice").textContent = "";
  enter();
  $("#demoTitle").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#leaveDemo").addEventListener("click", () => {
  try { sessionStorage.removeItem(key); } catch { /* Optional. */ }
  demo.hidden = true;
  gate.hidden = false;
  $("#results").hidden = true;
  $("#guestCode").focus();
});
function updatePerson() {
  const person = samples[form.elements.person.value];
  $("#sampleRole").textContent = person.role;
  $("#sampleBio").textContent = person.bio;
  $("#results").hidden = true;
}
form.elements.person.addEventListener("change", updatePerson);
form.elements.offer.addEventListener("change", () => {
  const other = form.elements.offer.value === "その他";
  $("#otherField").hidden = !other;
  form.elements.otherOffer.disabled = !other;
  form.elements.otherOffer.required = other;
  $("#results").hidden = true;
});
form.elements.duration.addEventListener("change", () => { $("#results").hidden = true; });
function list(selector, items) {
  const rows = items.map(text => { const row = document.createElement("li"); row.textContent = text; return row; });
  $(selector).replaceChildren(...rows);
}
form.addEventListener("submit", event => {
  event.preventDefault();
  $("#demoNotice").textContent = "";
  try {
    const note = makeDemoNote({ personId: form.elements.person.value, duration: form.elements.duration.value, offer: form.elements.offer.value, customOffer: form.elements.otherOffer.value });
    $("#resultMeta").textContent = `${note.person.name}（架空）・${note.duration}・事前に作成した例です`;
    list("#interests", note.person.interests);
    list("#common", note.person.common);
    list("#phrases", note.person.phrases);
    $("#offerTitle").textContent = `${note.selectedOffer}の紹介例`;
    $("#offerReason").textContent = note.reason;
    $("#proposal").textContent = note.proposal;
    const steps = note.timeline.map(item => {
      const row = document.createElement("li");
      const time = document.createElement("span"); time.className = "time"; time.textContent = item.time;
      const body = document.createElement("div");
      const title = document.createElement("strong"); title.textContent = item.title;
      const detail = document.createElement("p"); detail.textContent = item.detail;
      body.append(title, detail); row.append(time, body); return row;
    });
    $("#timeline").replaceChildren(...steps);
    const replies = note.objections.flatMap(([question, reply]) => {
      const dt = document.createElement("dt"); dt.textContent = question;
      const dd = document.createElement("dd"); dd.textContent = reply;
      return [dt, dd];
    });
    $("#objections").replaceChildren(...replies);
    $("#results").hidden = false;
    $("#resultsTitle").focus({ preventScroll: true });
    $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) { $("#demoNotice").textContent = error.message; }
});
updatePerson();
