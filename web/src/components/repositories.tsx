import { useEffect, useState } from "react";
import * as Schema from "effect/Schema";
import { request } from "../lib/api";
import { ArrowPathIcon, ChatBubbleLeftIcon, PlusIcon } from "@heroicons/react/16/solid";
import { Input, RepoBadge, Select } from "./ui";
import { Picker } from "./picker";

const shortName = (repository: string) => repository.split("/").at(-1) ?? repository;

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
          {compact ? (
            <Picker
              id="repository"
              label="Repository"
              className="repository-menu"
              value={value ?? ""}
              disabled={loading || disabled}
              options={[
                ...repositories.map((repo) => ({
                  value: repo.fullName,
                  label: shortName(repo.fullName),
                  hint: repo.fullName.split("/")[0],
                  icon: <RepoBadge repository={repo.fullName} />,
                })),
                ...(value && !repositories.some((repo) => repo.fullName === value)
                  ? [{ value, label: shortName(value), icon: <RepoBadge repository={value} /> }]
                  : []),
                {
                  value: "",
                  label: "No repo",
                  icon: <ChatBubbleLeftIcon className="picker-icon" aria-hidden="true" />,
                },
              ]}
              onChange={(name) => {
                const repo = repositories.find((item) => item.fullName === name);
                onChange?.(repo?.fullName ?? name, repo?.defaultBranch ?? "");
              }}
              trigger={
                value ? (
                  <>
                    <RepoBadge repository={value} />
                    <span>{shortName(value)}</span>
                  </>
                ) : (
                  <span>{loading ? "Loading repositories…" : "No repo"}</span>
                )
              }
              footer={(close) => (
                <>
                  <button
                    type="button"
                    className="picker-action"
                    onClick={() => {
                      close();
                      setEnrolling(true);
                    }}
                  >
                    <PlusIcon className="picker-icon" aria-hidden="true" />
                    New repository…
                  </button>
                  <button
                    type="button"
                    className="picker-action"
                    onClick={() => {
                      close();
                      setRevision((current) => current + 1);
                    }}
                  >
                    <ArrowPathIcon className="picker-icon" aria-hidden="true" />
                    Refresh repositories
                  </button>
                </>
              )}
            />
          ) : (
            <Select
              id="repository"
              name="repository"
              value={value}
              disabled={loading || disabled}
              onChange={(event) => {
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
            </Select>
          )}
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
          <div className="repository-toolbar">
            <Input
              id="repository-search"
              aria-label="Find a repository"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search repositories"
            />
            <button
              type="button"
              className="icon-button repository-refresh"
              title="Refresh repositories"
              aria-label="Refresh repositories"
              disabled={loading || pending}
              onClick={() => setRevision((current) => current + 1)}
            >
              <ArrowPathIcon className={loading ? "spin" : undefined} aria-hidden="true" />
            </button>
          </div>
          <div className="repository-list" aria-busy={loading}>
            {loading && !repositories.length ? (
              <p role="status" className="repository-empty">
                Loading repositories…
              </p>
            ) : (
              repositories
                .filter((repo) => repo.fullName.toLowerCase().includes(query.toLowerCase()))
                .map((repo) => (
                  <div className="repository-row" key={repo.fullName}>
                    <RepoBadge repository={repo.fullName} />
                    <div className="repository-meta">
                      <span className="repository-name">
                        <span className="muted">{repo.fullName.split("/")[0]}/</span>
                        {shortName(repo.fullName)}
                      </span>
                      <span className="repository-detail">
                        {repo.private ? "Private" : "Public"} · {repo.defaultBranch}
                        {repo.description ? ` · ${repo.description}` : ""}
                      </span>
                    </div>
                    {repo.registered && <span className="repository-tag">Enrolled</span>}
                    <button
                      type="button"
                      className={repo.registered ? "ghost-button danger" : "secondary-button"}
                      disabled={pending}
                      onClick={() => void update(repo)}
                    >
                      {repo.registered ? "Remove" : "Enroll"}
                    </button>
                  </div>
                ))
            )}
            {!loading && !repositories.length && (
              <p className="repository-empty">No repositories available.</p>
            )}
          </div>
          <p className="field-help">
            Only repositories the GitHub App can access in allowed accounts appear here. Missing one?
            Use Add repositories above, then refresh.
          </p>
          {!manage && (
            <button type="button" className="ghost-button" onClick={() => setEnrolling(false)}>
              Back to enrolled repositories
            </button>
          )}
        </>
      )}
      {((!compact && !enrolling) || error) && (
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
