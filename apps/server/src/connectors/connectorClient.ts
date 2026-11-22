// The MCP SDK owns transport negotiation and protocol versions; only this file and connectorOAuth.ts import it.
import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import packageJson from "../../package.json" with { type: "json" };

export interface UpstreamTool {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly inputSchema: unknown;
}

export interface UpstreamCallResult {
  readonly content: ReadonlyArray<unknown>;
  readonly structuredContent?: unknown;
  readonly isError: boolean;
}

export interface ConnectorClient {
  readonly listTools: () => Promise<ReadonlyArray<UpstreamTool>>;
  readonly callTool: (name: string, args: Record<string, unknown>) => Promise<UpstreamCallResult>;
  readonly close: () => Promise<void>;
}

export interface ConnectorTarget {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Signs requests for a connector that signed in through a browser, refreshing as needed. */
  readonly authProvider?: OAuthClientProvider;
}

export type OpenConnectorClient = (target: ConnectorTarget) => Promise<ConnectorClient>;

/** Wraps a connected SDK client. Tests hand it an in-memory transport. */
export const connectWith = async (transport: object): Promise<ConnectorClient> => {
  const client = new Client({ name: "t4", version: packageJson.version });
  // The SDK's transports declare optional fields its Transport type rejects under exactOptionalPropertyTypes.
  await client.connect(transport as Parameters<Client["connect"]>[0]);
  return {
    listTools: async () => {
      const tools: UpstreamTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor });
        for (const tool of page.tools) {
          tools.push({
            name: tool.name,
            description: tool.description ?? tool.annotations?.title ?? "",
            readOnly: tool.annotations?.readOnlyHint === true,
            inputSchema: tool.inputSchema,
          });
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return tools;
    },
    callTool: async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      return {
        content: Array.isArray(result.content) ? result.content : [],
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent }),
        isError: result.isError === true,
      };
    },
    close: () => client.close(),
  };
};

/** Streamable HTTP first; servers that predate it still speak SSE. */
export const openHttpClient: OpenConnectorClient = async ({ url, headers, authProvider }) => {
  const options = {
    requestInit: { headers: { ...headers } },
    ...(authProvider === undefined ? {} : { authProvider }),
  };
  try {
    return await connectWith(new StreamableHTTPClientTransport(new URL(url), options));
  } catch (error) {
    if (httpStatus(error) === 401 || httpStatus(error) === 403) throw error;
    return await connectWith(new SSEClientTransport(new URL(url), options));
  }
};

/** The HTTP status an SDK transport error carries, when it has one. */
export const httpStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "number") return error.code;
  if (error instanceof UnauthorizedError) return 401;
  return undefined;
};
