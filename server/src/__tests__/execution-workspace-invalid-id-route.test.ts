import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  executionWorkspaces,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";

const INVALID_ID = "not-a-uuid";
const WHITESPACE_WRAPPED_UUID = " 00000000-0000-4000-8000-000000000000 ";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping execution workspace invalid-id route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function setBoardActor(app: express.Express) {
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    next();
  });
}

function createLegacyLookupApp(db: Db) {
  const app = express();
  app.use(express.json());
  setBoardActor(app);
  app.get("/api/execution-workspaces/:id", async (req, res) => {
    await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, req.params.id as string));
    res.status(404).json({ error: "Execution workspace not found" });
  });
  app.use(errorHandler);
  return app;
}

function createApp(db: Db) {
  const app = express();
  app.use(express.json());
  setBoardActor(app);
  app.use("/api", executionWorkspaceRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("GET /api/execution-workspaces/:id", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-workspace-invalid-id-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await tempDb?.cleanup();
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("records the database-backed 500 before the guard and 404 after it", async () => {
    const legacyResponse = await request(createLegacyLookupApp(db))
      .get(`/api/execution-workspaces/${INVALID_ID}`);
    expect({ status: legacyResponse.status, body: legacyResponse.body }).toEqual({
      status: 500,
      body: { error: "Internal server error" },
    });

    const currentResponse = await request(createApp(db))
      .get(`/api/execution-workspaces/${INVALID_ID}`);
    expect({ status: currentResponse.status, body: currentResponse.body }).toEqual({
      status: 404,
      body: { error: "Execution workspace not found" },
    });
  });

  it.each([INVALID_ID, WHITESPACE_WRAPPED_UUID])(
    "does not send malformed id %j to either workspace lookup predicate",
    async (id) => {
      const dbWithoutIdPredicates = {
        select: vi.fn(() => {
          throw new Error("Malformed workspace ids must not reach the database");
        }),
      } as unknown as Db;
      const service = executionWorkspaceService(dbWithoutIdPredicates);

      await expect(service.getById(id)).resolves.toBeNull();
      await expect(service.getCloseReadiness(id)).resolves.toBeNull();
      expect(dbWithoutIdPredicates.select).not.toHaveBeenCalled();
    },
  );

  it.each([
    `/api/execution-workspaces/${INVALID_ID}`,
    `/api/execution-workspaces/${INVALID_ID}/close-readiness`,
  ])("returns the documented 404 response for %s", async (path) => {
    const response = await request(createApp(db)).get(path);

    expect({ status: response.status, body: response.body }).toEqual({
      status: 404,
      body: { error: "Execution workspace not found" },
    });
  });
});
