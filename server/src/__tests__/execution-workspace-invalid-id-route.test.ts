import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";

describe("GET /api/execution-workspaces/:id", () => {
  const db = {
    select: () => {
      throw new Error("Malformed workspace ids must not reach the database");
    },
  } as unknown as Db;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", executionWorkspaceRoutes(db));
  app.use(errorHandler);

  it("returns the documented 404 response for a malformed workspace id", async () => {
    const response = await request(app).get("/api/execution-workspaces/not-a-uuid");

    expect({ status: response.status, body: response.body }).toEqual({
      status: 404,
      body: { error: "Execution workspace not found" },
    });
  });
});
