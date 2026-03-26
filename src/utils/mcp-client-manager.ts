import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MCPServerName, ServerStatusMap } from '../types.js';

const ENV_MAP: Record<MCPServerName, string> = {
  farcaster: 'FARCASTER_MCP_URL',
  twitter: 'TWITTER_MCP_URL',
  web: 'WEB_MCP_URL',
};

const clients = new Map<MCPServerName, Client>();

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const CONNECT_TIMEOUT_MS = 10_000;

async function connectWithRetry(
  name: MCPServerName,
  url: string,
  maxRetries: number
): Promise<Client> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const abort = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
      const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { signal: abort } });
      const client = new Client({ name: 'sidelineiq-agents', version: '1.0.0' });
      await client.connect(transport);
      return client;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(
          `[MCP] Connection attempt ${attempt}/${maxRetries} failed for ${name} — retrying in ${delay}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError ?? new Error(`Failed to connect to ${name}`);
}

export async function initializeMCPClients(): Promise<void> {
  const servers = Object.entries(ENV_MAP) as [MCPServerName, string][];

  for (const [name, envVar] of servers) {
    const url = process.env[envVar];
    if (!url) {
      console.warn(`[MCP] ${envVar} not set — ${name} server unavailable`);
      continue;
    }

    try {
      const client = await connectWithRetry(name, url, MAX_RETRIES);
      clients.set(name, client);
      console.log(`[MCP] Connected to ${name} at ${url}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[MCP] Failed to connect to ${name} after ${MAX_RETRIES} attempts — degraded mode. Error: ${message}`
      );
    }
  }

  const connected = Array.from(clients.keys());
  console.log(`[MCP] Initialization complete. Connected servers: ${connected.join(', ') || 'none'}`);
}

export async function callTool(
  server: MCPServerName,
  toolName: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const client = clients.get(server);
  if (!client) {
    throw new Error(`MCP server '${server}' is not available`);
  }

  try {
    const result = await client.callTool({ name: toolName, arguments: params });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[MCP] Error calling ${server}.${toolName}: ${message}`);
    throw err;
  }
}

export function isServerAvailable(server: MCPServerName): boolean {
  return clients.has(server);
}

export function getServerStatus(): ServerStatusMap {
  return {
    farcaster: clients.has('farcaster'),
    twitter: clients.has('twitter'),
    web: clients.has('web'),
  };
}

export async function disconnectAll(): Promise<void> {
  for (const [name, client] of clients) {
    try {
      await client.close();
      console.log(`[MCP] Disconnected from ${name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[MCP] Error disconnecting from ${name}: ${message}`);
    }
  }
  clients.clear();
}

// Exposed for testing — allows replacing the client map
export function _setClientForTesting(name: MCPServerName, client: Client): void {
  clients.set(name, client);
}

export function _clearClientsForTesting(): void {
  clients.clear();
}
