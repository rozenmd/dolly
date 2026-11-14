import { createFileRoute } from "@tanstack/react-router";
import { ModelsSettings } from "../../components/settings";

export const Route = createFileRoute("/settings/models")({ component: ModelsSettings });
