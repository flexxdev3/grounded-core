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
          "origin",
          "createdAt",
          "updatedAt",
        ],
        properties: {
          id: { type: "integer" },
          scope: { type: "string" },
          category: { type: "string" },
          fact: { type: "string" },
          detail: { type: ["string", "null"] },
          topicKey: {
            type: ["string", "null"],
            description:
              "Stable identity key, unique per scope among ACTIVE rows. Writing the same (scope, topicKey) via POST /facts edits this row in place instead of creating a second competing row.",
          },
          pinned: { type: "boolean" },
          importance: { type: "number" },
          status: { type: "string", enum: ["active", "archived"] },
          origin: {
            type: "string",
            enum: ["stated", "derived"],
            description:
              "Provenance of the fact. 'stated' = an operator or agent asserted it outright — every current write path. 'derived' is reserved for synthesis, which must never present its inferences as operator truth.",
          },
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
          topicKey: {
            type: "string",
            description:
              "Stable identity key. Supplying a topicKey that already matches an active fact in this scope upserts that fact in place (merge-patch — omitted fields keep their stored value) rather than creating a duplicate.",
          },
          pinned: { type: "boolean" },
          importance: { type: "number" },
          status: { type: "string", enum: ["active", "archived"] },
          origin: {
            type: "string",
            enum: ["stated", "derived"],
            description: "Defaults to 'stated' when omitted. See Fact.origin.",
          },
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
              'Present when any write-time check fires; several are joined with "; ". Rank ("rank 23 of 23 — most consumers request the top 8"), pinned-set pressure, one-line terseness, and the budget contract\'s per-row share ("\"fact\" is 512 chars, over the 450-char per-row share of the facts lane ...").',
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
          details: { type: "string", description: "narrative markdown. Never recalled, never injected." },
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
          details: {
          type: "string",
          description:
            "narrative markdown. Never recalled, never injected. CAPPED at " +
            "`brief.reserve.vision` x 4 chars (1600 on the shipped default) — over it POST " +
            "/vision returns 400. No static `maxLength` here: the cap follows the deployment's " +
            "configured reserve.",
        },
          summary: {
            type: "string",
            description:
              "Short form injected at SessionStart, INSTEAD of `details` — not alongside it. Setting a summary means the brief stops injecting the body (the brief says so, and reports the withheld chars as meta.vision.rows[].suppressedDetailChars). Omitted falls back to truncated `details` for injection. Capped by the same vision cap as `details`, since this is the field the brief actually injects.",
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
      SessionBudgetSignal: {
        type: "object",
        description:
          "Budget-contract WARNING attached to a session write response. Present only when a field exceeded its per-row share (the row was still stored) — over the lane cap or the body cap the write is a 400 instead. Sessions have no delivery rank to carry this, so it rides on its own key.",
        required: ["lane", "warning", "rowCapChars", "laneCapChars", "bodyCapChars"],
        properties: {
          lane: { type: "string", enum: ["sessions"] },
          warning: { type: "string" },
          rowCapChars: { type: "integer" },
          laneCapChars: { type: "integer" },
          bodyCapChars: { type: ["integer", "null"] },
        },
      },
      SessionWriteResponse: {
        allOf: [
          { $ref: "#/components/schemas/Session" },
          {
            type: "object",
            properties: { budget: { $ref: "#/components/schemas/SessionBudgetSignal" } },
          },
        ],
      },
      SessionInput: {
        type: "object",
        required: ["summary"],
        properties: {
          summary: {
            type: "string",
            description:
              "The line the brief injects, and the only session field it budgets. Over its per-row share (`brief.reserve.sessions` x 4 / rows — 250 chars shipped) the write succeeds with a `budget` warning; over the whole lane cap (2000 shipped) it is a 400.",
          },
          details: {
            type: "string",
            description:
              "The body recall searches. NEVER injected into the brief, so it has no per-row share — only a ceiling (`bodyFactor` x the lane cap, 16000 chars shipped) past which the write is a 400.",
          },
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
          "Delivery accounting for a list-shaped response: not just what was stored, but what actually reached the caller. `available` is a real computed count, never derived from data.length. `returned`/`available` are ALWAYS row counts on every lane; a lane that truncates text instead of dropping rows reports its character arithmetic in `chars`.",
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
              "returned < available, OR text was cut inside a kept row (see chars), OR the candidate fetch itself was capped before available could be computed exactly — i.e. there may be more than available, not just more than returned.",
          },
          limit: { type: ["integer", "null"] },
          chars: {
            type: "object",
            description:
              "Text-truncated lanes only (today: the brief's vision lane, budgeted in chars and with no SourceType arm to drop into). Combined character counts after and before truncation. Absent on row-limited lanes.",
            required: ["returned", "available"],
            properties: {
              returned: { type: "integer" },
              available: { type: "integer" },
            },
          },
          rows: {
            type: "array",
            description:
              "Text-truncated lanes only (today: the brief's vision lane). Per-ROW char accounting, so a clipped row is NAMED rather than only summed into `chars` — vision's stand-in for `droppedItems`, which it cannot use (no sourceType arm). `ref` is `vision:<id>`, NOT a typedId: it does not resolve via GET /get/{typedId}; read it back with GET /vision. `suppressedDetailChars` is non-zero when the row has a `summary` and the brief therefore injected the summary INSTEAD of `details`.",
            items: {
              type: "object",
              required: ["ref", "scope", "chars", "clipped"],
              properties: {
                ref: { type: "string", example: "vision:12" },
                scope: { type: "string" },
                chars: {
                  type: "object",
                  properties: {
                    returned: { type: "integer" },
                    available: { type: "integer" },
                  },
                },
                clipped: { type: "boolean" },
                suppressedDetailChars: { type: "integer" },
              },
            },
          },
          bySource: {
            type: "object",
            description:
              "POST /recall only: per-source-type breakdown. `returned` is counted after the global limit is applied (recall's `limit` is a total across sources), so the per-source `returned` values always sum to `meta.returned`. `available` is the pre-limit candidate count for that lane.",
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
      ImpactResult: {
        type: "object",
        required: ["sourceType", "id", "typedId", "title", "score", "matchedBy", "citation", "snippet", "inScope", "scope"],
        description:
          "A RecallResult card plus the lane verdict. When inScope is false the hit is citation-only: title and snippet are null (never omitted) — the caller learns THAT a dependency exists and where, but not what it says. Lane gating applies to docs only; facts and sessions are always inScope:true with scope:\"global\".",
        properties: {
          sourceType: { type: "string", enum: ["fact", "session", "doc"] },
          id: { type: "integer" },
          typedId: { type: "string" },
          title: {
            type: ["string", "null"],
            description: "Null exactly when inScope is false — withheld across a lane boundary.",
          },
          score: { type: "number" },
          matchedBy: { type: "string", enum: ["vector", "lexical", "both"] },
          createdAt: { type: ["string", "null"] },
          updatedAt: { type: ["string", "null"] },
          path: { type: ["string", "null"] },
          source: { type: ["string", "null"] },
          citation: { type: "string" },
          snippet: {
            type: ["string", "null"],
            description: "Null exactly when inScope is false — withheld across a lane boundary.",
          },
          inScope: {
            type: "boolean",
            description: "False only for docs outside ImpactOptions.scopes.",
          },
          scope: {
            type: "string",
            description:
              'The doc lane this hit lives in — always present, including when withheld. Facts and sessions are not laned and always report "global".',
          },
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
          relatedDocs: {
            type: "array",
            description:
              "Related docs, one row per file: the brief over-fetches chunk hits and keeps the highest-scoring chunk per path. POST /recall is unaffected and still returns chunk-level rows.",
            items: { $ref: "#/components/schemas/RecallResult" },
          },
          meta: {
            type: "object",
            description:
              "Delivery accounting per reserved brief lane. `vision` is measured in CHARS, never items — there is no vision arm in sourceType/typedId, so vision can never appear in droppedItems. `facts`/`sessions` are measured in items, truncated by the brief.reserve.* token (chars÷4) budgets. relatedDocs deliberately has no reserve and no meta key here — it is already bounded by 5 DISTINCT docs (chunk hits are deduped by path, best chunk per file) + the 200-char snippet cap.",
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
              facts: {
                type: "integer",
                description:
                  "ACTIVE facts — the same basis GET /facts uses by default, so the two routes can never be read as contradicting each other. Archived rows are reported separately as factsArchived; facts + factsArchived is the raw table count.",
              },
              factsArchived: { type: "integer", description: "Archived facts." },
              sessions: { type: "integer" },
              docs: { type: "integer" },
              documents: { type: "integer" },
              bytes: { type: "integer", description: "on-disk size of grounded tables+indexes" },
            },
          },
          budget: {
            type: "object",
            description:
              "THE CONTEXT BUDGET CONTRACT, as this running service resolves it. One record per brief lane covering both sides: the read reserve the brief truncates to, and the write caps every POST/PATCH derives from it. Published here so a stale deployed image or a drifted row is visible without probing the API with a write. Every number is derived from one table (config `brief.budget` / `brief.reserve`); no route restates a cap.",
            additionalProperties: {
              type: "object",
              properties: {
                reserveTok: { type: "integer", description: "lane budget in tokens (chars/4)." },
                rows: { type: "integer", description: "rows the lane expects to deliver in one brief." },
                laneCapChars: {
                  type: "integer",
                  description: "reserveTok x 4. A single row over this is a 400 on write — it would consume the entire lane.",
                },
                rowCapChars: {
                  type: "integer",
                  description: "laneCapChars / rows. Over it is a WARNING on write, never a rejection and never a silent truncation. Equals laneCapChars on vision, whose lane is one row.",
                },
                bodyCapChars: {
                  type: ["integer", "null"],
                  description: "Cap for a stored field the brief never renders (sessions.details). Null when the lane has no such field.",
                },
                briefField: { type: "string", description: "the stored field the reserve pays for." },
                bodyField: { type: ["string", "null"], description: "a stored field the brief never renders." },
                conformance: {
                  type: "object",
                  description:
                    "How many STORED rows currently violate the caps above. Cached for 60s and bounded by a per-lane scan ceiling; `complete: false` means the scan did not see every row, so the counts are a floor.",
                  properties: {
                    checked: { type: "integer" },
                    overRowCap: { type: "integer" },
                    overLaneCap: { type: "integer" },
                    overBodyCap: { type: "integer" },
                    complete: { type: "boolean" },
                  },
                },
              },
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
        summary:
          "Service health — storage, embeddings, counts, and the resolved budget contract with per-lane over-cap counts",
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
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 5000 } },
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } },
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
          "400": {
            description:
              "The fact's rendered payload (`fact` + ` — detail`) is over the facts LANE cap (`brief.reserve.facts` x 4 chars, 3600 on the shipped default; live value at GET /health `budget.facts.laneCapChars`). Rejected, never truncated; the message names the overage. Over the smaller per-ROW share the write SUCCEEDS and the overage is reported in `delivery.warning` instead.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
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
          "400": {
            description:
              "The patched text is over the facts lane cap (live value at GET /health `budget.facts.laneCapChars`). Measured on the fields the patch carries, so it can only under-count, never over-reject; a merge that lands over the smaller per-row share comes back as a `delivery.warning` on the 200.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
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
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 5000 } },
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } },
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
          "400": {
            description:
              "`details` or `summary` is over the vision cap (`brief.reserve.vision` x 4 chars, " +
              "1600 on the shipped default; read the live value from GET /health `budget.vision`). " +
              "The write is rejected, never truncated; the message names the overage in chars.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
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
          { name: "workspace", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 5000 } },
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } },
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
            description:
              "Created session. Carries a `budget` warning when `summary` exceeded its per-row share.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/SessionWriteResponse" } },
            },
          },
          "400": {
            description:
              "`summary` is over the sessions lane cap, or `details` is over the sessions body cap (live values at GET /health `budget.sessions`). Rejected, never truncated.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
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
      patch: {
        summary: "Edit a session in place (partial; re-embeds when text changes)",
        description:
          "Correct a work-log entry instead of appending a second one. Omitted fields keep their stored value.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/SessionInput" } } },
        },
        responses: {
          "200": {
            description:
              "Updated session. Carries a `budget` warning when `summary` exceeded its per-row share.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/SessionWriteResponse" } },
            },
          },
          "400": {
            description:
              "`summary` is over the sessions lane cap, or `details` is over the sessions body cap. Rejected, never truncated.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "404": {
            description: "Not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
      delete: {
        summary: "Delete a session",
        description:
          "Hard delete of one session row plus its index entries. Not reversible \u2014 use to clean up mistaken or duplicate work-log rows.",
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
    "/docs/ingest": {
      post: {
        summary: "Ingest docs from paths",
        description:
          'Batch tags apply to every chunk scanned in this call. "scope" is the lane (e.g. "global" | "administration") — routing, not enforcement; the caller self-declares it. A path that does not exist or cannot be read is a 400 (INGEST_PATH_UNREADABLE), never a 200 with scanned:0.',
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
                  project: {
                    type: "string",
                    description:
                      "Owning project for every doc in this batch. Overrides the path-derived project (config `ingest.projectSegment`).",
                  },
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
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 5000 } },
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } },
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
                  limit: {
                    type: "integer",
                    minimum: 1,
                    maximum: 200,
                    description:
                      "Total number of results across all sources (default 10). Not a per-source quota — results are ranked flat by fused score and cut once. Must be an integer in 1..200; a fractional, zero, negative, or over-cap value is a 400, never a silent clamp. Page bulk reads on /facts, /sessions, /docs with offset.",
                  },
                  project: { type: "string" },
                  workspace: {
                    type: "string",
                    description:
                      "Session-lane filter. Facts and docs have no workspace dimension and are returned unfiltered, exactly as `project` behaves.",
                  },
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
              "Recall result cards ordered by fused score descending across all source types, plus delivery accounting including a per-source-type breakdown (meta.bySource).",
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
    "/impact": {
      post: {
        summary: "Reverse lookup — what depends on this? (dependency pre-flight)",
        description:
          "Lexical-only by construction: a subject is a literal token (a container name, a port, a path), not a natural-language query. Impact deliberately CROSSES lane boundaries — it is the only operation that does. Out-of-lane doc hits are still returned (not filtered out) with inScope:false and title/snippet set to null: citation-only, content withheld. meta.available counts withheld hits too. Run this before stopping, removing, deleting, or renaming infrastructure.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["subject"],
                properties: {
                  subject: {
                    type: "string",
                    description: "A literal token to search for — e.g. a container name, a port, a path. Not a natural-language question.",
                  },
                  limit: {
                    type: "integer",
                    minimum: 1,
                    maximum: 200,
                    description:
                      "Total number of hits across all sources (default 20). Must be an integer in 1..200; anything else is a 400.",
                  },
                  project: { type: "string" },
                  sources: {
                    type: "array",
                    items: { type: "string", enum: ["fact", "session", "doc"] },
                  },
                  scopes: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      'Doc lanes whose CONTENT the caller may see. Defaults to ["global"] when omitted. Unlike /recall\'s scopes, this does NOT filter the result set — out-of-lane hits are still returned with inScope:false and withheld content. Routing, not enforcement — self-declared by the caller.',
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Reverse-lookup cards (citation-only when out of lane), plus delivery accounting. meta.available includes withheld hits.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "meta"],
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/ImpactResult" } },
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
                  recentSessions: { type: "integer", minimum: 1, maximum: 200 },
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
    "/llms.txt": {
      get: {
        summary: "Agent-facing manual for this instance (llms.txt convention)",
        security: [],
        responses: {
          "200": {
            description: "Plain-text markdown manual",
            content: { "text/markdown": { schema: { type: "string" } } },
          },
        },
      },
    },
  },
} as const;
