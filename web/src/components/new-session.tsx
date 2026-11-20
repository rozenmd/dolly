import { useEffect, useRef, useState, type FormEvent } from "react";
import * as Schema from "effect/Schema";
import {
  defaultModel,
  request,
  Session,
  type ApiBody,
  type DefaultModel,
  type SavedSession,
} from "../lib/api";
import { Input, Modal, Textarea } from "./ui";
import { ArrowUturnLeftIcon } from "@heroicons/react/16/solid";
import { DEFAULT_EFFORT, ModelControl, normalizeEffort, type Speed } from "./model-select";
import { RepositoryPicker } from "./repositories";
import { AttachButton, AttachmentTray, useAttachmentInput } from "./attachments";
import { imagesBody, type Attachment } from "../lib/images";

/** Create the conversation only on submit; retries reuse both its ID and prompt receipt. */
export function NewSessionComposer({
  initial,
  workspace,
  onClose,
  onImport,
  onSaved,
  onCreated,
}: {
  initial: ApiBody;
  /** The workspace the session joins; without one it starts a new workspace. */
  workspace?: { id: string; title: string } | undefined;
  onClose: () => void;
  onImport: () => void;
  onSaved: (session: SavedSession) => void;
  onCreated: (session: SavedSession) => void;
}) {
  const [content, setContent] = useState("");
  const [repository, setRepository] = useState(initial.workspace?.repository ?? "");
  const [ref, setRef] = useState(initial.workspace?.ref ?? "");
  // Empty pushes to the session's own dolly/session-<id> branch.
  const [branch, setBranch] = useState("");
  const [model, setModel] = useState(initial.model ?? "");
  const [defaults, setDefaults] = useState<DefaultModel | null>(null);
  // `null` follows the owner's defaults until a choice is made here.
  const [chosenEffort, setEffort] = useState<string | null>(initial.thinkingLevel ?? null);
  const [chosenSpeed, setSpeed] = useState<Speed | null>(null);
  const [chosenFallback, setAutoFallback] = useState<boolean | null>(null);

  // Shown and sent as the model accepts it: an unsupported level becomes High.
  const effort = normalizeEffort(
    model || defaults?.effective || "",
    chosenEffort ?? defaults?.thinkingLevel ?? DEFAULT_EFFORT,
  );

  const speed = chosenSpeed ?? defaults?.speed ?? "standard";
  const autoFallback = chosenFallback ?? defaults?.autoFallback ?? true;

  const matchesDefaults =
    defaults !== null &&
    effort === defaults.thinkingLevel &&
    speed === defaults.speed &&
    autoFallback === defaults.autoFallback;

  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<SavedSession | null>(null);
  const requestId = useRef<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const input = useAttachmentInput(
    attachments,
    setAttachments,
    setError,
    pending || Boolean(created),
  );

  useEffect(() => {
    let active = true;
    defaultModel().then(
      (setting) => {
        if (active) setDefaults(setting);
      },
      () => {},
    );

    return () => {
      active = false;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();

    if (pending || input.reading || (!content.trim() && !attachments.length)) return;
    setPending(true);
    setError("");

    try {
      let session = created;

      if (!session) {
        const body: ApiBody = {};

        if (workspace) body.workspaceId = workspace.id;

        if (model) body.model = model;
        body.thinkingLevel = effort;
        body.speed = speed;
        body.autoFallback = autoFallback;

        if (repository) {
          body.workspace = { repository };

          if (branch.trim()) body.workspace.branch = branch.trim();
          // A push branch is checked out from itself, not the repository's default branch.
          else if (ref) body.workspace.ref = ref;

          if (repository === initial.workspace?.repository && initial.workspace.networkHosts)
            body.workspace.networkHosts = initial.workspace.networkHosts;
        }

        const result = Schema.decodeUnknownSync(Schema.fromJsonString(Session))(
          await request("/sessions", body),
        );

        session = {
          ...result,
          title: content.trim().split("\n")[0].slice(0, 80) || "Screenshot",
          repository,
          ref,
          updatedAt: Date.now(),
          createdAt: Date.now(),
        };
        setCreated(session);
        // Keep a recoverable link even if prompt admission fails or the dialog is closed.
        onSaved(session);
      }

      requestId.current ??= crypto.randomUUID();
      await request(`/sessions/${encodeURIComponent(session.id)}/messages`, {
        content: content.trim(),
        requestId: requestId.current,
        ...imagesBody(attachments),
      });
      onCreated(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the session.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      title={workspace ? `New session in ${workspace.title || "this workspace"}` : "New session"}
      className="new-session-modal"
      bare
      onClose={onClose}
    >
      <form
        className="new-session-form"
        onSubmit={(event) => void submit(event)}
        onDragOver={input.onDragOver}
        onDrop={input.onDrop}
      >
        <fieldset
          disabled={pending || input.reading || Boolean(created)}
          className="new-session-fields"
        >
          <div className="new-session-target">
            <RepositoryPicker
              compact
              value={repository}
              onChange={(name, defaultBranch) => {
                setRepository(name);
                setRef(defaultBranch);
                setBranch("");
              }}
            />
            {repository && (
              <>
                <label htmlFor="new-session-branch" className="sr-only">
                  Push branch
                </label>
                <Input
                  id="new-session-branch"
                  name="branch"
                  className="new-session-branch"
                  placeholder="Push to existing branch (optional)"
                  title="Check out this branch and push to it instead of a new dolly/session branch. Never the default branch."
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={200}
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                />
              </>
            )}
          </div>
          <label htmlFor="new-session-prompt" className="sr-only">
            Task
          </label>
          <Textarea
            id="new-session-prompt"
            name="content"
            placeholder="What do you want to work on?"
            autoFocus
            maxLength={16384}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            onPaste={input.onPaste}
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
          <AttachmentTray
            attachments={attachments}
            onRemove={(id) => setAttachments(attachments.filter((item) => item.id !== id))}
          />
        </fieldset>
        {error && (
          <p role="alert" className="error-text">
            {error}
            {created ? " Your session is saved. Retry to send this task." : ""}
          </p>
        )}
        <div className="composer-toolbar">
          <div className="composer-tools">
            <AttachButton
              disabled={pending || input.reading || Boolean(created)}
              count={attachments.length}
              onFiles={(files) => void input.add(files)}
            />
            <button type="button" className="ghost-button" disabled={pending} onClick={onImport}>
              Open existing
            </button>
          </div>
          <ModelControl
            id="new-session-model"
            model={model}
            effort={effort}
            speed={speed}
            autoFallback={autoFallback}
            defaultModel={defaults?.effective ?? null}
            placement="above"
            disabled={pending || Boolean(created)}
            isDefault={matchesDefaults && (!model || model === defaults?.effective)}
            atDefault={matchesDefaults && !model}
            onModel={setModel}
            onEffort={setEffort}
            onSpeed={setSpeed}
            ultrafastAvailable={defaults?.ultrafastAvailable ?? false}
            onAutoFallback={setAutoFallback}
            onSetDefault={() =>
              void defaultModel({
                // "Default" keeps following the saved default model.
                ...(model && { model }),
                thinkingLevel: effort,
                speed,
                autoFallback,
              }).then(setDefaults, (cause: unknown) =>
                setError(cause instanceof Error ? cause.message : "Could not save the defaults."),
              )
            }
            onReset={() => {
              setModel("");
              setEffort(null);
              setSpeed(null);
              setAutoFallback(null);
            }}
          />
          <button
            type="submit"
            className="create-button"
            disabled={pending || input.reading || (!content.trim() && !attachments.length)}
            aria-keyshortcuts="Meta+Enter Control+Enter"
          >
            {pending ? "Starting…" : created ? "Retry" : "Create"}
            {!pending && <ArrowUturnLeftIcon className="create-enter" aria-hidden="true" />}
          </button>
        </div>
      </form>
    </Modal>
  );
}
