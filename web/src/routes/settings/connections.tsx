import { createFileRoute } from "@tanstack/react-router";
import { ConnectionsSettings } from "../../components/connections";

export const Route = createFileRoute("/settings/connections")({ component: ConnectionsSettings });
