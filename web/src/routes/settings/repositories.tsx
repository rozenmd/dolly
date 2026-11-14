import { createFileRoute } from "@tanstack/react-router";
import { RepositoriesSettings } from "../../components/settings";

export const Route = createFileRoute("/settings/repositories")({ component: RepositoriesSettings });
