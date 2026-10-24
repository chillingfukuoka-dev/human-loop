import { mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createMobileGateway } from "../lib/mobile-gateway.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const stateDir = join(root, ".mobile");
const stateFile = join(stateDir, "access.json");
const upstreamPort = Number(process.env.PORT || 3000);
const gatewayPort = 3001;
const gateway = createMobileGateway({ upstreamPort });
const cloudflared = existsSync("/opt/homebrew/bin/cloudflared") ? "/opt/homebrew/bin/cloudflared" : "cloudflared";
let tunnel;
let accessUrl;
let stopping = false;
let ownsState = false;
const startedAt = new Date().toISOString();

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
chmodSync(stateDir, 0o700);
function saveState(status) {
  writeFileSync(stateFile, JSON.stringify({ status, url: accessUrl || null, pid: process.pid, startedAt, updatedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(stateFile, 0o600);
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (startupTimer) clearTimeout(startupTimer);
  tunnel?.kill("SIGTERM");
  gateway.server.close();
  gateway.server.closeAllConnections();
  if (ownsState) saveState("stopped");
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref();
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
let startupTimer;

try {
  const local = await fetch(`http://127.0.0.1:${upstreamPort}/api/demo`, { signal: AbortSignal.timeout(5000) });
  if (!local.ok) throw new Error("ローカルサイトが応答していません。先に npm run dev を起動してください。");
  await local.arrayBuffer();
  await new Promise((resolve, reject) => {
    gateway.server.once("error", reject);
    gateway.server.listen(gatewayPort, "127.0.0.1", resolve);
  });
  ownsState = true;
  saveState("starting");
  console.log("パスワードなしの携帯用接続を準備しています。リンクを知っている人が開けます。");
  tunnel = spawn(cloudflared, ["tunnel", "--url", `http://127.0.0.1:${gatewayPort}`, "--protocol", "http2", "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"], cwd: root });
  let logTail = "";
  const onLog = chunk => {
    if (stopping) return;
    const text = chunk.toString("utf8");
    process.stdout.write(text);
    logTail = (logTail + text).slice(-12000);
    const match = logTail.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com/);
    if (match && !accessUrl) {
      accessUrl = match[0];
      gateway.setPublicOrigin(accessUrl);
      saveState("connecting");
      console.log(`\n携帯用リンク候補: ${accessUrl}\nインターネットとの接続を確認しています。`);
    }
    if (accessUrl && text.includes("Registered tunnel connection")) {
      saveState("ready");
      clearTimeout(startupTimer);
      console.log(`\n接続できました: ${accessUrl}\nパスワード入力はありません。\n停止するときは、このコマンドを Ctrl+C で終了してください。`);
    }
    if (text.includes("Lost connection with the edge") || text.includes("Connection terminated")) saveState("reconnecting");
    if (text.includes("Unauthorized: Tunnel not found")) {
      console.error("一時リンクが無効になりました。npm run mobile を再実行して新しいリンクを作ってください。");
      stop(1);
    }
  };
  tunnel.stdout.on("data", onLog);
  tunnel.stderr.on("data", onLog);
  tunnel.on("error", error => { console.error(`接続ツールを起動できませんでした: ${error.message}`); stop(1); });
  tunnel.on("exit", code => { if (!stopping) { console.error(`携帯用の接続が終了しました (${code})`); stop(1); } });
  startupTimer = setTimeout(() => { console.error("携帯用リンクを準備できませんでした。"); stop(1); }, 60_000);
} catch (error) {
  console.error(error.message);
  stop(1);
}
