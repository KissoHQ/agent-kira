import { type ApiRoute, registerApiRoute } from "@mastra/core/server";

// Whether the server can do its work, for an orchestrator that sends it messages only when it can.
// /health only says that the process answers; /ready also checks what the work needs.

export type ChannelState = "off" | "starting" | "on" | "error";

export interface ReadinessChecks {
  // Whether the database answers.
  database: () => Promise<boolean>;
  // Whether Ollama answers and has the model of the agent.
  model: () => Promise<boolean>;
}

export interface ReadinessReport {
  ready: boolean;
  database: "ok" | "down";
  model: "ok" | "down";
  channels: Record<string, ChannelState>;
}

export function createReadiness(checks: ReadinessChecks) {
  const channels = new Map<string, ChannelState>();
  return {
    setChannel(name: string, state: ChannelState): void {
      channels.set(name, state);
    },
    async report(): Promise<ReadinessReport> {
      const [database, model] = await Promise.all([checks.database(), checks.model()]);
      const states = Object.fromEntries(channels);
      const channelsReady = [...channels.values()].every(
        (state) => state === "on" || state === "off",
      );
      return {
        ready: database && model && channelsReady,
        database: database ? "ok" : "down",
        model: model ? "ok" : "down",
        channels: states,
      };
    },
  };
}

export type Readiness = ReturnType<typeof createReadiness>;

// Longest wait for Ollama to list its models.
const modelCheckTimeoutMs = 5000;

// Whether Ollama answers its documented /api/tags and lists the model, with or without the
// implicit ":latest" tag.
export async function ollamaHasModel(options: {
  baseUrl: string;
  model: string;
  headers: Record<string, string>;
  fetch?: typeof fetch;
}): Promise<boolean> {
  const send = options.fetch ?? fetch;
  try {
    const response = await send(`${options.baseUrl.replace(/\/$/, "")}/tags`, {
      headers: options.headers,
      signal: AbortSignal.timeout(modelCheckTimeoutMs),
    });
    if (!response.ok) {
      return false;
    }
    const body: unknown = await response.json();
    const models =
      typeof body === "object" && body !== null && "models" in body && Array.isArray(body.models)
        ? body.models
        : [];
    return models.some(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "name" in entry &&
        (entry.name === options.model || entry.name === `${options.model}:latest`),
    );
  } catch {
    return false;
  }
}

// The /ready route: 200 when everything is ready, 503 otherwise, with what is not.
export function readinessRoute(readiness: Readiness): ApiRoute {
  return registerApiRoute("/ready", {
    method: "GET",
    requiresAuth: false,
    handler: async (c) => {
      const report = await readiness.report();
      return c.json(report, report.ready ? 200 : 503);
    },
  });
}
