import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceApp } from "../workspace-app";

// One pathless layout for every session URL, so moving between sessions keeps the app mounted.
export const Route = createFileRoute("/_app")({ component: WorkspaceApp });
