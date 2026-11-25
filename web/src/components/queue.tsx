import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowUpIcon, Bars2Icon, PencilIcon, TrashIcon } from "@heroicons/react/16/solid";
import type { QueuedMessage } from "../lib/api";

/** Move `id` to `index`, keeping the others in order. */
function moved(items: readonly QueuedMessage[], id: number, index: number) {
  const item = items.find((candidate) => candidate.id === id);

  if (!item) return [...items];
  const rest = items.filter((candidate) => candidate.id !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, item);

  return rest;
}

const sameOrder = (a: readonly QueuedMessage[], b: readonly QueuedMessage[]) =>
  a.length === b.length && a.every((item, index) => item.id === b[index]?.id);

/**
 * Messages waiting for the running turn to finish. They go to the agent together as its next
 * turn, in this order. Each can be edited back into the composer (text the owner typed), deleted,
 * or sent now: folded into the running turn at its next step. Drag a row's handle to reorder, or
 * focus the handle and use the arrow keys.
 */
export function MessageQueue({
  queued,
  disabled,
  onSteer,
  onEdit,
  onDelete,
  onReorder,
}: {
  queued: readonly QueuedMessage[];
  disabled: boolean;
  onSteer: (id: number) => void;
  onEdit: (id: number) => void;
  onDelete: (id: number) => void;
  /** Resolves false when the server refused the order, which puts the shown order back. */
  onReorder: (order: readonly number[]) => Promise<boolean>;
}) {
  // The order shown: the server's, or the one being dragged until the server catches up.
  const [local, setLocal] = useState<readonly QueuedMessage[] | null>(null);
  const [dragging, setDragging] = useState<number>();
  const rows = useRef(new Map<number, HTMLLIElement>());
  const shown = local ?? queued;

  // A new queue from the server is its word: drop the local order unless a drag is still going.
  const serverOrder = queued.map((item) => item.id).join();

  const draggingNow = useRef(dragging);
  draggingNow.current = dragging;

  useEffect(() => {
    if (draggingNow.current === undefined) setLocal(null);
  }, [serverOrder]);

  if (queued.length === 0) return null;

  const reorderable = queued.length > 1 && !disabled;

  function commit(next: readonly QueuedMessage[]) {
    if (sameOrder(next, queued)) {
      setLocal(null);

      return;
    }

    setLocal(next);
    void onReorder(next.map((item) => item.id)).then((saved) => {
      if (!saved) setLocal(null);
    });
  }

  function start(event: PointerEvent<HTMLButtonElement>, id: number) {
    if (!reorderable || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(id);
    setLocal(shown);
  }

  function move(event: PointerEvent<HTMLButtonElement>) {
    if (dragging === undefined || !local) return;

    // The row whose middle the pointer has passed sets the dragged row's new place.
    const others = local.filter((item) => item.id !== dragging);

    const index = others.filter((item) => {
      const rect = rows.current.get(item.id)?.getBoundingClientRect();

      return rect !== undefined && event.clientY > rect.top + rect.height / 2;
    }).length;

    const next = moved(local, dragging, index);

    if (!sameOrder(next, local)) setLocal(next);
  }

  function end() {
    if (dragging === undefined) return;
    setDragging(undefined);

    if (local) commit(local);
  }

  function key(event: KeyboardEvent<HTMLButtonElement>, id: number) {
    if (!reorderable || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const index = shown.findIndex((item) => item.id === id);
    const target = event.key === "ArrowUp" ? index - 1 : index + 1;

    if (target < 0 || target >= shown.length) return;
    commit(moved(shown, id, target));
  }

  const count = queued.length;

  return (
    <section className="message-queue" aria-label="Queued messages">
      <h2>
        {count} {count === 1 ? "message" : "messages"} queued
      </h2>
      <ul>
        {shown.map((item, index) => (
          <li
            key={item.id}
            ref={(element) => {
              if (element) rows.current.set(item.id, element);
              else rows.current.delete(item.id);
            }}
            className={item.id === dragging ? "dragging" : undefined}
          >
            {reorderable && (
              <button
                type="button"
                className="queue-handle"
                aria-label={`Reorder: ${index + 1} of ${shown.length}`}
                title="Drag to reorder"
                onPointerDown={(event) => start(event, item.id)}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
                onKeyDown={(event) => key(event, item.id)}
              >
                <Bars2Icon aria-hidden="true" />
              </button>
            )}
            <p title={item.text}>{item.text}</p>
            <div className="queue-actions">
              {item.editable && (
                <button
                  type="button"
                  className="queue-action"
                  disabled={disabled}
                  aria-label="Edit in composer"
                  title="Edit in composer"
                  onClick={() => onEdit(item.id)}
                >
                  <PencilIcon aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className="queue-action danger"
                disabled={disabled}
                aria-label="Delete queued message"
                title="Delete queued message"
                onClick={() => onDelete(item.id)}
              >
                <TrashIcon aria-hidden="true" />
              </button>
              <button
                type="button"
                className="queue-action queue-steer"
                disabled={disabled}
                aria-label="Send now"
                title="Send now: add to the conversation and deliver after the current step"
                onClick={() => onSteer(item.id)}
              >
                <ArrowUpIcon aria-hidden="true" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
