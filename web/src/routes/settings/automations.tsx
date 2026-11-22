import { createFileRoute } from "@tanstack/react-router";
import { AutomationsSettings } from "../../components/automations";

export const Route = createFileRoute("/settings/automations")({ component: AutomationsSettings });
