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
          status: { type: "string", enum: ["active", "archived"] },
          createdBy: { type: "string" },
          source: { type: "string" },
        },
      },
      DeliveryRank: {
        type: "object",
        description:
          "Write-time delivery signal for a fact: where it lands in factsList's own ordering right now. Omitted entirely on the write response when the fact is archived (no delivery position to report) rather than inventing a rank.",
        required: ["rank", "ofActive", "delivered"],
        properties: {
          rank: { type: "integer", description: "1-based position within active facts in this scope." },
          ofActive: { type: "integer", description: "count of active facts in this scope." },
          delivered: {
            type: "boolean",
            description: "true when rank is at or below delivery.typicalFactLimit.",
          },
          warning: {
            type: "string",
            description:
              'Present only when delivered is false, e.g. "rank 23 of 23 — most consumers request the top 8".',
          },
        },
      },
      Vision: {
        type: "object",
        required: ["id", "scope", "summary", "details", "createdAt", "updatedAt"],
        properties: {
          id: { type: "integer" },
          scope: { type: "string", description: '"global" or "project:<name>"' },
          summary: {
            type: ["string", "null"],
            description:
              "Short form injected at SessionStart. Never recalled. Null falls back to truncated `details` for injection (pre-migration rows).",
          },
          details: { type: "string", description: "narrative markdown. Recalled; never injected." },
          createdBy: { type: ["string", "null"] },
          source: { type: ["string", "null"] },
          createdAt: { type: "string" },
          updatedAt: { type: "string" },
        },
      },
      VisionInput: {
        type: "object",
        required: ["details"],
        properties: {
          details: { type: "string", description: "narrative markdown. Recalled; never injected." },
          summary: {
            type: "string",
            description:
              "Short form injected at SessionStart. Never recalled. Omitted falls back to truncated `details` for injection.",
          },
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
          "scope",
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
          scope: {
            type: "string",
            description:
              'Lane, e.g. "global" | "administration". Batch-level only. Routing, not enforcement — self-host runs one static bearer token and scopes are self-declared by the caller.',
          },
          ingestedAt: { type: "string" },
        },
      },
      DeliveryMeta: {
        type: "object",
        description:
          "Delivery accounting for a list-shaped response: not just what was stored, but what actually reached the caller. `available` is a real computed count, never derived from data.length.",
        required: ["returned", "available", "truncated", "limit"],
        properties: {
          returned: { type: "integer", description: "rows in this response's data array." },
          available: {
            type: "integer",
            description:
              "rows that matched before limit/offset/source-cap. For /recall, a saturated candidate lane makes this a documented floor (see truncated).",
          },
          truncated: {
            type: "boolean",
            description:
              "returned < available, OR the candidate fetch itself was capped before available could be computed exactly — i.e. there may be more than available, not just more than returned.",
          },
          limit: { type: ["integer", "null"] },
          bySource: {
            type: "object",
            description: "POST /recall only: per-source-type breakdown.",
            properties: {
              fact: { $ref: "#/components/schemas/DeliveryMetaBySourceEntry" },
              session: { $ref: "#/components/schemas/DeliveryMetaBySourceEntry" },
              doc: { $ref: "#/components/schemas/DeliveryMetaBySourceEntry" },
            },
          },
        },
      },
      DeliveryMetaBySourceEntry: {
        type: "object",
        required: ["returned", "available", "truncated"],
        properties: {
          returned: { type: "integer" },
          available: { type: "integer" },
          truncated: { type: "boolean" },
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
        required: ["scanned", "added", "updated", "skipped", "retagged", "removed", "paths"],
        properties: {
          scanned: { type: "integer" },
          added: { type: "integer" },
          updated: { type: "integer" },
          skipped: { type: "integer" },
          retagged: {
            type: "integer",
            description:
              "Batch tags (source/kind/machine/scope) changed on an otherwise-unchanged chunk: a tag-only update ran, touching neither body, body_hash, total_chunks, nor embedding.",
          },
          removed: { type: "integer" },
          paths: { type: "array", items: { type: "string" } },
        },
      },
      DocsPruneReport: {
        type: "object",
        required: ["missing", "removed"],
        properties: {
          missing: { type: "integer" },
          removed: { type: "integer" },
        },
      },
      BriefResult: {
        type: "object",
        required: ["startupNote", "vision", "recentSessions", "facts", "relatedDocs", "meta", "droppedItems"],
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
          meta: {
            type: "object",
            description:
              "Delivery accounting per reserved brief lane. `vision` is measured in CHARS, never items — there is no vision arm in sourceType/typedId, so vision can never appear in droppedItems. `facts`/`sessions` are measured in items, truncated by the brief.reserve.* token (chars÷4) budgets. relatedDocs deliberately has no reserve and no meta key here — it is already bounded by limit:5 + the 200-char snippet cap.",
            required: ["vision", "facts", "sessions"],
            properties: {
              vision: { $ref: "#/components/schemas/DeliveryMeta" },
              facts: { $ref: "#/components/schemas/DeliveryMeta" },
              sessions: { $ref: "#/components/schemas/DeliveryMeta" },
            },
          },
          droppedItems: {
            type: "array",
            description:
              'Typed ids ("fact:19", "session:274") of facts/sessions dropped by their lane\'s reserve, in drop order. Never includes vision or relatedDocs. Each id resolves via GET /get/{typedId}.',
            items: { type: "string" },
          },
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
        description:
          'Defaults to status=active. Pass status=archived for archived facts, or status=all for every status regardless of archival ("all" is not forwarded to storage as a literal status value).',
        parameters: [
          { name: "scope", in: "query", schema: { type: "string" } },
          {
            name: "status",
            in: "query",
            description: 'Defaults to "active". One of "active", "archived", "all".',
            schema: { type: "string", enum: ["active", "archived", "all"], default: "active" },
          },
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "offset", in: "query", schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "Facts, with delivery accounting for what was actually returned vs what matched.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/Fact" } },
                    meta: { $ref: "#/components/schemas/DeliveryMeta" },
                  },
                },
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
            description:
              "Created fact, plus its write-time delivery rank. `delivery` is present on every write since a fresh fact is never archived.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/Fact" },
                    {
                      type: "object",
                      properties: { delivery: { $ref: "#/components/schemas/DeliveryRank" } },
                    },
                  ],
                },
              },
            },
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
            description:
              "Updated fact, plus its write-time delivery rank. `delivery` is omitted (not a zero rank) when the patch archived the fact — an archived fact has no delivery position.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/Fact" },
                    {
                      type: "object",
                      properties: { delivery: { $ref: "#/components/schemas/DeliveryRank" } },
                    },
                  ],
                },
              },
            },
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
        summary: "List vision records (one per scope, edited in place)",
        parameters: [
          { name: "scope", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "offset", in: "query", schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "Vision records",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/Vision" } },
                    meta: { $ref: "#/components/schemas/DeliveryMeta" },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        summary: "Set the vision for a scope (edits the one record in place)",
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
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/Session" } },
                    meta: { $ref: "#/components/schemas/DeliveryMeta" },
                  },
                },
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
        description:
          'Batch tags apply to every chunk scanned in this call. "scope" is the lane (e.g. "global" | "administration") — routing, not enforcement; the caller self-declares it.',
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
                  machine: { type: "string" },
                  scope: { type: "string", description: 'Lane, defaults to "global".' },
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
    "/docs/prune": {
      post: {
        summary: "Reconcile docs against the filesystem",
        description:
          'For each distinct path with no file on disk: marks status="missing" (default), or with remove:true deletes every chunk row for that path.',
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  remove: { type: "boolean", default: false },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Prune report",
            content: { "application/json": { schema: { $ref: "#/components/schemas/DocsPruneReport" } } },
          },
        },
      },
    },
    "/docs": {
      get: {
        summary: "List docs",
        description:
          '"source" filters by logical source/collection. "scope"/"scopes" filter by lane (unfiltered by default — docsList always returns every lane, unlike recall/brief).',
        parameters: [
          { name: "source", in: "query", schema: { type: "string" } },
          { name: "scope", in: "query", schema: { type: "string" } },
          {
            name: "scopes",
            in: "query",
            description: "Comma-separated list of lanes (OR match).",
            schema: { type: "string" },
          },
          { name: "limit", in: "query", schema: { type: "integer" } },
          { name: "offset", in: "query", schema: { type: "integer" } },
        ],
        responses: {
          "200": {
            description: "Docs",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/Doc" } },
                    meta: { $ref: "#/components/schemas/DeliveryMeta" },
                  },
                },
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
                  scopes: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      'Doc-lane filter (OR match). Defaults to ["global"] when omitted, so callers that declare nothing never see non-global lanes (e.g. "administration"). Routing, not enforcement — self-declared by the caller.',
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Recall result cards, plus delivery accounting including a per-source-type breakdown (meta.bySource).",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/RecallResult" } },
                    meta: { $ref: "#/components/schemas/DeliveryMeta" },
                  },
                },
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
                  factScopes: { type: "array", items: { type: "string" } },
                  docScopes: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      'Explicit doc-lane set for the related-docs recall call, e.g. ["global","administration"]. Explicit-only — no agent/project/machine derivation. Defaults to ["global"] when omitted/empty.',
                  },
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
