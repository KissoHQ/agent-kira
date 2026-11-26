import {
  agentServerUsername,
  type AgentTurnRequest,
  type AgentTurnResult,
  agentTurnReplySchema,
  maxAgentSteps,
  maxModelCallsPerMessage,
  prepareTurn,
  requests,
} from "@request-agent/core";
import {
  alice,
  bruno,
  classified,
  seedDatabase,
  storeMessage,
  useTestDatabase,
} from "@request-agent/core/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { type ScriptedStep, useScriptedAgent } from "../../test/index.ts";

const getDatabase = useTestDatabase();
const agent = useScriptedAgent();

beforeEach(async () => {
  await seedDatabase(getDatabase());
});

const information = "Information computed by the system for the message to handle: none.";

async function turnFor(
  sender: string,
  trust: "VERIFIED" | "UNVERIFIED" = "VERIFIED",
): Promise<AgentTurnRequest> {
  const messageId = await storeMessage(getDatabase(), {
    sender,
    bodyText: "Le portail ne répond plus.",
  });
  const turn = await prepareTurn(getDatabase(), { messageId, trust, channelAddress: null });
  return {
    turn: classified(turn, {}, "Le portail ne répond plus."),
    information,
    text: "<message>\nLe portail ne répond plus.\n</message>",
    timeoutMs: 30_000,
  };
}

const basic = (password: string) =>
  `Basic ${Buffer.from(`${agentServerUsername}:${password}`).toString("base64")}`;

function post(path: string, body: unknown, password = agent.password): Promise<Response> {
  return fetch(`${agent.url}/eve/v1/kira/messages/${path}`, {
    method: "POST",
    headers: { authorization: basic(password), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// The result of a turn, from the body the route streams.
async function resultOf(response: Response): Promise<AgentTurnResult> {
  const reply = agentTurnReplySchema.parse(await response.json());
  if ("error" in reply) {
    throw new Error(reply.error);
  }
  return reply.result;
}

async function handle(request: AgentTurnRequest, steps: ScriptedStep[]): Promise<AgentTurnResult> {
  agent.play(steps);
  const response = await post(request.turn.messageId, request);
  expect(response.status).toBe(200);
  return resultOf(response);
}

describe("the route of the agent", () => {
  it("refuses a request without the password of the agent, or with another one", async () => {
    const request = await turnFor(bruno);
    agent.play([{ text: "Bonjour" }]);

    const without = await fetch(`${agent.url}/eve/v1/kira/messages/${request.turn.messageId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const wrong = await post(request.turn.messageId, request, "another-password-of-32-characters!");

    expect(without.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(agent.calls()).toHaveLength(0);
  });

  it("refuses a body that is not a turn, and a turn about another message", async () => {
    const request = await turnFor(bruno);
    agent.play([{ text: "Bonjour" }]);

    const invalid = await post(request.turn.messageId, { ...request, timeoutMs: -1 });
    const other = await post("another-message", request);

    expect(invalid.status).toBe(400);
    expect(other.status).toBe(400);
    expect(agent.calls()).toHaveLength(0);
  });

  it("answers no other route of eve", async () => {
    const paths = ["/", "/eve/v1/health", "/eve/v1/session"];

    const statuses = await Promise.all(
      paths.map(async (path) => (await fetch(`${agent.url}${path}`, { method: "POST" })).status),
    );

    expect(Object.fromEntries(paths.map((path, index) => [path, statuses[index]]))).toEqual({
      "/": 404,
      "/eve/v1/health": 404,
      "/eve/v1/session": 404,
    });
  });

  it("runs the tools for the sender of the turn and returns what they did with the answer", async () => {
    const request = await turnFor(bruno);

    const result = await handle(request, [
      { toolCalls: [{ tool: "create_request", input: {} }] },
      { text: "Votre demande REQ-0001 est enregistrée." },
    ]);

    expect(result).toMatchObject({
      answer: "Votre demande REQ-0001 est enregistrée.",
      cutBy: null,
      outcomes: [{ tool: "create_request", result: { ok: true, value: { created: true } } }],
    });
    expect(result.modelCalls).toHaveLength(2);
    expect(result.modelCalls[0]).toEqual({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
      durationMs: expect.any(Number),
    });
    expect(await getDatabase().select().from(requests)).toHaveLength(1);
  });

  it("gives the model the information of the server, and the results of the tools in plain words", async () => {
    const request = await turnFor(bruno);

    await handle(request, [{ toolCalls: [{ tool: "create_request", input: {} }] }, { text: "ok" }]);

    const [first, second] = agent.calls();
    expect(first?.system).toContain(information);
    expect(first?.messages.map((message) => message.text).join("\n")).toContain(
      "Le portail ne répond plus.",
    );
    const results = JSON.stringify(second?.toolResults);
    expect(results).toContain("new: no one of the team has started on it yet");
    expect(results).not.toContain('"NEW"');
  });

  it("gives a verified contact all the request tools, and an unverified sender the tools to file", async () => {
    await handle(await turnFor(bruno), [{ text: "Bonjour" }]);
    const verified = agent.calls()[0]?.tools;
    await handle(await turnFor(alice, "UNVERIFIED"), [{ text: "Bonjour" }]);
    const unverified = agent.calls()[0]?.tools;

    expect(verified).toEqual([
      "add_message_to_request",
      "create_request",
      "find_request",
      "forward_to_team",
      "get_request_status",
      "identify_contact",
      "identify_project",
      "list_my_requests",
      "list_project_requests",
      "request_clarification",
      "search_knowledge_base",
      "search_requests",
      "update_request",
    ]);
    expect(unverified).toEqual(["create_request", "identify_contact", "identify_project"]);
  });

  it("stops the model at the step limit when it keeps calling tools", async () => {
    const request = await turnFor(bruno);

    const result = await handle(request, [
      { toolCalls: [{ tool: "get_request_status", input: { reference: "REQ-0001" } }] },
    ]);

    expect(result).toMatchObject({ answer: "", cutBy: "step-limit" });
    expect(result.modelCalls).toHaveLength(maxAgentSteps);
    expect(agent.calls()).toHaveLength(maxAgentSteps);
  });

  it("writes the answer again in the session of the message, within the limit of the message", async () => {
    const request = await turnFor(bruno);
    await handle(request, [
      { toolCalls: [{ tool: "create_request", input: {} }] },
      { text: "Je vais regarder." },
      { text: "Votre demande REQ-0001 est enregistrée." },
    ]);
    agent.play([{ text: "Votre demande REQ-0001 est enregistrée." }]);

    const response = await post(`${request.turn.messageId}/rewrite`, {
      ...request,
      text: "Your answer cannot be sent. It promises something.",
    });
    const result = await resultOf(response);

    expect(result).toMatchObject({
      answer: "Votre demande REQ-0001 est enregistrée.",
      cutBy: null,
      outcomes: [{ tool: "create_request" }],
    });
    expect(result.modelCalls).toHaveLength(3);
    expect(agent.calls()[0]?.messages.at(-1)?.text).toContain("It promises something.");
  });

  it("counts the rewrites in the limit of the message", async () => {
    const request = await turnFor(bruno);
    await handle(request, [
      { toolCalls: [{ tool: "get_request_status", input: { reference: "REQ-0001" } }] },
    ]);
    agent.play([{ toolCalls: [{ tool: "get_request_status", input: { reference: "REQ-0001" } }] }]);

    const response = await post(`${request.turn.messageId}/rewrite`, { ...request, text: "Again" });
    const result = await resultOf(response);

    expect(result).toMatchObject({ answer: "", cutBy: "step-limit" });
    expect(result.modelCalls).toHaveLength(maxModelCallsPerMessage);
  });

  it("refuses to rewrite the answer of a message that has no session", async () => {
    const request = await turnFor(bruno);
    agent.play([{ text: "ok" }]);

    const response = await post(`${request.turn.messageId}/rewrite`, request);

    expect(response.status).toBe(404);
  });

  it("stops the model at the time limit and keeps what the tools did", async () => {
    const request = await turnFor(bruno);

    const started = performance.now();
    const result = await handle({ ...request, timeoutMs: 1000 }, [
      { toolCalls: [{ tool: "create_request", input: {} }] },
      { text: "trop tard", delayMs: 20_000 },
    ]);

    expect(performance.now() - started).toBeLessThan(15_000);
    expect(result).toMatchObject({
      answer: "",
      cutBy: "time-limit",
      outcomes: [{ tool: "create_request" }],
    });
  });

  it("reports an answer that the full context window cut", async () => {
    const request = await turnFor(bruno);

    const result = await handle(request, [{ text: "Votre demande est", finishReason: "length" }]);

    expect(result).toMatchObject({ cutBy: "context-window" });
    expect(result.modelCalls).toHaveLength(1);
  });

  it("starts a new attempt at a message from the message alone", async () => {
    const request = await turnFor(bruno);
    await handle(request, [{ text: "Première tentative" }]);

    await handle(request, [{ text: "Seconde tentative" }]);

    const texts = agent.calls()[0]?.messages.map((message) => message.text) ?? [];
    expect(texts.join("\n")).not.toContain("Première tentative");
  });

  it("ends the session of a handled message", async () => {
    const request = await turnFor(bruno);
    await handle(request, [{ text: "ok" }]);

    const ended = await fetch(`${agent.url}/eve/v1/kira/messages/${request.turn.messageId}`, {
      method: "DELETE",
      headers: { authorization: basic(agent.password) },
    });
    const rewrite = await post(`${request.turn.messageId}/rewrite`, request);

    expect(ended.status).toBe(204);
    expect(rewrite.status).toBe(404);
  });

  it("tells it is ready when the database answers", async () => {
    const response = await fetch(`${agent.url}/eve/v1/kira/ready`);

    expect(response.status).toBe(200);
  });
});
