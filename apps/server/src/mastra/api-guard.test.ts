import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { apiGuard } from "./api-guard";

function serverWith(development: boolean): Hono {
  const app = new Hono();
  app.use("*", apiGuard({ development }));
  app.get("/health", (c) => c.text("ok"));
  app.get("/api/agents", (c) => c.text("agents"));
  app.post("/api/agents/request-agent/model", (c) => c.text("changed"));
  app.get("/", (c) => c.text("studio"));
  return app;
}

async function call(
  app: Hono,
  path: string,
  init: { method?: string; headers?: Record<string, string> },
): Promise<Response> {
  return app.request(`http://server${path}`, {
    method: init.method ?? "GET",
    headers: init.headers,
  });
}

describe("apiGuard on a running server", () => {
  const app = serverWith(false);

  it("keeps the health check reachable", async () => {
    const response = await call(app, "/health", { headers: { host: "kira.example.com" } });
    expect(response.status).toBe(200);
  });

  it("serves neither the agent API nor Studio, even from this machine", async () => {
    const responses = await Promise.all(
      (
        [
          ["GET", "/api/agents"],
          ["POST", "/api/agents/request-agent/model"],
          ["GET", "/"],
        ] as const
      ).map(([method, path]) => call(app, path, { method, headers: { host: "localhost:4111" } })),
    );
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
  });

  it("refuses a path written with a backslash, which some proxies let through", async () => {
    const response = await call(app, "/api\\agents", { headers: { host: "localhost:4111" } });
    expect(response.status).toBe(404);
  });
});

describe("apiGuard with mastra dev", () => {
  const app = serverWith(true);

  it("serves the agent API and Studio to this machine", async () => {
    const responses = await Promise.all(
      ["localhost:4111", "127.0.0.1:4111", "[::1]:4111"].map((host) =>
        call(app, "/api/agents", { headers: { host } }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    const studio = await call(app, "/", { headers: { host: "localhost:4111" } });
    expect(studio.status).toBe(200);
  });

  it("accepts a request from Studio, which runs on the server itself", async () => {
    const response = await call(app, "/api/agents/request-agent/model", {
      method: "POST",
      headers: { host: "localhost:4111", origin: "http://localhost:4111" },
    });
    expect(response.status).toBe(200);
  });

  it("refuses a page of another site open in the browser of this machine", async () => {
    const response = await call(app, "/api/agents/request-agent/model", {
      method: "POST",
      headers: { host: "localhost:4111", origin: "https://attacker.example" },
    });
    expect(response.status).toBe(403);
  });

  it("refuses a site whose name points to this machine (DNS rebinding)", async () => {
    const response = await call(app, "/api/agents", {
      headers: { host: "attacker.example:4111", origin: "http://attacker.example:4111" },
    });
    expect(response.status).toBe(403);
  });

  it("refuses a request that reaches the server through the network", async () => {
    const responses = await Promise.all(
      ["192.168.1.20:4111", "kira.example.com"].map((host) =>
        call(app, "/api/agents", { headers: { host } }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([403, 403]);
  });

  it("refuses a request without a host", async () => {
    const response = await app.request(new Request("http://server/api/agents"));
    expect(response.status).toBe(403);
  });
});
