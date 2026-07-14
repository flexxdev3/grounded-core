// Hand-written OpenAPI 3.1 description for the Grounded REST API.
// Kept concise and accurate; served verbatim at GET /openapi.json.

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Grounded API",
    version: "0.1.0",
    description:
      "REST surface over the Grounded Store: vision, facts, sessions, docs, source-cited recall, and startup briefs.",
    license: { name: "Apache-2.0" },
  },
  servers: [{ url: "http://127.0.0.1:7437", description: "local" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error", "code"],
        properties: {
          error: { type: "string" },
          code: { type: "string" },
        },
      },
      Fact: {
        type: "object",
        required: [
          "id",
          "scope",
          "category",
          "fact",
          "pinned",
          "importance",
          "status",
          "createdAt",
          "updatedAt",
        ],
        properties: {
          id: { type: "integer" },
          scope: { type: "string" },
          category: { type: "string" },
          fact: { type: "string" },
          detail: { type: ["string", "null"] },
          topicKey: { type: ["string", "null"] },
          pinned: { type: "boolean" },
          importance: { type: "number" },
          status: { type: "string", enum: ["active", "archived"] },
          createdBy: { type: ["string", "null"] },
          source: { type: ["string", "null"] },
          createdAt: { type: "string" },
          updatedAt: { type: "string" },
        },
      },
      FactInput: {
        type: "object",
        required: ["fact"],
        properties: {
          fact: { type: "string" },
          scope: { type: "string" },
          category: { type: "string" },
          detail: { type: "string" },
          topicKey: { type: "string" },
          pinned: { type: "boolean" },
          importance: { type: "number" },
          createdBy: { type: "string" },
          source: { type: "string" },
        },
      },
      Vision: {
        type: "object",
        required: ["id", "scope", "content", "status", "createdAt", "updatedAt"],
        properties: {
          id: { type: "integer" },
          scope: { type: "string", description: '"global" or "project:<name>"' },
          content: { type: "string", description: "narrative markdown" },
          status: { type: "string", enum: ["active"] },
          createdBy: { type: ["string", "null"] },
          source: { type: ["string", "null"] },
          createdAt: { type: "string" },
          updatedAt: { type: "string" },
        },
      },
      VisionInput: {
        type: "object",
        required: ["content"],
        properties: {
          content: { type: "string" },
          scope: { type: "string" },
          createdBy: { type: "string" },
          source: { type: "string" },
        },
      },
      Session: {
        type: "object",
        required: ["id", "summary", "source", "createdAt"],
        properties: {
          id: { type: "integer" },
          machine: { type: ["string", "null"] },
          project: { type: ["string", "null"] },
          workspace: { type: ["string", "null"] },
          agent: { type: ["string", "null"] },
          summary: { type: "string" },
          details: { type: ["string", "null"] },
          tags: { type: ["array", "null"], items: { type: "string" } },
          source: { type: "string" },
          createdAt: { type: "string" },
        },
      },
      SessionInput: {
        type: "object",
        required: ["summary"],
        properties: {
          summary: { type: "string" },
          details: { type: "string" },
          project: { type: "string" },
          workspace: { type: "string" },
          agent: { type: "string" },
          machine: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          source: { type: "string" },
        },
      },
      Doc: {
        type: "object",
        required: [
          "id",
          "source",
          "path",
          "title",
          "body",
          "chunkIdx",
          "totalChunks",
          "bodyHash",
          "status",
          "ingestedAt",
        ],
        properties: {
          id: { type: "integer" },
          source: { type: "string" },
          path: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          chunkIdx: { type: "integer" },
          totalChunks: { type: "integer" },
          bodyHash: { type: "string" },
          mtime: { type: ["string", "null"] },
          status: { type: "string", enum: ["active", "archived", "missing"] },
          kind: { type: ["string", "null"] },
          machine: { type: ["string", "null"] },
          ingestedAt: { type: "string" },
        },
      },
      RecallResult: {
        type: "object",
        required: ["sourceType", "id", "typedId", "title", "score", "matchedBy", "citation", "snippet"],
        properties: {
          sourceType: { type: "string", enum: ["fact", "session", "doc"] },
          id: { type: "integer" },
          typedId: { type: "string" },
          title: { type: "string" },
          score: { type: "number" },
          matchedBy: { type: "string", enum: ["vector", "lexical", "both"] },
          createdAt: { type: ["string", "null"] },
          updatedAt: { type: ["string", "null"] },
          path: { type: ["string", "null"] },
          source: { type: ["string", "null"] },
          citation: { type: "string" },
          snippet: { type: "string" },
        },
      },
      IngestReport: {
        type: "object",
        required: ["scanned", "added", "updated", "skipped", "removed", "paths"],
        properties: {
          scanned: { type: "integer" },
          added: { type: "integer" },
          updated: { type: "integer" },
          skipped: { type: "integer" },
          removed: { type: "integer" },
          paths: { type: "array", items: { type: "string" } },
        },
      },
      BriefResult: {
        type: "object",
        required: ["startupNote", "vision", "recentSessions", "facts", "relatedDocs"],
        properties: {
          startupNote: { type: "string" },
          vision: {
            type: "object",
            properties: {
              global: { oneOf: [{ $ref: "#/components/schemas/Vision" }, { type: "null" }] },
              project: { oneOf: [{ $ref: "#/components/schemas/Vision" }, { type: "null" }] },
            },
          },
          recentSessions: { type: "array", items: { $ref: "#/components/schemas/Session" } },
          facts: { type: "array", items: { $ref: "#/components/schemas/Fact" } },
          relatedDocs: { type: "array", items: { $ref: "#/components/schemas/RecallResult" } },
          text: { type: "string" },
        },
      },
      HealthReport: {
        type: "object",
        required: ["ok", "storage", "embeddings", "counts"],
        properties: {
          ok: { type: "boolean" },
          storage: {
            type: "object",
            properties: {
              adapter: { type: "string" },
              ok: { type: "boolean" },
              detail: { type: "string" },
            },
          },
          embeddings: {
            type: "object",
            properties: {
              provider: { type: "string" },
              ok: { type: "boolean" },
              dims: { type: "integer" },
              detail: { type: "string" },
            },
          },
          counts: {
            type: "object",
            properties: {
              facts: { type: "integer" },
              sessions: { type: "integer" },
              docs: { type: "integer" },
              documents: { type: "integer" },
              bytes: { type: "integer", description: "on-disk size of grounded tables+indexes" },
            },
          },
        },
      },
      FullRecord: {
        type: "object",
        required: ["sourceType", "record"],
        properties: {
          sourceType: { type: "string", enum: ["fact", "session", "doc"] },
          record: {
            oneOf: [
              { $ref: "#/components/schemas/Fact" },
              { $ref: "#/components/schemas/Session" },
              { $ref: "#/components/schemas/Doc" },
            ],
          },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/health": {
      get: {
        summary: "Service health",
        security: [],
        responses: {
          "200": {
            description: "Health report",
            content: { "application/json": { schema: { $ref: "#/components/schemas/HealthReport" } } },
          },
        },
      },
    },
    "/facts": {
      get: {
        summary: "List facts",
        parameters: [
          { name: "scope", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "offset", in: "query", schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "Facts",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Fact" } },
              },
            },
          },
        },
      },
      post: {
        summary: "Add a fact",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/FactInput" } } },
        },
        responses: {
          "201": {
            description: "Created fact",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Fact" } } },
          },
        },
      },
    },
    "/facts/{id}": {
      patch: {
        summary: "Edit a fact in place (partial; re-embeds when text changes)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/FactInput" } } },
        },
        responses: {
          "200": {
            description: "Updated fact",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Fact" } } },
          },
          "404": {
            description: "Not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
      delete: {
        summary: "Delete a fact",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: {
          "200": { description: "Deletion result" },
          "404": {
            description: "Not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/vision": {
      get: {
        summary: "List vision records (default active only; status=all for history)",
        parameters: [
          { name: "scope", in: "query", schema: { type: "string" } },
          { name: "status", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "offset", in: "query", schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "Vision records",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Vision" } },
              },
            },
          },
        },
      },
      post: {
        summary: "Set the vision for a scope (edits the active record in place)",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/VisionInput" } } },
        },
        responses: {
          "201": {
            description: "Created vision record",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Vision" } } },
          },
        },
      },
    },
    "/vision/{id}": {
      delete: {
        summary: "Delete a vision record",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: {
          "200": { description: "Deletion result" },
          "404": {
            description: "Not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/sessions": {
      get: {
        summary: "List sessions",
        parameters: [
          { name: "project", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "Sessions",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Session" } },
              },
            },
          },
        },
      },
      post: {
        summary: "Add a session",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/SessionInput" } } },
        },
        responses: {
          "201": {
            description: "Created session",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Session" } } },
          },
        },
      },
    },
    "/sessions/{id}": {
      get: {
        summary: "Get a session",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: {
          "200": {
            description: "Session",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Session" } } },
          },
          "404": {
            description: "Not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/docs/ingest": {
      post: {
        summary: "Ingest docs from paths",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["paths"],
                properties: {
                  paths: { type: "array", items: { type: "string" } },
                  source: { type: "string" },
                  kind: { type: "string" },
                  dryRun: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Ingest report",
            content: { "application/json": { schema: { $ref: "#/components/schemas/IngestReport" } } },
          },
        },
      },
    },
    "/docs": {
      get: {
        summary: "List docs",
        parameters: [
          { name: "source", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "offset", in: "query", schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "Docs",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Doc" } },
              },
            },
          },
        },
      },
    },
    "/docs/{id}": {
      get: {
        summary: "Get a doc",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: {
          "200": {
            description: "Doc",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Doc" } } },
          },
          "404": {
            description: "Not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/recall": {
      post: {
        summary: "Hybrid recall (compact cited cards)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["query"],
                properties: {
                  query: { type: "string" },
                  limit: { type: "integer" },
                  project: { type: "string" },
                  sources: {
                    type: "array",
                    items: { type: "string", enum: ["fact", "session", "doc"] },
                  },
                  lexicalOnly: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Recall result cards",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/RecallResult" } },
              },
            },
          },
        },
      },
    },
    "/brief": {
      post: {
        summary: "Assemble startup brief",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  agent: { type: "string" },
                  project: { type: "string" },
                  machine: { type: "string" },
                  cwd: { type: "string" },
                  query: { type: "string" },
                  recentSessions: { type: "integer" },
                  format: { type: "string", enum: ["markdown", "json"] },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Brief",
            content: { "application/json": { schema: { $ref: "#/components/schemas/BriefResult" } } },
          },
        },
      },
    },
    "/get/{typedId}": {
      get: {
        summary: "Fetch a full record by typed id (e.g. doc:12)",
        parameters: [{ name: "typedId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Full record",
            content: { "application/json": { schema: { $ref: "#/components/schemas/FullRecord" } } },
          },
          "404": {
            description: "Not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/openapi.json": {
      get: {
        summary: "This OpenAPI document",
        security: [],
        responses: { "200": { description: "OpenAPI 3.1 document" } },
      },
    },
  },
} as const;
