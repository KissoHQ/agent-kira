import {
  addMessageToRequest,
  type AgentLimit,
  type AgentTurnRequest,
  type AgentTurnResult,
  assessDuplicate,
  type ClassifiedTurn,
  type Classifier,
  classifyTurn,
  type Database,
  describeContact,
  describeProject,
  type DuplicateJudge,
  explainForModel,
  fileUnhandledMessage,
  findRequest,
  forwardToTeam,
  isMessageFiled,
  isNotARequest,
  maxAnswerRetries,
  parseReference,
  prepareTurn,
  type RequestView,
  type ToolOutcome,
  type TurnInput,
  wrapUntrusted,
} from "@request-agent/core";

import { type AnswerContext, answerProblems, toPlainText } from "./answer-check.ts";
import type { AgentClient } from "./client.ts";
import { composeReply, filedForReviewReply } from "./reply.ts";

// The length of a question passed to the team when the system forwards the message itself.
const forwardedQuestionLength = 500;

export interface HandlingSettings {
  classify: Classifier;
  judgeDuplicate: DuplicateJudge;
  reviewThreshold: number;
  // Longest run of the agent on one message, all its calls and its rewrite included. A model that
  // stops answering would otherwise hold the queue of its channel forever. The run then ends like
  // at the step limit: what the tools did stays, and code writes the answer and files the message
  // for a person.
  agentTimeoutMs: number;
  // Told how each run of the agent ended, to report the runs a limit cut.
  onAgentRun?: (run: AgentRun) => void;
  // Told when the session of a handled message could not be ended: the agent keeps it until its
  // own timeout, and the message is answered all the same.
  onSessionNotEnded?: (messageId: string, error: unknown) => void;
}

export interface AgentRun {
  messageId: string;
  // Each call of the model, the answer written again after a rejection included.
  modelCalls: AgentTurnResult["modelCalls"];
  // Answers of the model the answer check rejected.
  rejectedAnswers: number;
  // The limit that stopped the model before it wrote its whole answer, if any.
  cutBy: AgentLimit | undefined;
}

export interface HandledMessage {
  // The answer to send to the sender, or null when none is needed, such as for thanks.
  reply: string | null;
  // True when the agent left the message unhandled and the system filed it for a review.
  filedBySystem: boolean;
}

function referencesIn(text: string): string[] {
  return Array.from(text.matchAll(/REQ-\d{1,9}/gi), (match) => match[0].toUpperCase());
}

// A question mark ending a sentence, as in "Où en êtes-vous ?", and not one inside a link.
function asksAQuestion(text: string): boolean {
  return /\?(\s|$)/.test(text);
}

// Information computed by code before the model runs, given to it so it does not spend a step on
// each. The codes of the database are given in plain words, like the results of the tools.
async function describeTurn(db: Database, turn: ClassifiedTurn): Promise<string> {
  const linked = await findRequest(db, turn, {});
  const { classification } = turn;
  const information = {
    today: new Date().toISOString().slice(0, 10),
    sender: await describeContact(db, turn),
    project: await describeProject(db, turn),
    classification: {
      type: classification.type,
      priority: classification.priority,
      confidence: Number(classification.confidence.toFixed(2)),
      reviewThreshold: turn.reviewThreshold,
    },
    requestLinkedToConversation: linked.ok ? explainForModel(linked.value) : null,
    // An open request the message may repeat: create_request then adds the message to it.
    possibleDuplicate: turn.duplicate,
    referencesInMessage: [...new Set(referencesIn(turn.messageText))],
  };
  return `Information computed by the system for the message to handle. It is reliable:\n${JSON.stringify(information, null, 2)}`;
}

// The requests an answer may name: those in the information given to the model, in the message,
// or returned by a tool. Tools only return requests the sender may reach.
function answerContext(
  system: string,
  messageText: string,
  outcomes: ToolOutcome[],
): AnswerContext {
  const seen = [system, messageText, JSON.stringify(outcomes.map((outcome) => outcome.result))];
  const knownReferences = new Set(
    seen
      .flatMap(referencesIn)
      .map(parseReference)
      .filter((requestNumber) => requestNumber !== undefined),
  );
  const forwarded = outcomes.some((o) => o.tool === "forward_to_team" && o.result.ok);
  const inProgress = seen.some((text) => /IN_PROGRESS|in progress: the team/.test(text));
  return { knownReferences, forwarded, inProgress };
}

// Types of a message about a request already made, which belongs with that request.
const followUpTypes = new Set<ClassifiedTurn["classification"]["type"]>([
  "FOLLOW_UP",
  "STATUS_REQUEST",
]);

// Types of a message that only asks something, which needs no request of its own once answered.
const questionTypes = new Set<ClassifiedTurn["classification"]["type"]>([
  "STATUS_REQUEST",
  "OTHER",
]);

// A follow-up that the agent answered without filing it is added by code to the request of its
// conversation, so that request keeps every message about it.
async function keepFollowUp(db: Database, turn: ClassifiedTurn): Promise<ToolOutcome | undefined> {
  if (!followUpTypes.has(turn.classification.type)) {
    return undefined;
  }
  const linked = await findRequest(db, turn, {});
  if (!linked.ok) {
    return undefined;
  }
  const result = await addMessageToRequest(db, turn, { reference: linked.value.request.reference });
  return { tool: "add_message_to_request", result };
}

// A support question answered from a help article needs no request of its own either.
function answeredFromKnowledge(turn: ClassifiedTurn, outcomes: ToolOutcome[]): boolean {
  return (
    turn.classification.type === "SUPPORT" &&
    outcomes.some((o) => o.tool === "search_knowledge_base" && o.result.length > 0)
  );
}

// A question asked to the sender is the answer itself: the agent stops there.
function askedForDetails(outcomes: ToolOutcome[]): boolean {
  return outcomes.some((o) => o.tool === "request_clarification" && o.result.ok);
}

function wasForwarded(outcomes: ToolOutcome[]): boolean {
  return outcomes.some((o) => o.tool === "forward_to_team" && o.result.ok);
}

// A question that got no answer which can be sent goes to the team, so that a person answers it,
// on the request of the message, of its conversation, or a new one.
async function forwardUnanswered(
  db: Database,
  turn: ClassifiedTurn,
  outcomes: ToolOutcome[],
): Promise<void> {
  if (!asksAQuestion(turn.messageText) || askedForDetails(outcomes) || wasForwarded(outcomes)) {
    return;
  }
  const question = turn.messageText.slice(0, forwardedQuestionLength);
  outcomes.push({ tool: "forward_to_team", result: await forwardToTeam(db, turn, { question }) });
}

function finalReply(
  answer: string,
  outcomes: ToolOutcome[],
  filedBySystem: RequestView | undefined,
): string {
  if (answer === "" || askedForDetails(outcomes)) {
    return composeReply(outcomes, filedBySystem);
  }
  return filedBySystem === undefined
    ? answer
    : `${answer}\n\n${filedForReviewReply(filedBySystem.reference)}`;
}

interface AgentAnswer {
  // The answer of the model that passed the check, or empty when none did.
  answer: string;
  result: AgentTurnResult;
  rejectedAnswers: number;
}

// Runs the agent on the message, then checks its answer. A rejected answer is sent back to the
// model with its problems, in the session of the message, as many times as maxAnswerRetries
// allows. An answer that a limit cut is never sent: it may stop in the middle of a sentence.
async function agentAnswer(
  agent: AgentClient,
  request: AgentTurnRequest,
  deadline: number,
): Promise<AgentAnswer> {
  let result = await agent.handle(request);
  let rejectedAnswers = 0;
  for (;;) {
    if (result.answer === "" || result.cutBy !== null) {
      return { answer: "", result, rejectedAnswers };
    }
    const context = answerContext(request.information, request.turn.messageText, result.outcomes);
    const problems = answerProblems(result.answer, context);
    if (problems.length === 0) {
      return { answer: toPlainText(result.answer), result, rejectedAnswers };
    }
    rejectedAnswers += 1;
    const remainingMs = deadline - Date.now();
    if (rejectedAnswers > maxAnswerRetries || remainingMs <= 0) {
      const cutBy = remainingMs <= 0 ? "time-limit" : null;
      return { answer: "", result: { ...result, cutBy }, rejectedAnswers };
    }
    // Each rewrite needs the answer before it: the calls cannot run together.
    // oxlint-disable-next-line no-await-in-loop
    result = await agent.rewrite({
      ...request,
      text: `Your answer cannot be sent. ${problems.join(" ")}`,
      timeoutMs: remainingMs,
    });
  }
}

// Runs the agent on one stored message, with tools bound to what its verified sender may do. The
// message is classified first: if the classification fails, nothing has been written. The model
// writes the answer, which code checks before it is sent; when no answer passes the check, the
// answer is written by code from what the tools really did.
export async function handleMessage(
  agent: AgentClient,
  db: Database,
  input: TurnInput,
  settings: HandlingSettings,
): Promise<HandledMessage> {
  const classified = await classifyTurn(db, await prepareTurn(db, input), settings);
  const turn = await assessDuplicate(db, classified, settings.judgeDuplicate);
  // Thanks or an advertisement needs no action: the agent is not run, which saves its calls. A
  // question gets an answer, even when it is not a request.
  if (isNotARequest(turn) && !asksAQuestion(turn.messageText)) {
    return { reply: null, filedBySystem: false };
  }
  const request: AgentTurnRequest = {
    turn,
    information: await describeTurn(db, turn),
    text: wrapUntrusted(turn.messageText),
    timeoutMs: settings.agentTimeoutMs,
  };
  let run: AgentAnswer;
  try {
    run = await agentAnswer(agent, request, Date.now() + settings.agentTimeoutMs);
  } finally {
    // The agent then deletes what it stored about the message, the database keeps it.
    await agent.end(turn.messageId).catch((error: unknown) => {
      settings.onSessionNotEnded?.(turn.messageId, error);
    });
  }
  const { answer, result, rejectedAnswers } = run;
  const outcomes = [...result.outcomes];
  settings.onAgentRun?.({
    messageId: turn.messageId,
    modelCalls: result.modelCalls,
    rejectedAnswers,
    cutBy: result.cutBy ?? undefined,
  });

  if (!(await isMessageFiled(db, turn.messageId))) {
    const kept = await keepFollowUp(db, turn);
    if (kept !== undefined) {
      outcomes.push(kept);
    }
  }
  if (answer === "") {
    await forwardUnanswered(db, turn, outcomes);
  }
  // A message still filed under no request is filed for a person, so none is lost, unless it only
  // asked a question that got its answer.
  const answeredQuestion =
    answer !== "" &&
    (questionTypes.has(turn.classification.type) || answeredFromKnowledge(turn, outcomes));
  const filedBySystem =
    answeredQuestion || (await isMessageFiled(db, turn.messageId))
      ? undefined
      : await fileUnhandledMessage(db, turn);
  return {
    reply: finalReply(answer, outcomes, filedBySystem),
    filedBySystem: filedBySystem !== undefined,
  };
}
