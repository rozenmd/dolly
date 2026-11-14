import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceApp } from "../workspace-app";

// Pathless layout, so the workspace stays mounted while moving between `/` and `/settings`.
export const Route = createFileRoute("/_app")({ component: WorkspaceApp });
