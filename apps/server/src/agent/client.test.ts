import { type AgentTurnRequest, agentServerUsername } from "@request-agent/core";
import { classified } from "@request-agent/core/testing";
import { describe, expect, it } from "vitest";

import { createAgentClient } from "./client.ts";

const request: AgentTurnRequest = {
  turn: classified({
    actor: { kind: "anonymous" },
    messageId: "message/1",
    project: { status: "unknown" },
  }),
  information: "Information computed by the system.",
  text: "<message>\nBonjour\n</message>",
  timeoutMs: 1000,
};

const result = { answer: "Bonjour.", modelCalls: [], cutBy: null, outcomes: [] };

// The agent sends spaces while the turn runs, then its result.
const streamed = (body: unknown) =>
  new Response(`   ${JSON.stringify(body)}`, { headers: { "content-type": "application/json" } });

// A fetch that records what the client sends, and answers with the given response.
function recording(response: () => Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const send: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, init });
    return Promise.resolve(response());
  };
  return { calls, send };
}

const options = { url: "http://agent:4120/", password: "a-password-of-at-least-32-characters" };

// An agent that does not answer.
const down: typeof fetch = () => Promise.reject(new Error("connection refused"));

describe("createAgentClient", () => {
  it("sends the turn to the route of the message, with the password of the agent", async () => {
    const { calls, send } = recording(() => streamed({ result }));
    const client = createAgentClient({ ...options, fetch: send });

    expect(await client.handle(request)).toEqual(result);
    await client.rewrite(request);

    expect(calls.map((call) => call.url)).toEqual([
      "http://agent:4120/eve/v1/kira/messages/message%2F1",
      "http://agent:4120/eve/v1/kira/messages/message%2F1/rewrite",
    ]);
    const credentials = Buffer.from(`${agentServerUsername}:${options.password}`).toString(
      "base64",
    );
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: `Basic ${credentials}` });
    const body = calls[0]?.init?.body;
    expect(typeof body === "string" ? JSON.parse(body) : body).toEqual(request);
  });

  it("fails with the status when the agent refuses the turn", async () => {
    const { send } = recording(() => Response.json({ error: "denied" }, { status: 401 }));
    const client = createAgentClient({ ...options, fetch: send });

    await expect(client.handle(request)).rejects.toThrow(/HTTP 401/);
  });

  it("fails when the turn failed in the agent, or the agent answers something else", async () => {
    const failed = recording(() => streamed({ error: "The turn failed: Ollama is down" }));
    const invalid = recording(() => streamed({ result: { ...result, cutBy: "patience" } }));

    await expect(
      createAgentClient({ ...options, fetch: failed.send }).handle(request),
    ).rejects.toThrow(/Ollama is down/);
    await expect(
      createAgentClient({ ...options, fetch: invalid.send }).handle(request),
    ).rejects.toThrow(/cutBy|result/);
  });

  it("ends the session of a message, and fails when the agent refuses", async () => {
    const ended = recording(() => new Response(null, { status: 204 }));
    const refused = recording(() => new Response("", { status: 500 }));

    await createAgentClient({ ...options, fetch: ended.send }).end("message/1");

    expect(ended.calls[0]).toMatchObject({
      url: "http://agent:4120/eve/v1/kira/messages/message%2F1",
      init: { method: "DELETE" },
    });
    await expect(
      createAgentClient({ ...options, fetch: refused.send }).end("message/1"),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("tells the agent is not ready when it does not answer or answers an error", async () => {
    const failing = recording(() => Response.json({ ready: false }, { status: 503 }));
    const ready = recording(() => Response.json({ ready: true }));

    expect(await createAgentClient({ ...options, fetch: down }).ready()).toBe(false);
    expect(await createAgentClient({ ...options, fetch: failing.send }).ready()).toBe(false);
    expect(await createAgentClient({ ...options, fetch: ready.send }).ready()).toBe(true);
    expect(ready.calls[0]?.url).toBe("http://agent:4120/eve/v1/kira/ready");
  });
});
