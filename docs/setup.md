# Set up Dolly

This guide takes you from a fresh clone to your first agent session.

## 1. What you need

1. Node.js 24.
2. pnpm 12.
3. Docker. Docker must be running when you deploy.
4. A Cloudflare account on the Workers Paid plan, with R2 turned on.
5. A Cloudflare Zero Trust organization. The free plan is sufficient.

**Check:** these commands show a version and do not fail:

```sh
node --version
pnpm --version
docker info
```

## 2. Install and log in to Cloudflare

1. Clone the repository and go into it.
2. Install the dependencies:

   ```sh
   pnpm install --frozen-lockfile
   ```

3. Log in to Cloudflare. A browser window opens. Approve the login there.

   ```sh
   pnpm exec cf auth login
   ```

**Check:** this command shows your account:

```sh
pnpm exec cf auth whoami
```

## 3. Set up Cloudflare Access

1. In the Zero Trust dashboard, go to **Access > Service Auth**. Create a service token.
2. Copy the example file:

   ```sh
   cp infra/.env.example infra/.env
   ```

3. Open `infra/.env` and set these values:
   - `DOLLY_ACCESS_HOSTNAME`: the address of the main Worker, `dolly.<your-subdomain>.workers.dev`. Your `workers.dev` subdomain is on the **Workers & Pages** page of the dashboard.
   - `DOLLY_ACCESS_TEAM_DOMAIN`: your Zero Trust team domain, `<your-team>.cloudflareaccess.com`.
   - `DOLLY_ACCESS_EMAILS`: the email addresses that can open Dolly, separated by commas.
   - `DOLLY_ACCESS_SERVICE_TOKEN_ID`: the ID of the service token from step 1. Use the UUID, not the client ID.
   - `DOLLY_ACCESS_APPLICATION_ID`: leave this commented out, unless you already have an Access application for this hostname. Then set it to that application's UUID.
4. Show the changes before you make them:

   ```sh
   pnpm access:plan
   ```

   The first time, the command asks how to log in to Cloudflare. Choose the browser login, then choose your account.

5. Make the changes:

   ```sh
   pnpm access:deploy
   ```

**Check:** the last line of the output is `Exported Access settings for <your hostname>; redeploy the main Worker.` The file `infra/access.generated.json` exists.

## 4. Deploy the Workers

1. Make sure that Docker is running.
2. Deploy the main Worker:

   ```sh
   pnpm run deploy
   ```

3. Deploy the ingress Worker. It receives events from GitHub and Slack.

   ```sh
   pnpm --dir ingress run deploy
   ```

4. Write down the ingress Worker URL from the output. You need it in step 5.

**Check:** open `https://<DOLLY_ACCESS_HOSTNAME>`. The Cloudflare Access login page opens. Enter one of the emails from `DOLLY_ACCESS_EMAILS`, then enter the code that you get by email. The **Set up dolly** page opens.

## 5. First-run setup in the browser

Do these steps on your Dolly page.

### Create the GitHub App

1. Choose **Personal account** or **Organization**.
2. Enter your GitHub username or the organization name.
3. Make sure that **Ingress URL** is the ingress Worker URL from step 4.
4. Choose **Create GitHub App**. GitHub opens.
5. On GitHub, create the app.

**Check:** GitHub sends you back to Dolly. The **Sign in to dolly** page opens.

### Turn on device flow

1. Choose the **its settings** link on the sign-in page. The GitHub App settings open.
2. Select **Enable Device Flow**, then save.

### Sign in

1. Choose **Sign in with GitHub**. Dolly shows a code.
2. Choose **Open GitHub**. Enter the code and authorize the app.
3. Go back to Dolly.

The first GitHub account that signs in owns this Dolly.

**Check:** the **Get dolly ready** checklist opens.

### Connect ChatGPT or Claude

1. On **Connect a model**, choose **Connect**.
2. Choose **Sign in with ChatGPT**, then **Open ChatGPT**.
3. Approve Dolly in ChatGPT. ChatGPT then opens a page that does not load.
4. Copy the full address of that page. Paste it into Dolly and choose **Connect**.

To use Claude instead, see [step 7](#7-optional-use-claude-instead-of-chatgpt).

**Check:** **Connect a model** shows a check mark.

### Install the GitHub App

1. On **Install the GitHub App**, choose **Install**. GitHub opens.
2. Choose the accounts and repositories that Dolly can use.
3. Go back to Dolly.
4. On **Allow accounts**, choose **Allow** for each account.

**Check:** **Install the GitHub App** and **Allow accounts** show check marks.

### Choose repositories

1. On **Enroll repositories**, choose **Choose**.
2. Choose **Enroll** next to each repository that you want to use.

**Check:** go back to the main page. The checklist is gone, and you see **New session**. Choose it, pick a repository and send a prompt. This is your first agent session.

### Optional: review new pull requests

Automatic reviews are an automation, after Open Session's `github-pr-review` recipe.

1. Go to **Settings > GitHub**. Under **Who can run /dolly commands**, list the GitHub users whose pull requests Dolly reviews, then choose **Save**.
2. Go to **Settings > Automations** and choose **New automation**.
3. Pick the **Review pull requests** recipe. Its prompt is Open Session's review instructions: edit it to say what reviews should look for in your codebase, and pick the model reviews run on. Choose **Create automation**.

When one of those users or a Dolly session opens a pull request in an enrolled repository, marks a draft ready, or pushes to it, Dolly reviews it with inline comments. Pull requests opened by other bots are skipped. It skips drafts and pull requests from forks. Comment `/dolly` on the pull request to follow up in the same session. Each review uses your model subscription, and every push gets its own review.

Each review is a run of the automation: its sessions are listed under **Recent runs**. The prompt only says what to look for; Dolly adds the pull request, the previous review's digest, how to publish the review and the verdict the loop reads, so an edit can't break the loop. There is at most one pull request automation, and it can't have a schedule, a repository, MCP servers or a webhook URL, or be run by hand.

Reviews follow Open Session's reviewer. Each push is reviewed in a fresh read-only session and checkout of exactly that commit, with the PR's description and conversation for context. A re-review also gets a digest of the previous one: its verdict, which of its comments were addressed, are still open or got pushback, and what changed since. Reviews of one pull request run one at a time, and a review whose head moves on before it finishes is never posted.

If a Dolly session opened the pull request, the review loop is on. When the review finds a P0 or P1 problem, or finds problems and rates the change below 4/5, the open review feedback goes back to the session that opened the PR. That session fixes it and pushes, and the push is reviewed again. The loop stops when a review is satisfied or after 6 fix rounds; at the cap, Dolly comments on the PR, the session writes a short wrap-up, and the PR is left to you. A review that passes with non-blocking findings sends the session one notice for that commit. Findings only go back to sessions started in the web app that aren't archived, and only when the PR's branch is the session's own working branch. The session gets open feedback from trusted authors only (Dolly, the users listed above, and installed GitHub Apps), marked as evidence to check rather than instructions; other people's comments are never handed over. To stop the loop, pause the automation: queued reviews are skipped and finished ones aren't handed back.

If creating or resuming the automation reports that pull request events are missing, open the GitHub App settings, subscribe to **Pull request** events, and approve the change on each installation.

If you had **Review new pull requests** turned on in Settings > GitHub before reviews became an automation, Dolly created the **Review pull requests** automation for you, on the review model you had chosen under Models.

## 6. Optional: connect Slack

1. In Dolly, go to **Settings > Slack**.
2. Choose **Create Slack app**. Slack opens.
3. Choose your workspace, then **Next**, then **Create**.
4. In the Slack app, open **Install App**. Choose **Install to Workspace**.
5. Copy the **Bot User OAuth Token**. Paste it into **Bot token** in Dolly.
6. In the Slack app, open **Basic Information > App Credentials**. Copy the **Signing Secret**. Paste it into **Signing secret** in Dolly.
7. Optional: enter a **Default repository**, as `owner/repo`.
8. Choose **Save**.
9. In the Slack app, open **Event Subscriptions**. Choose **Retry** next to the events URL.
10. Invite the bot to the channels that it must read.
11. Under **Teammates**, choose **Add Slack ID** next to each person who may start sessions, or **Add teammate** for someone else. In Slack, open their profile, choose **⋮**, then **Copy member ID**. While nobody has a Slack member ID, everyone in the workspace can start sessions.

**Check:** Dolly shows **Connected to** your workspace. Send the bot a DM. Dolly replies in the thread.

## 7. Optional: use Claude instead of ChatGPT

1. Install Claude Code on your computer.
2. Make a setup token:

   ```sh
   claude setup-token
   ```

3. In Dolly, open the **Connect a model** window. Choose **Use Claude instead**. You can also go to **Settings > Models** and choose **Connect** next to Claude.
4. Paste the token into **Claude setup token**. Choose **Save token**.
5. To make Claude the default, go to **Settings > Models**. Set **Default model** to a Claude model.

**Check:** **Settings > Models** shows Claude as **Connected**. Choose **Test**. The result shows that the request succeeded.
