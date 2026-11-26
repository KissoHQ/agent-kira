import { z } from "zod";

import type { Classification } from "../classification/classifier.ts";
import { requestPriority, requestType } from "../db/schema.ts";
import type { ClassifiedTurn } from "../requests/classified-turn.ts";
import { isToolOutcome, type ToolOutcome } from "./tool-outcome.ts";

// What the server and the agent send each other. The agent runs in its own process, built by eve;
// the server calls it on an internal route, protected by a password that only the two of them
// know. Both sides check what they receive against these schemas.

// Name of the server in the Basic authentication of the agent. The password is the secret.
export const agentServerUsername = "kira-server";

// Steps of the model allowed for one message: acting on the message, looking up what the answer
// needs, then writing it. It bounds the work a message can trigger: an injected instruction cannot
// make the agent loop over the tools.
export const maxAgentSteps = 8;

// How many times the model may write the answer again after the server rejected it. The rewrite
// is one more call of the model, which the limit of the message counts.
export const maxAnswerRetries = 1;

// Calls of the model allowed for one message, its rewrites included.
export const maxModelCallsPerMessage = maxAgentSteps + maxAnswerRetries;

// The subject and body of a message, wrapped as untrusted text, or the reasons a rejected answer
// must be written again. Longer text is refused rather than cut.
const maxTurnTextLength = 20_000;

// The information computed by the server before the model runs, as JSON.
const maxInformationLength = 20_000;

// Longest run of the agent the server may ask for: one day. The server sets the real limit.
const maxTimeoutMs = 24 * 60 * 60 * 1000;

const actorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("contact"),
    contactId: z.string().min(1),
    projectIds: z.array(z.string().min(1)),
  }),
  z.object({ kind: z.literal("anonymous") }),
]);

const projectSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("identified"),
    projectId: z.string().min(1),
    source: z.enum(["CHANNEL", "MENTION", "CONTACT"]),
  }),
  z.object({ status: z.literal("ambiguous"), candidateIds: z.array(z.string().min(1)) }),
  z.object({ status: z.literal("unknown") }),
]);

const classificationSchema: z.ZodType<Classification> = z.object({
  type: z.enum(requestType.enumValues),
  priority: z.enum(requestPriority.enumValues).nullable(),
  title: z.string(),
  summary: z.string(),
  confidence: z.number().min(0).max(1),
  model: z.string(),
  promptVersion: z.string(),
});

// The message being handled, who sent it and what the server computed about it. The tools act for
// this sender only.
export const classifiedTurnSchema: z.ZodType<ClassifiedTurn> = z.object({
  actor: actorSchema,
  messageId: z.string().min(1),
  project: projectSchema,
  messageText: z.string(),
  classification: classificationSchema,
  reviewThreshold: z.number().min(0).max(1),
  duplicate: z
    .object({ reference: z.string().min(1), confidence: z.number().min(0).max(1) })
    .nullable(),
});

// One turn of the agent: the message to handle, or the reasons its answer was rejected.
export const agentTurnRequestSchema = z.object({
  turn: classifiedTurnSchema,
  // The information computed by the server, given to the model as reliable.
  information: z.string().min(1).max(maxInformationLength),
  // What the model reads as the input of the turn.
  text: z.string().min(1).max(maxTurnTextLength),
  // Longest time the turn may take. The agent stops the model when it runs out.
  timeoutMs: z.number().int().positive().max(maxTimeoutMs),
});

export type AgentTurnRequest = z.infer<typeof agentTurnRequestSchema>;

// The limit that stopped the model before it wrote its whole answer.
const agentLimits = ["step-limit", "time-limit", "context-window"] as const;
export type AgentLimit = (typeof agentLimits)[number];

// What the tools return is built by the agent from the database: it is checked by its tool name
// only, and its content is typed by the functions of this package that produced it.
const toolOutcomeSchema = z.custom<ToolOutcome>(isToolOutcome, {
  message: "Must be the outcome of a tool of the agent",
});

export const agentTurnResultSchema = z.object({
  // The answer the model wrote, empty when it wrote none: a limit cut it, or it asked the sender a
  // question, which is the answer.
  answer: z.string(),
  // Each call of the model for the message so far, the rewrites included: the tokens it read and
  // wrote, and how long it took.
  modelCalls: z.array(
    z.object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      durationMs: z.number().int().nonnegative(),
    }),
  ),
  cutBy: z.enum(agentLimits).nullable(),
  // What every tool did for the message so far, in the order of the calls.
  outcomes: z.array(toolOutcomeSchema),
});

export type AgentTurnResult = z.infer<typeof agentTurnResultSchema>;

// The body of the answer of the agent to a turn: its result, or why the turn failed. The agent
// sends its headers at once and spaces while the turn runs, so it can no longer send an error
// status once the turn has started.
export const agentTurnReplySchema = z.union([
  z.object({ result: agentTurnResultSchema }),
  z.object({ error: z.string() }),
]);

export type AgentTurnReply = z.infer<typeof agentTurnReplySchema>;
