import { createFileRoute } from "@tanstack/react-router";
import { SlackSettings } from "../../components/settings";

export const Route = createFileRoute("/settings/slack")({ component: SlackSettings });
