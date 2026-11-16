/**
 * Commit attribution for agent work, matching Open Session's rules:
 * the GitHub App's bot user authors and commits every agent commit, and the
 * person behind the run is credited with a `Co-authored-by` trailer. No run
 * carries the person's own git identity, so nothing an agent commits can be
 * taken for something the person typed.
 */

export type GitIdentity = { readonly name: string; readonly email: string };

/** Sandbox env name carrying the `Co-authored-by` value (`Name <email>`) for the person behind the run. */
export const GIT_COAUTHOR_ENV = "DOLLY_GIT_COAUTHOR";

/** GitHub's noreply address, which links commits to the account that owns `id`. */
export function githubNoreplyIdentity(user: { readonly id: number; readonly login: string }) {
  return { name: user.login, email: `${user.id}+${user.login}@users.noreply.github.com` };
}

/**
 * Environment for agent shell commands. With a connected App, the bot is author and committer;
 * without one, the checkout's own git config decides. An identity without an email sets only
 * names: an empty GIT_AUTHOR_EMAIL would be written literally instead of falling back.
 */
export function agentGitIdentityEnv(bot: GitIdentity | null, coauthor: GitIdentity | null) {
  const env: Record<string, string> = {};

  if (bot?.name) {
    env.GIT_AUTHOR_NAME = bot.name;
    env.GIT_COMMITTER_NAME = bot.name;

    if (bot.email) {
      env.GIT_AUTHOR_EMAIL = bot.email;
      env.GIT_COMMITTER_EMAIL = bot.email;
    }
  }

  if (coauthor?.name && coauthor.email)
    env[GIT_COAUTHOR_ENV] = `${coauthor.name} <${coauthor.email}>`;

  return env;
}

/** The commit-trailer instruction. Like Open Session, the agent adds trailers itself; nothing rewrites messages. */
export function commitAttributionPrompt(coauthor: GitIdentity | null) {
  if (!coauthor?.name || !coauthor.email) return undefined;

  return [
    `Commit trailers: Co-authored-by: ${coauthor.name} <${coauthor.email}>`,
    "Add the commit trailers to every commit, including GitHub write_file commits, each on its own line at the end of the message after a blank line.",
  ].join("\n");
}
