import {
  agentServerUsername,
  type AgentTurnReply,
  type AgentTurnRequest,
  agentTurnRequestSchema,
  pingDatabase,
} from "@request-agent/core";
import { DELETE, defineChannel, GET, POST, type RouteHandlerArgs } from "eve/channels";
import { httpBasic, routeAuth } from "eve/channels/auth";
import { emptySessionView, foldEvents, type SessionView } from "eve/events";
import type { DeliveryResult, Session } from "eve/sessions";

import { agentEnv } from "../lib/env.ts";
import { agentResources } from "../lib/resources.ts";
import { turnCaller } from "../lib/turn.ts";
import { turnResult } from "../lib/turn-result.ts";

// The only way in: the server sends each message here, on the internal network, with the password
// of the agent. One session of eve holds one message, at the address of its ID: the turn that
// handles it, then the turn that writes its answer again when the server rejected it.

// Largest body accepted: a turn holds a message of at most 10,500 characters and its information.
const maxBodyBytes = 128 * 1024;

// Longest wait for a turn to stop once the route cancelled it at the time limit.
const cancelWaitMs = 60_000;

// fetch of Node.js gives up on an answer whose headers, or next bytes, take more than 300 s, and
// a turn takes longer on a CPU. The route sends its headers at once, then a space at this interval
// while the turn runs, then the result: JSON allows spaces before a value.
const heartbeatMs = 15_000;

let auth: ReturnType<typeof httpBasic> | undefined;

// The password is read when the first request comes: eve also loads this file while it builds.
async function denied(request: Request): Promise<Response | undefined> {
  auth ??= httpBasic({ username: agentServerUsername, password: agentEnv().password });
  const caller = await routeAuth(request, auth);
  return caller instanceof Response ? caller : undefined;
}

const problem = (status: number, error: string) => Response.json({ error }, { status });

// The body as JSON, or undefined when it is too large or not JSON. The size is checked before the
// body is read, from its declared length.
async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (!Number.isInteger(declared) || declared <= 0 || declared > maxBodyBytes) {
    return undefined;
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > maxBodyBytes) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function readTurnRequest(
  request: Request,
  messageId: string,
): Promise<AgentTurnRequest | Response> {
  const parsed = agentTurnRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return problem(400, "The body is not a valid turn, or it is larger than allowed.");
  }
  if (parsed.data.turn.messageId !== messageId) {
    return problem(400, "The turn is about another message.");
  }
  return parsed.data;
}

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

async function sessionView(session: Session): Promise<SessionView> {
  let view = emptySessionView();
  for await (const event of session.stream({ follow: false })) {
    view = foldEvents(view, [event]);
  }
  return view;
}

// Sends one turn and waits for its end, at most until the time limit: the turn is then cancelled,
// and what its tools did stays.
async function runTurn(
  args: RouteHandlerArgs,
  messageId: string,
  body: AgentTurnRequest,
): Promise<AgentTurnReply> {
  const source = args.from(messageId);
  // eve keeps the title of a session after it deleted the session: by default the start of the
  // message, so it is named after the ID of the message instead.
  const delivery = await source.send(body.text, {
    auth: turnCaller(body),
    title: `Message ${messageId}`,
  });
  let timedOut = false;
  let result: DeliveryResult;
  try {
    result = await delivery.result({ signal: AbortSignal.timeout(body.timeoutMs) });
  } catch (error) {
    if (!isTimeout(error)) {
      throw error;
    }
    timedOut = true;
    await source.cancel();
    result = await delivery.result({ signal: AbortSignal.timeout(cancelWaitMs) });
  }
  if (result.status === "failed") {
    // The server retries the message later, as for any failure of the model.
    return { error: `The turn failed: ${result.error.message}` };
  }
  const view = await sessionView(args.attachSession(result.sessionId));
  return {
    result: turnResult(view, {
      reply: result.reply,
      cancelled: result.status === "cancelled",
      timedOut,
    }),
  };
}

// The answer to a turn, sent as the turn runs: its headers at once, spaces while it runs, then
// its result, or why it failed.
function streamedReply(reply: Promise<AgentTurnReply>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const heartbeat = setInterval(() => controller.enqueue(encoder.encode(" ")), heartbeatMs);
      try {
        controller.enqueue(encoder.encode(JSON.stringify(await reply)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controller.enqueue(encoder.encode(JSON.stringify({ error: message })));
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/json" } });
}

export default defineChannel({
  routes: [
    // Handles a message. An earlier attempt at the same message, cut by a restart, is ended first:
    // each attempt starts from the message alone.
    POST("/eve/v1/kira/messages/:messageId", async (request, args) => {
      const refused = await denied(request);
      if (refused !== undefined) {
        return refused;
      }
      const messageId = args.params.messageId ?? "";
      const body = await readTurnRequest(request, messageId);
      if (body instanceof Response) {
        return body;
      }
      const earlier = await args.resolveSession(messageId);
      if (earlier !== undefined) {
        await earlier.end({ reason: "A new attempt handles the message." });
      }
      return streamedReply(runTurn(args, messageId, body));
    }),

    // Asks the model to write its answer again, in the session of the message, with the reasons
    // the server rejected it.
    POST("/eve/v1/kira/messages/:messageId/rewrite", async (request, args) => {
      const refused = await denied(request);
      if (refused !== undefined) {
        return refused;
      }
      const messageId = args.params.messageId ?? "";
      const body = await readTurnRequest(request, messageId);
      if (body instanceof Response) {
        return body;
      }
      if ((await args.resolveSession(messageId)) === undefined) {
        return problem(404, "No session handles this message.");
      }
      return streamedReply(runTurn(args, messageId, body));
    }),

    // Ends the session of a handled message. eve then deletes what it stored about it.
    DELETE("/eve/v1/kira/messages/:messageId", async (request, args) => {
      const refused = await denied(request);
      if (refused !== undefined) {
        return refused;
      }
      const session = await args.resolveSession(args.params.messageId ?? "");
      if (session !== undefined) {
        await session.end({ reason: "The message is handled." });
      }
      return new Response(null, { status: 204 });
    }),

    // Whether the agent can work: its settings are valid and the database answers. It tells
    // nothing else, so it needs no password.
    GET("/eve/v1/kira/ready", async () => {
      try {
        const ready = await pingDatabase(agentResources().db);
        return Response.json({ ready }, { status: ready ? 200 : 503 });
      } catch {
        return Response.json({ ready: false }, { status: 503 });
      }
    }),
  ],
});
