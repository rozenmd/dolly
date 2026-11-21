# Dolly

**Send a prompt. Close the tab. Come back to a pull request.**

Dolly is a coding agent you host on your own Cloudflare account. Every conversation gets its own Linux sandbox with a fresh checkout of your repo. Agents keep working after you walk away, and you can pick them up from your laptop, your phone, Slack or a PR comment.

It runs on the ChatGPT or Claude subscription you already pay for. You don't need an API key, and there's no per-token bill.

## Juggle less

- Every session gets its own computer: each conversation has its own container, checkout and branch. No worktrees, no port conflicts, no "which terminal was that in?"

- Close your laptop: sessions run on Cloudflare, not in your terminal. Work survives restarts, and your files are saved at the end of every turn.

- Start from anywhere: use the web app, a Slack DM or @-mention, or comment `/dolly fix the failing test` on a pull request. Turn on **Review new pull requests** in Settings > GitHub and Dolly reviews each new PR and each push with inline comments; findings on a PR a Dolly session opened go back to that session to fix. Your sessions show up on every device you sign in from.

- Direct a team: agents can start child agents, each in its own sandbox, and wait for their results.

- Let it check back on its own: agents schedule their own follow-ups and wait on CI. "Push it and tell me when checks pass" is one prompt.

- Bring your tools: add remote MCP servers (Linear, Sentry, your own) in Settings > Connections, signing in with OAuth or an API key. Sessions you start from the web app can call them (Slack, GitHub and review sessions can't), servers must use HTTPS, and their credentials stay in the Worker.

## Ask for proof

Dolly can start your dev server inside its sandbox, open the page in a real browser, take a screenshot and attach it to the PR. You review what it built, not just what it says it built.

## Ship more

Ask in Slack, check the screenshot on your phone and merge from GitHub. Dolly opens the PR, and you decide what lands. By design, it can't push to your default branch or merge anything.

## Yours, not ours

- It deploys to your Cloudflare account, behind Cloudflare Access and GitHub sign-in.
- Your model and GitHub credentials stay in the Worker. Sandboxes never see them, and they can only reach the hosts you allow.
- If one subscription runs out mid-task, Dolly can switch to your other one and finish the turn.

## Get started

You need Node.js 24, pnpm 12, Docker, a paid Cloudflare Workers account and Cloudflare Zero Trust. See [What you need](docs/setup.md#1-what-you-need).

1. Install and log in to Cloudflare ([guide](docs/setup.md#2-install-and-log-in-to-cloudflare)):

       pnpm install --frozen-lockfile
       pnpm exec cf auth login

2. Set up Cloudflare Access. Copy `infra/.env.example` to `infra/.env` and fill in its values, then plan and deploy ([guide](docs/setup.md#3-set-up-cloudflare-access)):

       cp infra/.env.example infra/.env
       pnpm access:plan
       pnpm access:deploy

3. Deploy the main Worker and the ingress Worker ([guide](docs/setup.md#4-deploy-the-workers)):

       pnpm run deploy
       pnpm --dir ingress run deploy

4. Open your Worker's URL. Setup walks you through creating the GitHub App, signing in, connecting ChatGPT or Claude and choosing repositories ([guide](docs/setup.md#5-first-run-setup-in-the-browser)).

To connect Slack or use Claude, see [Connect Slack](docs/setup.md#6-optional-connect-slack) and [Use Claude instead of ChatGPT](docs/setup.md#7-optional-use-claude-instead-of-chatgpt).

## Status

Dolly is early. Right now it has a single owner: the first GitHub account to sign in owns the deployment. Slack replies arrive when the agent finishes its turn, not as it works.
