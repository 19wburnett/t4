import { createFileRoute, redirect } from "@tanstack/react-router";

// The Company hub lives in Settings now; old links still land there.
export const Route = createFileRoute("/_chat/company/$projectKey")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/settings/company",
      search: { project: params.projectKey, machine: undefined, checkout: undefined },
    });
  },
});
