import {
  addMessageToRequest,
  type ClassifiedTurn,
  createRequest,
  createRequestInput,
  type Database,
  describeContact,
  describeProject,
  explainForModel,
  findRequest,
  findRequestInput,
  forwardToTeam,
  forwardToTeamInput,
  getRequestStatus,
  type KnowledgeHit,
  listContactRequests,
  listContactRequestsInput,
  listProjectRequests,
  listProjectRequestsInput,
  requestClarification,
  requestClarificationInput,
  requestReferenceInput,
  searchRequests,
  searchRequestsInput,
  type ToolOutcome,
  updateRequest,
  updateRequestInput,
} from "@request-agent/core";
import { type DynamicToolSet, defineTool } from "eve/tools";
import { z } from "zod";

const noInput = z.object({});

const knowledgeQuestionInput = z.object({ question: z.string().trim().min(1).max(500) });

// Finds the help articles of the sender's projects closest to a question.
export type KnowledgeSearch = (question: string) => Promise<KnowledgeHit[]>;

type Outcome<Tool extends ToolOutcome["tool"]> = Extract<ToolOutcome, { tool: Tool }>;

// What the model reads of a result: the codes of the database in plain words. The output of the
// call keeps the whole outcome, which the server reads to decide what happens next.
const explained = (outcome: ToolOutcome) => ({
  type: "text" as const,
  value: JSON.stringify(explainForModel(outcome.result)),
});

// Builds the tools for one message. The turn comes from the server, out of reach of the model: the
// model can neither choose nor change who the tools act for.
export function createRequestTools(
  db: Database,
  turn: ClassifiedTurn,
  searchKnowledge: KnowledgeSearch,
): DynamicToolSet {
  const identifyContact = defineTool({
    description:
      "Tells who sent the message being handled: name, role, organization and projects. " +
      "Returns status 'unverified' when the sender could not be verified.",
    inputSchema: noInput,
    execute: () => describeContact(db, turn),
  });

  const identifyProject = defineTool({
    description:
      "Tells which project the message is about. Returns 'identified' with the project, " +
      "'ambiguous' with the candidate projects, or 'unknown'. Never pick a candidate at random.",
    inputSchema: noInput,
    execute: () => describeProject(db, turn),
  });

  const createRequestTool = defineTool({
    description:
      "Files the message being handled as a new request, with the type, texts and priority of " +
      "its classification, under the identified project. No argument is needed. A message is " +
      "filed only once: calling it again returns the existing request with created set to false. " +
      "Returns NOT_A_REQUEST for a message that is clearly not a request.",
    inputSchema: createRequestInput,
    execute: async (input): Promise<Outcome<"create_request">> => ({
      tool: "create_request",
      result: await createRequest(db, turn, input),
    }),
    toModelOutput: explained,
  });

  const requestClarificationTool = defineTool({
    description:
      "Records a question to ask the sender when important information is missing or ambiguous, " +
      "such as which project the message is about. The question is sent to the sender, and the " +
      "request waits for the answer and for a human review.",
    inputSchema: requestClarificationInput,
    execute: async (input): Promise<Outcome<"request_clarification">> => ({
      tool: "request_clarification",
      question: input.question,
      result: await requestClarification(db, turn, input),
    }),
    toModelOutput: explained,
    // A question asked to the sender is the answer itself: the agent stops there.
    endsTurn: (outcome) => outcome.result.ok,
  });

  const updateRequestTool = defineTool({
    description:
      "Changes the type, priority, title, summary, description or project of a request that " +
      "the sender made. A person of the team then checks the change. The status can only be " +
      "changed by a person.",
    inputSchema: updateRequestInput,
    execute: async (input): Promise<Outcome<"update_request">> => ({
      tool: "update_request",
      result: await updateRequest(db, turn, input),
    }),
    toModelOutput: explained,
  });

  const findRequestTool = defineTool({
    description:
      "Returns a request with its recent history. Without a reference, returns the request of " +
      "the current conversation, which a reply in the same thread usually follows up on.",
    inputSchema: findRequestInput,
    execute: async (input): Promise<Outcome<"find_request">> => ({
      tool: "find_request",
      result: await findRequest(db, turn, input),
    }),
    toModelOutput: explained,
  });

  const listProjectRequestsTool = defineTool({
    description: "Lists the requests of a project, most recent activity first.",
    inputSchema: listProjectRequestsInput,
    execute: async (input): Promise<Outcome<"list_project_requests">> => ({
      tool: "list_project_requests",
      result: await listProjectRequests(db, turn, input),
    }),
    toModelOutput: explained,
  });

  const getRequestStatusTool = defineTool({
    description: "Returns the status and priority of a request, with its last event.",
    inputSchema: requestReferenceInput,
    execute: async (input): Promise<Outcome<"get_request_status">> => ({
      tool: "get_request_status",
      result: await getRequestStatus(db, turn, input),
    }),
    toModelOutput: explained,
  });

  const addMessageToRequestTool = defineTool({
    description:
      "Files the message being handled under an existing request, such as a follow-up or " +
      "additional information, instead of creating a new request.",
    inputSchema: requestReferenceInput,
    execute: async (input): Promise<Outcome<"add_message_to_request">> => ({
      tool: "add_message_to_request",
      result: await addMessageToRequest(db, turn, input),
    }),
    toModelOutput: explained,
  });

  const searchRequestsTool = defineTool({
    description:
      "Searches requests by words, best matches first. Use it to find a request the message " +
      "refers to, or an existing request about the same problem before creating a new one.",
    inputSchema: searchRequestsInput,
    execute: async (input): Promise<Outcome<"search_requests">> => ({
      tool: "search_requests",
      result: await searchRequests(db, turn, input),
    }),
    toModelOutput: explained,
  });

  const listMyRequestsTool = defineTool({
    description:
      "Lists the requests the sender made or wrote in, most recent activity first. Use it when " +
      "the sender asks about their own requests.",
    inputSchema: listContactRequestsInput,
    execute: async (input): Promise<Outcome<"list_my_requests">> => ({
      tool: "list_my_requests",
      result: await listContactRequests(db, turn, input),
    }),
    toModelOutput: explained,
  });

  const forwardToTeamTool = defineTool({
    description:
      "Passes to the team a question or a wish of the sender that the tools cannot answer or " +
      "do: a date, who handles a request, how to use the product when no help article answers, " +
      "closing or escalating a request. Give the reference of the request the question is " +
      "about, if any. That request then waits for a person, who reads the question.",
    inputSchema: forwardToTeamInput,
    execute: async (input): Promise<Outcome<"forward_to_team">> => ({
      tool: "forward_to_team",
      result: await forwardToTeam(db, turn, input),
    }),
    toModelOutput: explained,
  });

  const searchKnowledgeTool = defineTool({
    description:
      "Searches the help articles of the sender's projects for a question about how to use a " +
      "product or how the support works. Returns the closest articles, best first. Read them: " +
      "answer only from an article that answers the question, and say nothing it does not say.",
    inputSchema: knowledgeQuestionInput,
    execute: async ({ question }): Promise<Outcome<"search_knowledge_base">> => ({
      tool: "search_knowledge_base",
      result: await searchKnowledge(question),
    }),
    // The relevance ranks the articles but does not tell whether one answers (decision 010).
    toModelOutput: (outcome) => {
      const articles = outcome.result;
      return {
        type: "json" as const,
        value:
          articles.length === 0
            ? { articles: [], note: "No help article exists for the projects of the sender." }
            : {
                articles: articles.map(({ project, title, body }) => ({
                  project,
                  title,
                  text: body,
                })),
              },
      };
    },
  });

  // An unverified sender gets no access to existing requests: the agent can only file the message.
  if (turn.actor.kind === "anonymous") {
    return {
      identify_contact: identifyContact,
      identify_project: identifyProject,
      create_request: createRequestTool,
    };
  }
  return {
    identify_contact: identifyContact,
    identify_project: identifyProject,
    create_request: createRequestTool,
    request_clarification: requestClarificationTool,
    update_request: updateRequestTool,
    find_request: findRequestTool,
    list_project_requests: listProjectRequestsTool,
    get_request_status: getRequestStatusTool,
    add_message_to_request: addMessageToRequestTool,
    search_requests: searchRequestsTool,
    list_my_requests: listMyRequestsTool,
    forward_to_team: forwardToTeamTool,
    search_knowledge_base: searchKnowledgeTool,
  };
}
