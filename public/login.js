const form = document.querySelector("#loginForm");
const button = document.querySelector("#loginButton");
const notice = document.querySelector("#loginNotice");
const password = document.querySelector("#password");
const confirmation = document.querySelector("#confirmPassword");
let setup = false;

async function status() {
  try {
    const response = await fetch("/api/auth/status", { cache: "no-store" });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (data.authenticated) { window.location.replace("/"); return; }
    if (data.needsSetup && !data.setupAllowed) {
      document.querySelector("#loginDescription").textContent = "最初にMacの http://localhost:3000 を開いて、本人用パスワードを設定してください。";
      form.hidden = true;
      return;
    }
    setup = data.needsSetup;
    if (setup) {
      document.querySelector("#loginTitle").textContent = "最初に、あなたの合言葉を。";
      document.querySelector("#loginDescription").textContent = "本人用のパスワードを12文字以上で決めてください。ゲストコードとは別です。パスワードそのものは保存しません。";
      document.querySelector("#confirmField").hidden = false;
      confirmation.required = true;
      password.minLength = 12;
      password.autocomplete = "new-password";
    }
    button.textContent = setup ? "設定して、はじめる" : "ログインする";
    button.disabled = false;
  } catch { notice.textContent = "Macとの接続を確認して、ページを開き直してください。"; }
}
form.addEventListener("submit", async event => {
  event.preventDefault();
  notice.textContent = "";
  if (setup && password.value !== confirmation.value) { notice.textContent = "2回の入力が違います。もう一度確かめてください。"; return; }
  button.disabled = true;
  button.textContent = "確認しています…";
  try {
    const response = await fetch(setup ? "/api/auth/setup" : "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: password.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "もう一度お試しください。");
    password.value = "";
    confirmation.value = "";
    window.location.replace("/");
  } catch (error) {
    notice.textContent = error.message || "接続を確認してください。";
    button.disabled = false;
    button.textContent = setup ? "設定して、はじめる" : "ログインする";
  }
});
status();
