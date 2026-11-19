import { createFileRoute } from "@tanstack/react-router";

// A bare session link; the app rewrites it to the session's workspace URL once sessions load.
export const Route = createFileRoute("/_app/session/$sessionId")({});
