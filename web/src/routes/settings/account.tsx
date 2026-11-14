import { createFileRoute } from "@tanstack/react-router";
import { AccountSettings } from "../../components/settings";

export const Route = createFileRoute("/settings/account")({ component: AccountSettings });
