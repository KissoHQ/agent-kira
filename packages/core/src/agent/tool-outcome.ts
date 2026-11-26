import type { KnowledgeHit } from "../knowledge/articles.ts";
import type {
  addMessageToRequest,
  createRequest,
  forwardToTeam,
  requestClarification,
  updateRequest,
} from "../requests/commands.ts";
import type {
  findRequest,
  getRequestStatus,
  listContactRequests,
  listProjectRequests,
  searchRequests,
} from "../requests/queries.ts";

type ResultOf<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

// What a tool of the agent did, recorded by the tool itself. The answer to the sender and what the
// server does after the agent are decided from these records, not from the text of the model.
export type ToolOutcome =
  | { tool: "create_request"; result: ResultOf<typeof createRequest> }
  | {
      tool: "request_clarification";
      question: string;
      result: ResultOf<typeof requestClarification>;
    }
  | { tool: "update_request"; result: ResultOf<typeof updateRequest> }
  | { tool: "find_request"; result: ResultOf<typeof findRequest> }
  | { tool: "list_project_requests"; result: ResultOf<typeof listProjectRequests> }
  | { tool: "get_request_status"; result: ResultOf<typeof getRequestStatus> }
  | { tool: "add_message_to_request"; result: ResultOf<typeof addMessageToRequest> }
  | { tool: "search_requests"; result: ResultOf<typeof searchRequests> }
  | { tool: "list_my_requests"; result: ResultOf<typeof listContactRequests> }
  | { tool: "forward_to_team"; result: ResultOf<typeof forwardToTeam> }
  | { tool: "search_knowledge_base"; result: KnowledgeHit[] };

const recordedToolNames: readonly ToolOutcome["tool"][] = [
  "create_request",
  "request_clarification",
  "update_request",
  "find_request",
  "list_project_requests",
  "get_request_status",
  "add_message_to_request",
  "search_requests",
  "list_my_requests",
  "forward_to_team",
  "search_knowledge_base",
];

const recorded = new Set<string>(recordedToolNames);

// Whether a value is the outcome that a tool of the agent returned. Its result is typed by the
// function of this package that the tool called: only the name of the tool is checked.
export function isToolOutcome(value: unknown): value is ToolOutcome {
  return (
    typeof value === "object" &&
    value !== null &&
    "tool" in value &&
    typeof value.tool === "string" &&
    recorded.has(value.tool) &&
    "result" in value
  );
}
