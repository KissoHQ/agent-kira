-- The agent server reads messages written outside the company, by people and by the model: it gets
-- only the rights its work needs, table by table, and none on the accounts of the team. It cannot
-- rewrite what a message said, nor create a session of the web interface.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'request_agent_server') THEN
    CREATE ROLE "request_agent_server" NOLOGIN;
  END IF;
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA "public" TO "request_agent_server";--> statement-breakpoint
-- What it reads to know who writes and about which project, and the help articles.
GRANT SELECT ON "organizations", "contacts", "projects", "project_contacts", "project_channels", "knowledge_articles" TO "request_agent_server";--> statement-breakpoint
-- What it stores and follows: conversations, messages, files, requests, their history, and the
-- place reached in the mailbox.
GRANT SELECT, INSERT ON "conversations", "messages", "attachments", "requests", "events", "mailbox_cursors" TO "request_agent_server";--> statement-breakpoint
GRANT UPDATE ("external_id") ON "conversations" TO "request_agent_server";--> statement-breakpoint
GRANT UPDATE ("request_id", "author_contact_id", "handled_at", "handling_attempts", "pending_reply") ON "messages" TO "request_agent_server";--> statement-breakpoint
GRANT UPDATE ON "requests", "mailbox_cursors" TO "request_agent_server";--> statement-breakpoint
GRANT USAGE ON ALL SEQUENCES IN SCHEMA "public" TO "request_agent_server";
