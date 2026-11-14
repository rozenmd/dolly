import { createFileRoute } from "@tanstack/react-router";
import { SettingsLayout } from "../components/settings";

export const Route = createFileRoute("/settings")({ component: SettingsLayout });
