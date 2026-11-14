import type { ConnectorId, ConnectorTool } from "@t3tools/contracts";

export interface SearchableConnector {
  readonly id: ConnectorId;
  readonly name: string;
  readonly tools: ReadonlyArray<ConnectorTool>;
}

export interface ConnectorToolMatch extends ConnectorTool {
  readonly connectorId: ConnectorId;
}

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Ranks tools by query words in the tool name, then the connector's name, then the description. */
export const searchConnectorTools = (
  connectors: ReadonlyArray<SearchableConnector>,
  query: string,
  limit: number,
): ReadonlyArray<ConnectorToolMatch> => {
  const terms = words(query);
  const scored = connectors.flatMap((connector) => {
    const connectorWords = words(connector.name);
    return connector.tools.map((tool) => {
      const nameWords = words(tool.name);
      const descriptionWords = words(tool.description);
      const score = terms.reduce(
        (total, term) =>
          total +
          (nameWords.some((word) => word.startsWith(term)) ? 3 : 0) +
          (connectorWords.some((word) => word.startsWith(term)) ? 2 : 0) +
          (descriptionWords.some((word) => word.startsWith(term)) ? 1 : 0),
        0,
      );
      return { match: { ...tool, connectorId: connector.id }, score };
    });
  });
  return scored
    .filter((entry) => terms.length === 0 || entry.score > 0)
    .toSorted((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => entry.match);
};
