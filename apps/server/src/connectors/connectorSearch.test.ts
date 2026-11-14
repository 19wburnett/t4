import { describe, expect, it } from "@effect/vitest";
import { ConnectorId } from "@t3tools/contracts";

import { searchConnectorTools } from "./connectorSearch.ts";

const connectors = [
  {
    id: ConnectorId.make("linear-1a2b"),
    name: "Linear",
    tools: [
      { name: "create_issue", description: "Create an issue in a team", readOnly: false },
      { name: "list_projects", description: "List projects", readOnly: true },
    ],
  },
  {
    id: ConnectorId.make("stripe-3c4d"),
    name: "Stripe",
    tools: [{ name: "list_invoices", description: "List customer invoices", readOnly: true }],
  },
];

const names = (query: string, limit = 10) =>
  searchConnectorTools(connectors, query, limit).map((tool) => `${tool.connectorId}:${tool.name}`);

describe("searchConnectorTools", () => {
  it.each([
    ["", ["linear-1a2b:create_issue", "linear-1a2b:list_projects", "stripe-3c4d:list_invoices"]],
    ["invoice", ["stripe-3c4d:list_invoices"]],
    ["linear", ["linear-1a2b:create_issue", "linear-1a2b:list_projects"]],
    // More matched words rank higher: "customer" is only in the invoices description.
    ["customer list", ["stripe-3c4d:list_invoices", "linear-1a2b:list_projects"]],
    ["calendar", []],
  ])("%j", (query, expected) => {
    expect(names(query)).toEqual(expected);
  });

  it("stops at the limit", () => {
    expect(names("", 1)).toEqual(["linear-1a2b:create_issue"]);
  });
});
