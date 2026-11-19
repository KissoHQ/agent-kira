import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { contacts, projectContacts, projects } from "../db/schema.ts";

// Whether the contact with this email works on the project with this key, both still active. An
// application that embeds the widget for one project can then only vouch for the people of that
// project.
export async function worksOnProjectByEmail(
  db: Database,
  email: string,
  projectKey: string,
): Promise<boolean> {
  const [link] = await db
    .select({ projectId: projectContacts.projectId })
    .from(projectContacts)
    .innerJoin(contacts, eq(contacts.id, projectContacts.contactId))
    .innerJoin(projects, eq(projects.id, projectContacts.projectId))
    .where(
      and(
        eq(contacts.email, email.trim().toLowerCase()),
        eq(projects.key, projectKey.trim().toUpperCase()),
        isNull(contacts.disabledAt),
        isNull(projects.archivedAt),
      ),
    )
    .limit(1);
  return link !== undefined;
}
