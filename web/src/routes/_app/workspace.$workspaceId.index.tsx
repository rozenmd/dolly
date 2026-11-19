import { createFileRoute } from "@tanstack/react-router";

// A workspace link opens the session that started it.
export const Route = createFileRoute("/_app/workspace/$workspaceId/")({});
