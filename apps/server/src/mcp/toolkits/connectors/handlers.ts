import { type ConnectorError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { searchConnectorTools } from "../../../connectors/connectorSearch.ts";
import * as Connectors from "../../../connectors/Connectors.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ConnectorsToolkit } from "./tools.ts";

const DEFAULT_SEARCH_LIMIT = 20;

const failure = (error: ConnectorError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "storage" || error.reason === "unreachable"
        ? "orchestration_error"
        : "invalid_request",
    message: error.message,
  });

export const layer = McpToolAccess.toLayer(ConnectorsToolkit, {
  t3_connectors_search: McpToolAccess.readsPrivate((input) =>
    Effect.gen(function* () {
      const connectors = yield* (yield* Connectors.Connectors).list;
      return {
        connectors: connectors.map(({ id, name, health }) => ({ id, name, health })),
        tools: searchConnectorTools(
          connectors,
          input.query ?? "",
          input.limit ?? DEFAULT_SEARCH_LIMIT,
        ),
      };
    }).pipe(Effect.mapError(failure)),
  ),
  t3_connector_tool: McpToolAccess.readsPrivate((input) =>
    Connectors.Connectors.pipe(
      Effect.flatMap((connectors) => connectors.describeTool(input.connectorId, input.tool)),
      Effect.mapError(failure),
    ),
  ),
  t3_connector_call: McpToolAccess.writesWithCapability((input) =>
    Connectors.Connectors.pipe(
      Effect.flatMap((connectors) =>
        connectors.callTool(input.connectorId, input.tool, input.arguments ?? {}),
      ),
      Effect.mapError(failure),
    ),
  ),
});
