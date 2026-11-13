import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";

const token = "test-session-token";

/** Request headers for a browser signed in with GitHub as the owner. Call `signIn` first. */
export const headers = { Cookie: `__Host-dolly-session=${token}` };

/** Seed the owner and a signed-in session, as a completed GitHub device sign-in would. */
export async function signIn() {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );

  const key = btoa(String.fromCharCode(...digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.put("auth:owner", { id: 1, login: "octocat" });
    await state.storage.put(`auth:session:${key}`, {
      ownerId: 1,
      expires: Date.now() + 86_400_000,
    });
  });
}
