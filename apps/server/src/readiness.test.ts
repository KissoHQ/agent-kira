import { describe, expect, it } from "vitest";

import { createHealthApp, createReadiness, ollamaHasModel } from "./readiness.ts";

const up = () => Promise.resolve(true);
const down = () => Promise.resolve(false);

describe("createReadiness", () => {
  it("is ready when the database, the model and every started channel are", async () => {
    const readiness = createReadiness({ database: up, model: up, agent: up });
    readiness.setChannel("Slack", "on");
    readiness.setChannel("Email", "off");

    expect(await readiness.report()).toEqual({
      ready: true,
      database: "ok",
      model: "ok",
      agent: "ok",
      channels: { Slack: "on", Email: "off" },
    });
  });

  it("is not ready while a channel starts or failed, or when the database, model or agent is down", async () => {
    const starting = createReadiness({ database: up, model: up, agent: up });
    starting.setChannel("Email", "starting");
    const failed = createReadiness({ database: up, model: up, agent: up });
    failed.setChannel("Slack", "error");

    expect((await starting.report()).ready).toBe(false);
    expect((await failed.report()).ready).toBe(false);
    expect(await createReadiness({ database: down, model: up, agent: up }).report()).toMatchObject({
      ready: false,
      database: "down",
    });
    expect(await createReadiness({ database: up, model: down, agent: up }).report()).toMatchObject({
      ready: false,
      model: "down",
    });
    expect(await createReadiness({ database: up, model: up, agent: down }).report()).toMatchObject({
      ready: false,
      agent: "down",
    });
  });
});

// What Ollama answers to /api/tags when these models are pulled.
const tags =
  (names: string[]): typeof fetch =>
  () =>
    Promise.resolve(Response.json({ models: names.map((name) => ({ name })) }));

describe("ollamaHasModel", () => {
  it("finds the model, with or without its latest tag", async () => {
    const options = { baseUrl: "http://ollama/api", headers: {} };

    expect(
      await ollamaHasModel({ ...options, model: "ornith:9b", fetch: tags(["ornith:9b"]) }),
    ).toBe(true);
    expect(
      await ollamaHasModel({ ...options, model: "llama3", fetch: tags(["llama3:latest"]) }),
    ).toBe(true);
    expect(
      await ollamaHasModel({ ...options, model: "ornith:9b", fetch: tags(["other:1b"]) }),
    ).toBe(false);
  });

  it("is false when Ollama does not answer or answers an error", async () => {
    const options = { baseUrl: "http://ollama/api", model: "ornith:9b", headers: {} };

    expect(
      await ollamaHasModel({ ...options, fetch: () => Promise.reject(new Error("down")) }),
    ).toBe(false);
    expect(
      await ollamaHasModel({
        ...options,
        fetch: () => Promise.resolve(new Response("", { status: 404 })),
      }),
    ).toBe(false);
  });
});

describe("createHealthApp", () => {
  it("answers /health while the process runs, and /ready with what is missing", async () => {
    const app = createHealthApp(createReadiness({ database: up, model: up, agent: down }));

    const health = await app.request("/health");
    const ready = await app.request("/ready");

    expect(health.status).toBe(200);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ ready: false, agent: "down" });
  });

  it("answers no other route", async () => {
    const app = createHealthApp(createReadiness({ database: up, model: up, agent: up }));

    expect((await app.request("/api/agents")).status).toBe(404);
    expect((await app.request("/ready", { method: "POST" })).status).toBe(404);
  });
});
