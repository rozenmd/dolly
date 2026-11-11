# pi-hard

A personal coding-agent API on Cloudflare Workers, using Hono, Pi Durable 1.5.2, Cloudflare Sandbox 1.0.3, and a ChatGPT/Codex subscription. No OpenAI API key is required.

## Run locally

Use Node.js 22.19 or newer and a running Docker engine. Cloudflare's container runtime also needs a paid Workers account for deployment.

```sh
npm ci
cp .dev.vars.example .dev.vars
openssl rand -hex 32
```

Save the generated value as `API_TOKEN` in `.dev.vars`. Keep that file private. Then:

```sh
npm run dev
```

In another terminal:

```sh
npm run login
```

Open the printed OpenAI URL and enter the one-time code. Enable device-code authentication in your ChatGPT security settings if OpenAI requires it. The client polls until connected. Access depends on your subscription's Codex entitlement and usage limits.

This creates a fresh login for this Worker. Do not copy an existing Codex `auth.json` or share a refresh token with another process. OpenAI rotates refresh tokens, and two independent refresh owners can invalidate each other's login.

## Use the API

Set `API_URL` to the local or deployed Worker URL and `API_TOKEN` to the same private bearer token configured on that Worker. All `/api/*` routes require it.

```sh
export API_URL=http://localhost:8787
# Set API_TOKEN in your shell without committing it.

curl -sS "$API_URL/api/sessions" \
  -H "Authorization: Bearer $API_TOKEN" -X POST
```

Use the returned `id`:

```sh
export SESSION_ID=the-returned-id
curl -sS "$API_URL/api/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"content\":\"Write hello.js in /workspace and run it\",\"requestId\":\"$(uuidgen)\"}"

curl -sS "$API_URL/api/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $API_TOKEN"
```

A prompt returns `202` after durable admission, not after generation. Poll the session to read its Pi conversation view, including recent entries and live progress. Reuse the same UUID `requestId` when retrying the same prompt to avoid duplicate work. The snapshot contains a bounded recent transcript window, not an export of all history.

| Route | Operation |
| --- | --- |
| `GET /health` | Public liveness check |
| `POST /api/auth/codex` | Start or reuse device login |
| `GET /api/auth/codex` | Poll login, respecting `pollAfterSeconds` |
| `DELETE /api/auth/codex` | Delete the Worker's local credentials and pending login |
| `POST /api/sessions` | Create a conversation |
| `GET /api/sessions/:id` | Read the latest conversation view |
| `POST /api/sessions/:id/messages` | Submit `{content, requestId}` |
| `POST /api/sessions/:id/abort` | Abort current and queued work |

Logout does not revoke the grant at OpenAI or cancel an already-authorized model request. Abort active sessions before disconnecting if you need work to stop.

## Deploy

```sh
npx wrangler login
npx wrangler secret put API_TOKEN
npm run deploy
API_URL=https://your-worker.workers.dev npm run login
```

The deployed secret and the local `API_TOKEN` used by the login client must match. Keep an already-configured token rather than generating another on every deploy. Local and deployed Durable Object storage are separate; each environment needs its own subscription login. No deployment is performed by the test or build commands.

`CODEX_MODEL` in `wrangler.jsonc` selects the model for new conversations. It must be present in the pinned Pi Codex provider catalog and available to your subscription. Requests use the subscription-backed Codex Responses endpoint over SSE, not the billed OpenAI API endpoint.

## Ownership and limits

- One `Agent` Durable Object owns the account credentials and Pi SQLite storage. Credential writes, refresh and logout share one serialized queue. Login grants survive object restarts; alarms resume pending Pi work.
- Each conversation gets a separate `Sandbox` Durable Object and native Linux container. The agent has `shell` and Sandbox 1.0 `Files`-backed `read_file` tools. Commands run as an unprivileged user.
- Subscription credentials and the API token never enter the container. Container internet access is disabled. The Worker can still reach OpenAI. Installing dependencies or cloning repositories from inside the sandbox needs an explicit network policy change.
- Conversation history is durable. Sandbox files are **ephemeral** and disappear when the container is replaced. Containers stop after five minutes of inactivity; add R2 directory backups before relying on files across restarts.
- Shell calls have a 60-second deadline and keep at most 32 KiB per output stream. File reads allow 64 KiB. Runs stop after 20 tool rounds. Interrupted shell calls are marked unsafe to replay because commands may have side effects.
- This is single-owner software. Anyone with `API_TOKEN` can use your subscription, run sandbox commands, and read conversations. There is no multi-user authorization, rate limiter, browser UI, or public sandbox preview.
- Worker storage holds OAuth secrets. Protect access to the Cloudflare account and local `.wrangler` data. Logs and transcript responses redact known tokens and OAuth fields while retaining diagnostic messages.

## Verification

```sh
npm run check         # TypeScript
npm test              # workerd API, OAuth protocol and Pi adapter tests
npm run test:sandbox  # native Container + Files integration, requires Docker
npm run build         # deployment dry run including Docker image build
```

The ordinary tests stub OpenAI only. They run Hono, Durable Objects, SQLite, credential locking, Pi generation and the Codex SSE adapter in workerd, including crash recovery and duplicate prompt admission. Container integration checks actual execution, file reads and isolation. No test uses a real subscription. A successful live login and model/tool round trip remain the final deployment smoke test.

## References

- [Pi Durable Cloudflare example](https://github.com/earendil-works/pi-durable-cloudflare), for Durable Object SQLite storage and alarm-driven recovery.
- [Cloudflare Sandbox SDK](https://github.com/cloudflare/sandbox-sdk), for the 1.0 native Container API and `Files` integration.
- [Open Session device login](https://github.com/tellahq/opensession/blob/main/packages/core/opensession-server/src/server/codex-device-login.ts) and [refresh ownership](https://github.com/tellahq/opensession/blob/main/packages/core/opensession-server/src/server/codex-token-refresh.ts), for subscription sign-in and token rotation constraints. That server uses the Codex CLI; this Worker implements the headless device protocol and delegates refresh and model requests to Pi's Codex provider.
