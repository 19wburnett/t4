import { createFileRoute } from "@tanstack/react-router";
import { CompanySettings } from "../components/settings/CompanySettings";

export const Route = createFileRoute("/_chat/settings/company")({
  component: CompanySettings,
});
