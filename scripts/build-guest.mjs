import { mkdirSync, copyFileSync, readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = resolve(process.argv[2] || join(root, ".guest-build"));
const sources = ["index.html", "app.js", "data.js", "styles.css"];
mkdirSync(out, { recursive: true });
const allowed = new Set([...sources, "flower.svg"]);
for (const entry of readdirSync(out)) if (!allowed.has(entry)) throw new Error(`Unexpected output file: ${entry}`);
for (const name of sources) copyFileSync(join(root, "guest", name), join(out, name));
copyFileSync(join(root, "public", "flower.svg"), join(out, "flower.svg"));
const scripts = ["app.js", "data.js"].map(name => readFileSync(join(out, name), "utf8")).join("\n");
if (/\bfetch\s*\(|XMLHttpRequest|WebSocket|localhost|127\.0\.0\.1|\/api\//.test(scripts)) throw new Error("Guest code must not connect to any backend.");
console.log(JSON.stringify({ guestDirectory: out, files: [...allowed], backendConnections: 0 }));
