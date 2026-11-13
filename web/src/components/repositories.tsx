import { useEffect, useState } from "react";
import * as Schema from "effect/Schema";
import { request } from "../lib/api";
import { Input, Select } from "./ui";

const Catalog = Schema.Struct({
  repositories: Schema.Array(
    Schema.Struct({
      fullName: Schema.String,
      defaultBranch: Schema.String,
      private: Schema.Boolean,
      description: Schema.NullOr(Schema.String),
      registered: Schema.optional(Schema.Boolean),
    }),
  ),
});

/** Registration is a workspace preference, not a replacement for GitHub authorization. */
export function RepositoryPicker({
  value,
  onChange,
  manage = false,
  compact = false,
  disabled = false,
}: {
  value?: string;
  onChange?: (repository: string, ref: string) => void;
  manage?: boolean;
  compact?: boolean;
  disabled?: boolean;
}) {
  const [repositories, setRepositories] = useState<typeof Catalog.Type.repositories>([]);
  const [enrolling, setEnrolling] = useState(manage);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    request(
      `/integrations/github/repositories${enrolling ? "?available=true" : ""}`,
      undefined,
      controller.signal,
    )
      .then((text) => {
        const result = Schema.decodeUnknownSync(Schema.fromJsonString(Catalog))(text);

        if (!controller.signal.aborted) setRepositories(result.repositories);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Could not load repositories.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [enrolling, revision]);

  async function update(repo: (typeof Catalog.Type.repositories)[number]) {
    setPending(true);
    setError("");

    try {
      await request(
        "/integrations/github/repositories",
        { repository: repo.fullName },
        undefined,
        repo.registered ? "DELETE" : "POST",
      );
      setRevision((current) => current + 1);

      if (!manage && !repo.registered) {
        onChange?.(repo.fullName, repo.defaultBranch);
        setEnrolling(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update repository enrolment.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="repository-picker">
      {!enrolling ? (
        <>
          <Select
            id="repository"
            name="repository"
            value={value}
            disabled={loading || disabled}
            onChange={(event) => {
              if (event.target.value === "__enroll__") return setEnrolling(true);

              if (event.target.value === "__refresh__")
                return setRevision((current) => current + 1);
              const repo = repositories.find((item) => item.fullName === event.target.value);
              onChange?.(repo?.fullName ?? "", repo?.defaultBranch ?? "");
            }}
          >
            <option value="">{loading ? "Loading repositories…" : "No repo"}</option>
            {value && !repositories.some((repo) => repo.fullName === value) && (
              <option value={value}>{value}</option>
            )}
            {repositories.map((repo) => (
              <option key={repo.fullName} value={repo.fullName}>
                {repo.fullName}
              </option>
            ))}
            {compact && <option value="__enroll__">New repository…</option>}
            {compact && <option value="__refresh__">Refresh repositories</option>}
          </Select>
          {!compact && (
            <button
              type="button"
              className="ghost-button"
              disabled={disabled}
              onClick={() => setEnrolling(true)}
            >
              Enroll a repository
            </button>
          )}
        </>
      ) : (
        <>
          <label htmlFor="repository-search">Find a repository</label>
          <Input
            id="repository-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search App repositories"
          />
          <p className="field-help">
            Only repositories available to the GitHub App in allowed accounts appear. Install the
            App and configure accounts in Settings, then refresh.
          </p>
          <div className="repository-list" aria-busy={loading}>
            {loading ? (
              <p role="status" className="muted">
                Loading repositories…
              </p>
            ) : (
              repositories
                .filter((repo) => repo.fullName.toLowerCase().includes(query.toLowerCase()))
                .map((repo) => (
                  <div className="repository-row" key={repo.fullName}>
                    <div>
                      <strong>{repo.fullName}</strong>
                      <p className="field-help">
                        {repo.private ? "Private" : "Public"} · {repo.defaultBranch}
                        {repo.description ? ` · ${repo.description}` : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={pending}
                      onClick={() => void update(repo)}
                    >
                      {repo.registered ? "Remove" : "Enroll"}
                    </button>
                  </div>
                ))
            )}
            {!loading && !repositories.length && (
              <p className="muted">No repositories available.</p>
            )}
          </div>
          {!manage && (
            <button type="button" className="ghost-button" onClick={() => setEnrolling(false)}>
              Back to enrolled repositories
            </button>
          )}
        </>
      )}
      {(!compact || enrolling || error) && (
        <button
          type="button"
          className="ghost-button"
          disabled={loading || pending}
          onClick={() => setRevision((current) => current + 1)}
        >
          Refresh repositories
        </button>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </div>
  );
}
