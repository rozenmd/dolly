import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceApp } from "../workspace-app";

export const Route = createFileRoute("/")({ component: WorkspaceApp });
