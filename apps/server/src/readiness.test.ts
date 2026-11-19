import { describe, expect, it } from "vitest";

import { createReadiness, ollamaHasModel } from "./readiness";

const up = () => Promise.resolve(true);
const down = () => Promise.resolve(false);

describe("createReadiness", () => {
  it("is ready when the database, the model and every started channel are", async () => {
    const readiness = createReadiness({ database: up, model: up });
    readiness.setChannel("Slack", "on");
    readiness.setChannel("Email", "off");

    expect(await readiness.report()).toEqual({
      ready: true,
      database: "ok",
      model: "ok",
      channels: { Slack: "on", Email: "off" },
    });
  });

  it("is not ready while a channel starts or failed, or when the database or model is down", async () => {
    const starting = createReadiness({ database: up, model: up });
    starting.setChannel("Email", "starting");
    const failed = createReadiness({ database: up, model: up });
    failed.setChannel("Slack", "error");

    expect((await starting.report()).ready).toBe(false);
    expect((await failed.report()).ready).toBe(false);
    expect(await createReadiness({ database: down, model: up }).report()).toMatchObject({
      ready: false,
      database: "down",
    });
    expect(await createReadiness({ database: up, model: down }).report()).toMatchObject({
      ready: false,
      model: "down",
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
