CREATE TYPE "public"."staff_role" AS ENUM('ADMIN', 'MEMBER');--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staff_accounts" ADD COLUMN "role" "staff_role" DEFAULT 'MEMBER' NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Accounts made before roles existed could do everything: they keep it, as administrators.
UPDATE "staff_accounts" SET "role" = 'ADMIN';--> statement-breakpoint
-- Who works on a project, and which channel leads to it, are settings that an administrator
-- changes: unlike the history, these links can be removed.
GRANT DELETE ON "project_contacts", "project_channels" TO "request_agent_app";
