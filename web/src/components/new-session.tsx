import { useRef, useState, type FormEvent } from "react";
import * as Schema from "effect/Schema";
import { request, Session, type ApiBody, type SavedSession } from "../lib/api";
import { Modal, Select, Textarea } from "./ui";
import { RepositoryPicker } from "./repositories";

/** Create the conversation only on submit; retries reuse both its ID and prompt receipt. */
export function NewSessionComposer({
  initial,
  onClose,
  onImport,
  onSaved,
  onCreated,
}: {
  initial: ApiBody;
  onClose: () => void;
  onImport: () => void;
  onSaved: (session: SavedSession) => void;
  onCreated: (session: SavedSession) => void;
}) {
  const [content, setContent] = useState("");
  const [repository, setRepository] = useState(initial.workspace?.repository ?? "");
  const [ref, setRef] = useState(initial.workspace?.ref ?? "");
  const [model, setModel] = useState(initial.model ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<SavedSession | null>(null);
  const requestId = useRef<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();

    if (pending || !content.trim()) return;
    setPending(true);
    setError("");

    try {
      let session = created;

      if (!session) {
        const body: ApiBody = {};

        if (model) body.model = model;

        if (repository) {
          body.workspace = { repository };

          if (ref) body.workspace.ref = ref;

          if (repository === initial.workspace?.repository && initial.workspace.networkHosts)
            body.workspace.networkHosts = initial.workspace.networkHosts;
        }

        const result = Schema.decodeUnknownSync(Schema.fromJsonString(Session))(
          await request("/sessions", body),
        );

        session = {
          ...result,
          title: content.trim().split("\n")[0].slice(0, 80),
          repository,
          ref,
          updatedAt: Date.now(),
        };
        setCreated(session);
        // Keep a recoverable link even if prompt admission fails or the dialog is closed.
        onSaved(session);
      }

      requestId.current ??= crypto.randomUUID();
      await request(`/sessions/${encodeURIComponent(session.id)}/messages`, {
        content: content.trim(),
        requestId: requestId.current,
      });
      onCreated(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the session.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal title="New session" className="new-session-modal" onClose={onClose}>
      <form className="new-session-form" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={pending || Boolean(created)} className="new-session-fields">
          <label htmlFor="repository" className="sr-only">
            Repository
          </label>
          <RepositoryPicker
            compact
            value={repository}
            onChange={(name, branch) => {
              setRepository(name);
              setRef(branch);
            }}
          />
          <label htmlFor="new-session-prompt" className="sr-only">
            Task
          </label>
          <Textarea
            id="new-session-prompt"
            name="content"
            placeholder="What would you like to work on?"
            autoFocus
            required
            maxLength={16384}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
        </fieldset>
        {error && (
          <p role="alert" className="error-text">
            {error}
            {created ? " Your session is saved. Retry to send this task." : ""}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="ghost-button" disabled={pending} onClick={onImport}>
            Open existing
          </button>
          <label htmlFor="new-session-model" className="sr-only">
            Model
          </label>
          <Select
            id="new-session-model"
            name="model"
            value={model}
            disabled={pending || Boolean(created)}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="">Server default</option>
            <option value="gpt-6-sol">GPT-6 Sol</option>
            <option value="gpt-6-luna">GPT-6 Luna</option>
            <option value="gpt-6.1-terra">GPT-6.1 Terra</option>
          </Select>
          <button type="submit" className="primary-button" disabled={pending || !content.trim()}>
            {pending ? "Starting…" : created ? "Retry" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
