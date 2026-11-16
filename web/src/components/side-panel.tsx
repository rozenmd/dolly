import type { CSSProperties, ReactNode } from "react";
import type { SidePanel as SidePanelState } from "../lib/side-panel";
import { IconButton } from "./ui";

export const sidePanelId = "session-side-panel";

/** Keyboard resize step for the panel's edge, in pixels. */
const nudgeStep = 24;

function SidebarRightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M15 4.5v15" />
    </svg>
  );
}

/**
 * The side panel's open/close button. The header shows it while the panel is
 * closed; the panel's own top row shows it while open, so it stays in the
 * window's top-right corner instead of riding the conversation's edge.
 */
export function SidePanelToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <IconButton
      label="Toggle side panel"
      aria-controls={open ? sidePanelId : undefined}
      aria-expanded={open}
      onClick={onClick}
    >
      <SidebarRightIcon />
    </IconButton>
  );
}

/**
 * A full-height column on the right of the window, beside the conversation and
 * its header rather than under them. It is resizable from its left edge on
 * wide windows, and from 920px down becomes an overlay with a scrim behind it.
 */
export function SidePanel({
  panel,
  label,
  children,
}: {
  panel: SidePanelState;
  label: string;
  children: ReactNode;
}) {
  // SAFETY: React's CSSProperties has no index signature for custom properties;
  // --panel-w is a plain length string the stylesheet reads.
  const style = (panel.width ? { "--panel-w": `${panel.width}px` } : undefined) as
    | CSSProperties
    | undefined;

  return (
    <>
      <div className="side-panel-scrim" aria-hidden="true" onClick={() => panel.setOpen(false)} />
      <aside
        id={sidePanelId}
        className={`side-panel ${panel.entering ? "entering" : ""}`}
        aria-label={label}
        style={style}
      >
        <div
          className="side-panel-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize side panel"
          tabIndex={0}
          onPointerDown={panel.startResize}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") panel.nudge(nudgeStep);
            else if (event.key === "ArrowRight") panel.nudge(-nudgeStep);
            else return;
            event.preventDefault();
          }}
        />
        <div className="side-panel-top">
          <SidePanelToggle open onClick={() => panel.setOpen(false)} />
        </div>
        <div className="side-panel-body">{children}</div>
      </aside>
    </>
  );
}
