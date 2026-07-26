#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, openStore } from "@grounded/core";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = await openStore(config);
  const server = createServer(store, {
    typicalFactLimit: config.delivery.typicalFactLimit,
    factsReserveTok: config.brief.reserve.facts,
  });

  const portRaw = process.env["GROUNDED_MCP_HTTP_PORT"];
  if (portRaw !== undefined && portRaw !== "") {
    await runHttp(server, portRaw, store);
  } else {
    await runStdio(server, store);
  }
}

async function runStdio(
  server: ReturnType<typeof createServer>,
  store: Awaited<ReturnType<typeof openStore>>,
): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = async (): Promise<void> => {
    await server.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runHttp(
  server: ReturnType<typeof createServer>,
  portRaw: string,
  store: Awaited<ReturnType<typeof openStore>>,
): Promise<void> {
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`invalid GROUNDED_MCP_HTTP_PORT: ${portRaw}`);
  }
  const host = "127.0.0.1";

  // Stateless: a fresh transport per request, no session tracking.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const http = createHttpServer((req, res) => {
    void transport.handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    });
  });

  await new Promise<void>((resolve) => http.listen(port, host, resolve));
  process.stderr.write(`grounded-mcp HTTP transport on http://${host}:${port}\n`);

  const shutdown = async (): Promise<void> => {
    http.close();
    await server.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`grounded-mcp failed to start: ${String(err)}\n`);
  process.exit(1);
});
