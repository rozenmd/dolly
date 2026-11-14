import { createFileRoute } from "@tanstack/react-router";
import { GitHubSettings } from "../../components/settings";

export const Route = createFileRoute("/settings/github")({ component: GitHubSettings });
