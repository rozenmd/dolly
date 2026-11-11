# pi-hard

A Cloudflare Access-protected personal coding-agent API on Cloudflare Workers, using Hono, Effect 4.0.0-rc.112, Pi Durable 1.5.2, Cloudflare Sandbox 1.0.3, and a ChatGPT/Codex subscription. No OpenAI API key is required.

## Deploy to Cloudflare

Use Node.js 24.22.2 (pinned in `.node-version` and CI), a running Docker engine to build the container image, and a paid Cloudflare Workers account.

```sh
npm ci
npx cf auth login
```

For first-time setup, create a private secrets file and generate an API token:

```sh
cp .dev.vars.example .dev.vars
openssl rand -hex 32
```

Save the generated value as `API_TOKEN` in `.dev.vars`. Keep that file private. If you already have a configured `.dev.vars`, reuse it instead of copying the example or generating another token.

```sh
# First deployment only: upload the configured API token.
npm run deploy -- --secrets-file .dev.vars
```

### Require Cloudflare Access

The first deployment refuses API calls until Access is configured. Before connecting Codex:

1. In Cloudflare, enable [Access protection for this Worker's production `workers.dev` URL](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#manage-access-to-workersdev). Protect the entire hostname, not just one API path. In Zero Trust, restrict the application's Allow policy to your identity or approved users; do not use an Everyone or Bypass policy.
2. For the login script and `curl`, create or reuse an Access service token. Add a **Service Auth** policy to this application that includes only that token. A service token is a machine credential, separate from your Codex subscription and the Worker's `API_TOKEN`.
3. Copy the Access application's audience (AUD) tag and your team domain into `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` in `cloudflare.config.ts`. The team domain is a hostname such as `your-team.cloudflareaccess.com`, without `https://` or a path. Keep `ACCESS_LOCAL_DEV` set to `"false"` for deployments.
4. Redeploy with `npm run deploy`. The Worker verifies the Access JWT's RS256 signature, issuer, audience and expiration on every `/api/*` request, in addition to requiring `API_TOKEN`. Missing configuration, missing/forged tokens and failed certificate lookups cannot authorize API access.

Preview URLs are disabled in the configuration. If you add a custom domain, protect that entire hostname with Access too, and either protect or disable the alternate `workers.dev` route (`workersDev: false`). Never leave an alternate public hostname or preview unprotected. The Worker-side JWT check also prevents those routes from accepting requests with only the API token.

Save your approved service token in a separate local file:

```sh
# Only create this file if it does not already exist.
test -f .env.access || cp .env.access.example .env.access
```

Fill in `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in `.env.access`. It is ignored by Git and loaded by `npm run login`. Do not upload this file with `--secrets-file`: these credentials belong to your client, not the Worker. Keep existing service credentials instead of creating a new token for each deployment.

Set `API_URL` to the Access-protected HTTPS Worker URL printed by deployment, then connect your Codex subscription:

```sh
export API_URL=https://pi-hard.your-subdomain.workers.dev
npm run login
```

The login client reads `API_TOKEN` from `.dev.vars` and the Access service credentials from `.env.access`, then connects to the deployed Worker. Open the printed OpenAI URL and enter the one-time code. Enable device-code authentication in your ChatGPT security settings if OpenAI requires it. The client polls until connected. Access depends on your subscription's Codex entitlement and usage limits.

This creates a fresh login for this Worker. Do not copy an existing Codex `auth.json` or share a refresh token with another process. OpenAI rotates refresh tokens, and two independent refresh owners can invalidate each other's login.

For later deployments, run `npm run deploy` without `--secrets-file` to preserve the deployed secret. The deployed secret and the `API_TOKEN` used by the login client must match. No deployment is performed by the test or build commands.

`cloudflare.config.ts` owns Worker bindings, SQLite Durable Object exports, observability, and the native Sandbox container definition. The pinned `cf` CLI loads it for development and deployment; Wrangler remains only its underlying bundler, with no hand-maintained Wrangler configuration file. Cloudflare's programmatic configuration is currently in open beta.

`CODEX_MODEL` in `cloudflare.config.ts` selects the default model for new conversations; a session request's `model` overrides it. It must be present in the pinned Pi Codex provider catalog and available to your subscription. Requests use the subscription-backed Codex Responses endpoint over SSE, not the billed OpenAI API endpoint.

## Use the API

Use the Access-protected deployed `API_URL`, your approved Access service token, and the same private bearer token configured on the Worker. Both authentication checks are required.

```sh
# Load existing client credentials; do not generate new ones.
. ./.dev.vars
. ./.env.access
export API_TOKEN CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET

curl -sS "$API_URL/api/sessions" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-6-sol"}'
```

The response includes `id` and the selected `model`. The optional `model` must be in Pi's pinned Codex catalog; unknown models return `400`. For example, `gpt-6-luna`, `gpt-6-sol`, and `gpt-6.1-terra` are supported by this version. Your subscription must also allow the selected model. An empty body or `{}` uses `CODEX_MODEL` from `cloudflare.config.ts`. Selection is saved with the conversation, survives restarts, and does not change other sessions.

Use the returned `id`:

```sh
export SESSION_ID=the-returned-id
curl -sS "$API_URL/api/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H 'Content-Type: application/json' \
  -d "{\"content\":\"Write hello.js in /workspace and run it\",\"requestId\":\"$(uuidgen)\"}"

curl -sS "$API_URL/api/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

A prompt returns `202` after durable admission, not after generation. Poll the session to read its Pi conversation view, including recent entries and live progress. Reuse the same UUID `requestId` when retrying the same prompt to avoid duplicate work. The snapshot contains a bounded recent transcript window, not an export of all history.

| Route                             | Operation                                                    |
| --------------------------------- | ------------------------------------------------------------ |
| `GET /health`                     | Liveness check (Access still protects the deployed hostname) |
| `POST /api/auth/codex`            | Start or reuse device login                                  |
| `GET /api/auth/codex`             | Poll login, respecting `pollAfterSeconds`                    |
| `DELETE /api/auth/codex`          | Delete the Worker's local credentials and pending login      |
| `POST /api/sessions`              | Create a conversation                                        |
| `GET /api/sessions/:id`           | Read the latest conversation view                            |
| `POST /api/sessions/:id/messages` | Submit `{content, requestId}`                                |
| `POST /api/sessions/:id/abort`    | Abort current and queued work                                |

Logout does not revoke the grant at OpenAI or cancel an already-authorized model request. Abort active sessions before disconnecting if you need work to stop.

## Child agents

Agents can delegate through `spawn_task`, `send_to_session`, `list_children`, `task_status`, `wait_for_task`, and `cancel_task`. Children have their own conversation and sandbox; they receive only the supplied prompt, not a copy of the parent's transcript or files. The child inherits its parent's model unless an optional `model` selects another model from the Codex catalog.

```text
Parent session
  | spawn_task({ content, model? })
  +-- Child session + separate sandbox
  |     +-- Grandchild session + separate sandbox
  |
  | wait_for_task({ taskId })
  <--- Answer or failure receipt
```

Spawning and sending return immediately. Each returns a `taskId` for that message's answer. `wait_for_task` waits for the receipt; `task_status` checks without waiting. There is no automatic follow-up turn when a child finishes: the parent must explicitly wait or check. Child creation, message delivery and results survive Durable Object restarts, using Pi's durable tasks and ownership edges. Interrupted model requests may be retried; prompts and child creation are deduplicated.

The server enforces these limits, including for API clients:

- Three child levels below a root (root depth is zero).
- Eight children per session over its lifetime, not just eight running at once.
- 32 child-message deliveries per session, including each child's initial prompt.
- Child answers in task receipts retain the first 16,384 characters; read the child's transcript for its recent full answer.

These bound delegation but are not a spending limit. All sessions share your subscription's usage allowance. Creating another root starts a new set of limits.

The same operations are available over authenticated HTTP:

| Route                                               | Operation                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `POST /api/sessions/:id/children`                   | Spawn with `{content, requestId, model?}`; returns `202` with `{id, model, taskId}` |
| `GET /api/sessions/:id/children`                    | List direct children                                                                |
| `POST /api/sessions/:id/children/:childId/messages` | Queue `{content, requestId}` for a direct child; returns `202` with `{taskId}`      |
| `GET /api/sessions/:id/tasks/:taskId`               | Poll a message's status and answer/failure receipt                                  |
| `GET /api/sessions/:childId`                        | Read the child's transcript                                                         |
| `POST /api/sessions/:childId/abort`                 | Stop that child and all descendants, including queued deliveries                    |

Treat both session and task IDs as opaque strings. HTTP `requestId` values must be UUIDs: retrying the same request returns its original receipt, while reusing it with different content or options returns `409`. Unknown models and invalid inputs return `400`; delegation limits return `409`. Agents can message, inspect and cancel only their own direct children; an approved Access client with the bearer token can access all sessions.

Aborting a parent also stops all descendants and pending deliveries. Aborting does not delete conversations or files, and a stopped child can receive new messages. New work admitted after an abort's snapshot is not part of that cancellation. Children cannot read a parent's workspace; container files remain ephemeral.

## Optional local development

To develop locally after installing dependencies and configuring `.dev.vars`, start the Worker with Docker running:

```sh
npm run dev -- --var ACCESS_LOCAL_DEV:true
```

This command bypasses JWT verification only for this local development invocation; the API bearer token is still required. Never deploy with `ACCESS_LOCAL_DEV` enabled or put that override in `.dev.vars`. The automated Worker tests use the same explicit bypass except for the Access authentication tests.

In another terminal, explicitly select the local Worker and connect its Codex login:

```sh
export API_URL=http://localhost:8787
npm run login
```

Local and deployed Durable Object storage are separate; each environment needs its own subscription login. Use the same API examples with this local `API_URL`. Set `API_URL` back to your deployed HTTPS URL when returning to the deployed Worker.

## Effect architecture

Effect owns API workflows, schema validation, the Codex device protocol, credential serialization, timeouts, stream and process cleanup, and the login client. `Account`, `CodexProtocol`, and `AgentApi` are explicit services wired with Layers. Owned request and upstream schemas use Effect Schema, not Zod.

Hono and Cloudflare Durable Objects remain native hosts. They run Effects at HTTP, RPC and Pi callback boundaries. Pi still owns durable task scheduling and transcript storage; Effect fibers do not replace Pi's recovery mechanism. Credential locking uses one Effect semaphore per account object, shared with Pi's Promise-based credential adapter. Scoped finalizers stop transcript watches and cancel sandbox readers and processes.

## Ownership and limits

- One `Agent` Durable Object owns the account credentials and Pi SQLite storage. Credential writes, refresh and logout share one serialized queue. Login grants survive object restarts; alarms resume pending Pi work.
- Each conversation gets a separate `Sandbox` Durable Object and native Linux container. The agent has `shell` and Sandbox 1.0 `Files`-backed `read_file` tools. Commands run as an unprivileged user.
- Subscription credentials and the API token never enter the container. Container internet access is disabled. The Worker can still reach OpenAI. Installing dependencies or cloning repositories from inside the sandbox needs an explicit network policy change.
- Conversation history is durable. Sandbox files are **ephemeral** and disappear when the container is replaced. Containers stop after five minutes of inactivity; add R2 directory backups before relying on files across restarts.
- Shell calls have a 60-second deadline and keep at most 32 KiB per output stream. File reads allow 64 KiB. Runs stop after 20 tool rounds. Interrupted shell calls are marked unsafe to replay because commands may have side effects.
- This is single-owner software. Anyone allowed by your Access policy who also has `API_TOKEN` can use your subscription, run sandbox commands, and read conversations. There is no multi-user authorization, rate limiter, browser UI, or public sandbox preview.
- Worker storage holds OAuth secrets. Protect access to the Cloudflare account and local `.wrangler` data. Logs and transcript responses redact known tokens and OAuth fields while retaining diagnostic messages.

## Code quality

`npm run check` runs oxfmt, Oxlint (warnings fail), and TypeScript, including in CI. Use `npm run format` to format files and `npm run lint:fix` for safe lint autofixes; run lint autofix before formatting.

All generic and Effect rules from [anti-slop](https://github.com/dmmulroy/anti-slop) are enabled in `oxlint.config.ts`. The plugin is vendored in `tools/oxlint/anti-slop/`, with its source revision and licenses recorded there. Vendored rules, generated output and installed agent tooling are excluded from lint and formatting. Keep `oxlint` and `@oxlint/plugins` on the same exact version when upgrading.

## Verification

```sh
npm run check         # oxfmt, Oxlint + anti-slop, TypeScript
npm test              # config, tooling, login client, workerd and Effect lifecycle tests
npm run test:sandbox  # native Container + Files integration, requires Docker
npm run build         # deployment dry run including Docker image build
```

The ordinary tests stub OpenAI only. They run Hono, Durable Objects, SQLite, credential locking, Pi generation and the Codex SSE adapter in workerd, including crash recovery and duplicate prompt admission. Coordination tests exercise model-driven delegation and waiting, restart during a wait, inherited and overridden models, child-scoped messaging, recursive cancellation, depth/width/delivery limits, and unanswered child results. Effect tests cover interruption cleanup, permit release and TestClock-driven expiry. The login client runs against an authenticated loopback fixture. Container integration checks actual execution, file reads and isolation. The current Vitest plugin only prepares native containers through its legacy loader, so sandbox tests generate an ignored `.sandbox-test.wrangler.json` from `cloudflare.config.ts` using Cloudflare's converter. This is test-only compatibility output, not another configuration source. Access tests generate RSA keys and verify signed JWTs against a fixture JWKS, including rejection of missing configuration, forged signatures, wrong issuers/audiences and expired tokens. The login-client fixture verifies both Access service headers without exposing them. No test uses a real subscription or creates a Cloudflare Access policy. A successful live login and model/tool round trip remain the final deployment smoke test.

## References

- [Pi Durable Cloudflare example](https://github.com/earendil-works/pi-durable-cloudflare), for Durable Object SQLite storage and alarm-driven recovery.
- [Cloudflare Sandbox SDK](https://github.com/cloudflare/sandbox-sdk), for the 1.0 native Container API and `Files` integration.
- [Open Session device login](https://github.com/tellahq/opensession/blob/main/packages/core/opensession-server/src/server/codex-device-login.ts) and [refresh ownership](https://github.com/tellahq/opensession/blob/main/packages/core/opensession-server/src/server/codex-token-refresh.ts), for subscription sign-in and token rotation constraints. That server uses the Codex CLI; this Worker implements the headless device protocol and delegates refresh and model requests to Pi's Codex provider.
