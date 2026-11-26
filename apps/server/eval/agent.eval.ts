// Measures the agent with the real model, on the fictitious messages of agent-messages.json: how
// many model calls each kind of message takes, how many tokens they send and write, and how long
// each call to Ollama takes on the machine that runs it. The limits of the agent are set from
// these measures, as docs/agent.md describes. It builds and starts the agent of apps/agent, with
// Ollama, on a temporary database dropped at the end. It is slow on a CPU, so it is not part of
// the tests. Usage: pnpm eval:agent
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildAgent, productionAgentRoot, startAgent } from "@request-agent/agent/testing";
import {
  type Classifier,
  connectDatabase,
  createOllamaClassifier,
  createOllamaDuplicateJudge,
  createOllamaEmbedder,
  type DuplicateJudge,
  loadAppDatabaseEnv,
  loadClassifierEnv,
  loadKnowledgeEnv,
  loadServerDatabaseEnv,
  maxAgentSteps,
  maxAnswerRetries,
  modelContextTokens,
  ollamaHeaders,
  saveArticle,
  storeInboundMessage,
  timeoutSeconds,
} from "@request-agent/core";
import {
  asRole,
  createDatabaseIfMissing,
  demoArticles,
  disposableDatabaseName,
  dropDatabaseIfExists,
  loadTestDatabaseEnv,
  prepareDatabase,
  seedDatabase,
} from "@request-agent/core/testing";
import { expect, it } from "vitest";
import { z } from "zod";

import { createAgentClient } from "../src/agent/client.ts";
import { type AgentRun, handleMessage } from "../src/agent/handle-message.ts";
import { type HandlingLimits, loadHandlingLimits } from "../src/config.ts";

const rootEnvFile = fileURLToPath(new URL("../../../.env", import.meta.url));

// Long enough never to cut a call: the limits set in .env are compared with the measures after.
const measureTimeoutMs = 60 * 60 * 1000;

// The time limit of the search of the help articles, which the agent reads.
const embeddingEnvSchema = z.object({ EMBEDDING_TIMEOUT_SECONDS: timeoutSeconds(60) });

const sampleSchema = z.array(
  z.object({
    case: z.string().min(1),
    channel: z.enum(["EMAIL", "SLACK", "WIDGET"]),
    sender: z.string().min(1),
    trust: z.enum(["VERIFIED", "UNVERIFIED"]),
    // Messages with the same thread belong to the same conversation.
    thread: z.string().min(1),
    channelAddress: z.string().optional(),
    subject: z.string().optional(),
    text: z.string().min(1),
  }),
);

interface Measure {
  case: string;
  type: string;
  // Calls to the model in the run of the agent; 0 when the agent was not run, as for thanks.
  modelCalls: number;
  rejectedAnswers: number;
  cutBy: AgentRun["cutBy"];
  // Tokens each call of the agent sent to the model, and wrote.
  promptTokens: number[];
  answerTokens: number[];
  // Each call that classifies the message or judges a duplicate.
  classificationSeconds: number[];
  // A call that turns the message into a vector, as the search of the help articles does with a
  // question.
  embeddingSeconds: number[];
  // Each call of the agent to the model.
  stepSeconds: number[];
  totalSeconds: number;
  error?: string;
}

function newMeasure(name: string): Measure {
  return {
    case: name,
    type: "-",
    modelCalls: 0,
    rejectedAnswers: 0,
    cutBy: undefined,
    promptTokens: [],
    answerTokens: [],
    classificationSeconds: [],
    embeddingSeconds: [],
    stepSeconds: [],
    totalSeconds: 0,
  };
}

// Vitest hides the console of a passed test outside a terminal, so the report is written to the
// standard output directly.
const print = (line: string) => process.stdout.write(`${line}\n`);

const secondsSince = (started: number) => (performance.now() - started) / 1000;

async function timed<T>(record: number[], call: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await call();
  } finally {
    record.push(secondsSince(started));
  }
}

// A model is loaded into memory by its first call, which then takes longer. Unloading the models
// first makes the measures include that wait, as after a restart of Ollama.
async function unloadModel(baseUrl: string, apiKey: string | undefined, model: string) {
  const response = await fetch(`${baseUrl}/generate`, {
    method: "POST",
    headers: ollamaHeaders(apiKey),
    body: JSON.stringify({ model, keep_alive: 0 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Ollama did not unload ${model}: HTTP ${response.status}`);
  }
}

// A database next to the test database, on the same server, so the tests and this measure never
// empty each other's data.
function measureDatabaseUrl(testDatabaseUrl: string): string {
  const url = new URL(testDatabaseUrl);
  url.pathname = `/${disposableDatabaseName(testDatabaseUrl).replace(/_test$/, "_eval_test")}`;
  return url.href;
}

const largest = (values: number[]) => Math.max(0, ...values);
// Calls of the first turn of the agent: the answers written again after a rejection are apart.
const countedSteps = (m: Measure) => m.modelCalls - m.rejectedAnswers;
const format = (seconds: number) => `${seconds.toFixed(1)} s`;

function reportMeasures(measures: Measure[]): void {
  print(
    "\nMessage | type | model calls | rejected answers | limit that cut it | largest prompt | " +
      "slowest call: classification, step | total",
  );
  for (const m of measures) {
    print(
      `${m.case} | ${m.type} | ${m.modelCalls} | ${m.rejectedAnswers} | ${m.cutBy ?? "none"} | ` +
        `${largest(m.promptTokens)} tokens | ` +
        `${format(largest(m.classificationSeconds))}, ${format(largest(m.stepSeconds))} | ${format(m.totalSeconds)}` +
        (m.error === undefined ? "" : ` | error: ${m.error}`),
    );
  }
}

function checkLimit(name: string, neededSeconds: number, setMs: number): void {
  const needed = Math.ceil(neededSeconds);
  const set = setMs / 1000;
  print(
    `  ${name}: at least ${needed} s from these measures; set to ${set} s: ${set >= needed ? "enough" : "too short"}`,
  );
}

// The prompt of the agent grows at each call with what the model wrote and what the tools
// returned. The longest run the step limit allows starts with the largest first prompt, grows by
// the largest growth measured at each of its next calls, and ends with the longest answer.
function reportContextWindow(measures: Measure[]): void {
  const firstPrompt = largest(measures.map((m) => m.promptTokens[0] ?? 0));
  const growth = largest(
    measures.flatMap((m) =>
      m.promptTokens.slice(1).map((tokens, call) => tokens - (m.promptTokens[call] ?? tokens)),
    ),
  );
  const answer = largest(measures.flatMap((m) => m.answerTokens));
  const nextCalls = maxAgentSteps + maxAnswerRetries - 1;
  const needed = firstPrompt + nextCalls * growth + answer;
  print("\nContext window, from the largest prompt and answer measured:");
  print(
    `  modelContextTokens = largest first prompt + ${nextCalls} x largest growth + longest answer` +
      ` = ${firstPrompt} + ${nextCalls} x ${growth} + ${answer}: at least ${needed} tokens;` +
      ` set to ${modelContextTokens}: ${modelContextTokens >= needed ? "enough" : "too small"}`,
  );
}

function reportLimits(
  measures: Measure[],
  limits: HandlingLimits & { embeddingTimeoutMs: number },
): void {
  const most = measures.reduce((a, b) => (countedSteps(b) > countedSteps(a) ? b : a));
  const cut = measures.filter((m) => m.cutBy !== undefined);
  print(
    `\nStep limit: ${maxAgentSteps} steps, plus ${maxAnswerRetries} answer written again after a rejection.`,
  );
  print(
    `  Most steps for one message, rejected answers apart: ${countedSteps(most)} (${most.case});` +
      ` ${maxAgentSteps >= countedSteps(most) ? "enough" : "too few"}.`,
  );
  print(
    `  Runs cut by a limit: ${cut.length === 0 ? "none" : cut.map((m) => `${m.case} (${m.cutBy})`).join(", ")}.`,
  );
  const all = (pick: (m: Measure) => number[]) => measures.flatMap(pick);
  print("\nTime limits, from the slowest call measured:");
  checkLimit(
    "CLASSIFICATION_TIMEOUT_SECONDS",
    largest(all((m) => m.classificationSeconds)),
    limits.classificationTimeoutMs,
  );
  checkLimit(
    "EMBEDDING_TIMEOUT_SECONDS",
    largest(all((m) => m.embeddingSeconds)),
    limits.embeddingTimeoutMs,
  );
  // The longest run the step limit allows, every step as slow as the slowest one measured.
  checkLimit(
    `AGENT_TIMEOUT_SECONDS = (${maxAgentSteps} + ${maxAnswerRetries}) x slowest step`,
    (maxAgentSteps + maxAnswerRetries) * largest(all((m) => m.stepSeconds)),
    limits.agentTimeoutMs,
  );
}

it("measures the agent with the real model", async () => {
  if (existsSync(rootEnvFile)) {
    process.loadEnvFile(rootEnvFile);
  }
  const limits = {
    ...loadHandlingLimits(),
    embeddingTimeoutMs: embeddingEnvSchema.parse(process.env).EMBEDDING_TIMEOUT_SECONDS * 1000,
  };
  const classifierEnv = loadClassifierEnv();
  const { OLLAMA_EMBEDDING_MODEL } = loadKnowledgeEnv();
  const { OLLAMA_BASE_URL: baseUrl, OLLAMA_API_KEY: apiKey, OLLAMA_MODEL: model } = classifierEnv;
  const samples = sampleSchema.parse(
    JSON.parse(readFileSync(new URL("agent-messages.json", import.meta.url), "utf8")),
  );
  const databaseUrl = measureDatabaseUrl(loadTestDatabaseEnv().TEST_DATABASE_URL);
  const serverDatabaseUrl = loadServerDatabaseEnv().SERVER_DATABASE_URL;

  // A database left by an interrupted measure is dropped first.
  await dropDatabaseIfExists(databaseUrl);
  await createDatabaseIfMissing(databaseUrl);
  await prepareDatabase(databaseUrl, loadAppDatabaseEnv().APP_DATABASE_URL, serverDatabaseUrl);
  const owner = connectDatabase(databaseUrl);
  const server = connectDatabase(asRole(databaseUrl, serverDatabaseUrl));
  // The agent of apps/agent, as the server reaches it in production, on the temporary database.
  const password = randomBytes(32).toString("hex");
  await buildAgent(productionAgentRoot);
  const agentProcess = await startAgent(productionAgentRoot, {
    SERVER_DATABASE_URL: asRole(databaseUrl, serverDatabaseUrl),
    AGENT_PASSWORD: password,
    EMBEDDING_TIMEOUT_SECONDS: String(measureTimeoutMs / 1000),
  });
  try {
    const ollamaOptions = { baseUrl, model, timeoutMs: measureTimeoutMs, apiKey };
    const embedder = createOllamaEmbedder({ ...ollamaOptions, model: OLLAMA_EMBEDDING_MODEL });
    await seedDatabase(owner.db);
    for (const article of demoArticles) {
      // One article at a time, as `pnpm kb:import` does.
      // oxlint-disable-next-line no-await-in-loop
      await saveArticle(owner.db, embedder, article);
    }
    await unloadModel(baseUrl, apiKey, model);
    await unloadModel(baseUrl, apiKey, OLLAMA_EMBEDDING_MODEL);

    let current = newMeasure("");
    const classify = createOllamaClassifier(ollamaOptions);
    const judge = createOllamaDuplicateJudge(ollamaOptions);
    const timedClassify: Classifier = async (input) => {
      const classification = await timed(current.classificationSeconds, () => classify(input));
      current.type = classification.type;
      return classification;
    };
    const timedJudge: DuplicateJudge = (input) =>
      timed(current.classificationSeconds, () => judge(input));
    const agent = createAgentClient({ url: agentProcess.url, password });

    const measures: Measure[] = [];
    for (const [index, sample] of samples.entries()) {
      current = newMeasure(sample.case);
      const started = performance.now();
      try {
        // Messages are handled one at a time, like in a channel, to measure the real latency.
        // oxlint-disable-next-line no-await-in-loop
        const stored = await storeInboundMessage(server.db, {
          channel: sample.channel,
          conversationExternalId: sample.thread,
          externalId: `eval-${index}`,
          sender: sample.sender,
          subject: sample.subject ?? null,
          bodyText: sample.text,
          raw: {},
          sentAt: new Date(),
        });
        const measure = current;
        // oxlint-disable-next-line no-await-in-loop
        await handleMessage(
          agent,
          server.db,
          {
            messageId: stored.messageId,
            trust: sample.trust,
            channelAddress: sample.channelAddress ?? null,
          },
          {
            classify: timedClassify,
            judgeDuplicate: timedJudge,
            reviewThreshold: classifierEnv.CLASSIFICATION_REVIEW_THRESHOLD,
            agentTimeoutMs: measureTimeoutMs,
            onAgentRun: (run) => {
              measure.modelCalls = run.modelCalls.length;
              measure.rejectedAnswers = run.rejectedAnswers;
              measure.cutBy = run.cutBy;
              measure.promptTokens = run.modelCalls.map((call) => call.inputTokens);
              measure.answerTokens = run.modelCalls.map((call) => call.outputTokens);
              measure.stepSeconds = run.modelCalls.map((call) => call.durationMs / 1000);
            },
          },
        );
        // oxlint-disable-next-line no-await-in-loop
        await timed(measure.embeddingSeconds, () => embedder.embed([sample.text], "query"));
      } catch (error) {
        current.error = error instanceof Error ? error.message : String(error);
      }
      current.totalSeconds = secondsSince(started);
      print(`Measured: ${current.case}, ${format(current.totalSeconds)}`);
      measures.push(current);
    }
    reportMeasures(measures);
    reportLimits(measures, limits);
    reportContextWindow(measures);
    // A message that failed has incomplete measures, so the measure as a whole fails.
    expect(
      measures.filter((m) => m.error !== undefined).map((m) => `${m.case}: ${m.error}`),
    ).toEqual([]);
  } finally {
    await agentProcess.stop();
    await server.close();
    await owner.close();
    await dropDatabaseIfExists(databaseUrl);
  }
});
