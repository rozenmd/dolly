// The Worker owns OAuth tokens; this client sees only the one-time code and status.
const base = process.env.API_URL ?? "http://localhost:8787";
const token = process.env.API_TOKEN;
if (!token || token.length < 32) throw new Error("Set API_TOKEN in .dev.vars or the environment first");
if (new URL(base).protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) {
  throw new Error("Use HTTPS except for local development");
}
async function request(method) {
  const response = await fetch(new URL("/api/auth/codex", base), {
    method,
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Worker returned HTTP ${response.status}`);
  return response.json();
}
let result = await request("POST");
if (result.state === "awaiting_code") console.log(`Open ${result.verificationUri}\nEnter code: ${result.userCode}`);
const deadline = Date.now() + 16 * 60_000;
while (result.state === "awaiting_code" && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(1, result.pollAfterSeconds ?? 5) * 1000));
  result = await request("GET");
}
if (result.state !== "connected") throw new Error(`Login ended with state: ${result.state}. Run npm run login to start again.`);
console.log("Codex subscription connected. Credentials stay in the Worker.");
