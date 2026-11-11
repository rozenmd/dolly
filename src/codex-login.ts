import { z } from "zod";
import type { Credentials } from "./credentials";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH = "https://auth.openai.com";
const PROVIDER = "openai-codex";
const deviceSchema = z.object({
  device_auth_id: z.string().min(1),
  user_code: z.string().min(1),
  interval: z.coerce.number().finite().min(0).max(900),
});
const authorizationSchema = z.object({
  authorization_code: z.string().min(1),
  code_verifier: z.string().min(1),
});
const tokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive().finite(),
});
type Device = z.infer<typeof deviceSchema> & { expiresAt: number; nextPollAt: number };

async function post(path: string, body: BodyInit, contentType = "application/json") {
  return fetch(`${AUTH}${path}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
}

function awaiting(device: Device) {
  return {
    state: "awaiting_code",
    verificationUri: `${AUTH}/codex/device`,
    userCode: device.user_code,
    expiresAt: device.expiresAt,
    pollAfterSeconds: Math.max(1, Math.ceil((device.nextPollAt - Date.now()) / 1000)),
  };
}

/** Each HTTP poll is bounded. The device grant survives eviction, with no in-memory poller. */
export class CodexLogin {
  constructor(private readonly storage: DurableObjectStorage, private readonly credentials: Credentials) {}

  start() {
    return this.credentials.exclusive(async () => {
      if (await this.credentials.read(PROVIDER)) return { state: "connected" };
      const existing = await this.storage.get<Device>("login");
      if (existing && existing.expiresAt > Date.now()) return awaiting(existing);
      const response = await post("/api/accounts/deviceauth/usercode", JSON.stringify({ client_id: CLIENT_ID }));
      if (!response.ok) throw new Error(`Codex device login start: HTTP ${response.status}`);
      const parsed = deviceSchema.parse(await response.json());
      const device = { ...parsed, expiresAt: Date.now() + 900_000, nextPollAt: Date.now() + Math.max(1, parsed.interval) * 1000 };
      await this.storage.put("login", device);
      return awaiting(device);
    });
  }

  poll() {
    // modify owns the refresh-token lock through the exchange and persistence.
    let result: object = { state: "not_connected" };
    return this.credentials.modify(PROVIDER, async (current) => {
      if (current) {
        result = { state: "connected" };
        return undefined;
      }
      const device = await this.storage.get<Device>("login");
      if (!device) return undefined;
      if (device.expiresAt <= Date.now()) {
        await this.storage.delete("login");
        result = { state: "expired" };
        return undefined;
      }
      if (Date.now() < device.nextPollAt) {
        result = awaiting(device);
        return undefined;
      }
      device.nextPollAt = Date.now() + Math.max(1, device.interval) * 1000;
      await this.storage.put("login", device);
      const response = await post("/api/accounts/deviceauth/token", JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }));
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const parsed = z.object({ error: z.union([z.string(), z.object({ code: z.string() })]) }).safeParse(body);
        const code = parsed.success ? (typeof parsed.data.error === "string" ? parsed.data.error : parsed.data.error.code) : undefined;
        if (code === "slow_down") {
          device.interval += 5;
          device.nextPollAt = Date.now() + device.interval * 1000;
          await this.storage.put("login", device);
        } else if (response.status !== 403 && response.status !== 404 && code !== "deviceauth_authorization_pending") {
          throw new Error(`Codex device login poll: HTTP ${response.status}`);
        }
        result = awaiting(device);
        return undefined;
      }
      const authorization = authorizationSchema.parse(await response.json());
      const tokens = await post("/oauth/token", new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: authorization.authorization_code,
        code_verifier: authorization.code_verifier,
        redirect_uri: `${AUTH}/deviceauth/callback`,
      }), "application/x-www-form-urlencoded");
      if (!tokens.ok) throw new Error(`Codex token exchange: HTTP ${tokens.status}`);
      const parsed = tokensSchema.parse(await tokens.json());
      result = { state: "connected" };
      return { type: "oauth", access: parsed.access_token, refresh: parsed.refresh_token, expires: Date.now() + parsed.expires_in * 1000 };
    }).then(async () => {
      if ("state" in result && result.state === "connected") await this.storage.delete("login");
      return result;
    });
  }

  logout() {
    return this.credentials.exclusive(async () => {
      await this.storage.delete(["login", `credential:${PROVIDER}`]);
      return { state: "not_connected" };
    });
  }
}
