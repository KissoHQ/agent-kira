import {
  channel,
  type ChannelLinkRow,
  type ContactRow,
  filesPageSize,
  minPasswordLength,
  type OrganizationRow,
  type ProjectRow,
  type StaffRow,
  type StoredFiles,
} from "@request-agent/core";
import { html } from "hono/html";

import { channelLabels } from "./labels.ts";
import { type Fragment, options, page, type ViewContext } from "./layout.ts";

// Pages of the administration, open to administrators only: the clients, their projects, the
// people who write to the agent, the channels that lead to a project, the accounts of the team, and
// the files attached through the widget.

export type AdminSection =
  "organizations" | "projects" | "contacts" | "channels" | "staff" | "files";

const sections: [AdminSection, string][] = [
  ["organizations", "Clients"],
  ["projects", "Projets"],
  ["contacts", "Contacts"],
  ["channels", "Canaux"],
  ["staff", "Équipe"],
  ["files", "Fichiers"],
];

export interface Feedback {
  notice?: string;
  error?: string;
}

const roleLabels = { ADMIN: "Administrateur", MEMBER: "Membre" } as const;

function feedbackOf(feedback: Feedback): Fragment {
  return html`${
    feedback.notice === undefined
      ? ""
      : html`<p class="notice" role="status">${feedback.notice}</p>`
  }
  ${feedback.error === undefined ? "" : html`<p class="error" role="alert">${feedback.error}</p>`}`;
}

function adminPage(
  view: ViewContext,
  section: AdminSection,
  title: string,
  feedback: Feedback,
  body: Fragment,
): Fragment {
  return page(
    title,
    html`<h1>Administration</h1>
      <nav class="subnav" aria-label="Administration">
        ${sections.map(
          ([key, label]) =>
            html`<a href="/admin/${key}" ${key === section ? html`aria-current="page"` : ""}
              >${label}</a
            >`,
        )}
      </nav>
      ${feedbackOf(feedback)} ${body}`,
    view.staff,
    "admin",
  );
}

// A button that sends one action, such as archiving, as a form of its own.
function actionButton(
  action: string,
  label: string,
  fields: Record<string, string> = {},
): Fragment {
  return html`<form class="inline" method="post" action="${action}">
    ${Object.entries(fields).map(
      ([name, value]) => html`<input type="hidden" name="${name}" value="${value}" />`,
    )}
    <button type="submit">${label}</button>
  </form>`;
}

const state = (archived: boolean, onLabel: string) =>
  archived
    ? html`<span class="badge badge-gray">${onLabel}</span>`
    : html`<span class="badge badge-green">Actif</span>`;

function organizationForm(action: string, row?: OrganizationRow): Fragment {
  return html`<form method="post" action="${action}">
    <label>Nom <input name="name" value="${row?.name ?? ""}" maxlength="120" required /></label>
    <label>
      Domaine e-mail (facultatif)
      <input name="emailDomain" value="${row?.emailDomain ?? ""}" placeholder="acme.example" />
    </label>
    <button class="primary" type="submit">
      ${row === undefined ? "Ajouter le client" : "Enregistrer"}
    </button>
  </form>`;
}

export function organizationsPage(
  view: ViewContext,
  rows: OrganizationRow[],
  feedback: Feedback = {},
): Fragment {
  return adminPage(
    view,
    "organizations",
    "Clients",
    feedback,
    html`<div class="table">
        <table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Domaine</th>
              <th>Projets</th>
              <th>Contacts</th>
              <th>État</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) =>
                html`<tr>
                  <td><a href="/admin/organizations/${row.id}">${row.name}</a></td>
                  <td>${row.emailDomain ?? "—"}</td>
                  <td>${row.projects}</td>
                  <td>${row.contacts}</td>
                  <td>${state(row.archived, "Archivé")}</td>
                  <td>
                    ${
                      row.archived
                        ? actionButton(`/admin/organizations/${row.id}/archive`, "Réactiver", {
                            archived: "false",
                          })
                        : actionButton(`/admin/organizations/${row.id}/archive`, "Archiver", {
                            archived: "true",
                          })
                    }
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      <p class="muted">
        Archiver un client archive aussi ses projets et désactive ses contacts. Réactiver le client
        ne réactive que lui : ses projets et contacts se réactivent un par un.
      </p>
      <section class="card">
        <h2>Nouveau client</h2>
        ${organizationForm("/admin/organizations")}
      </section>`,
  );
}

export function organizationPage(
  view: ViewContext,
  row: OrganizationRow,
  feedback: Feedback = {},
): Fragment {
  return adminPage(
    view,
    "organizations",
    row.name,
    feedback,
    html`<p><a href="/admin/organizations">← Tous les clients</a></p>
      <section class="card">
        <h2>${row.name}</h2>
        ${organizationForm(`/admin/organizations/${row.id}`, row)}
      </section>`,
  );
}

function projectForm(action: string, organizations: OrganizationRow[], row?: ProjectRow): Fragment {
  const labels = Object.fromEntries(organizations.map((org) => [org.id, org.name]));
  return html`<form method="post" action="${action}">
    <label>
      Code
      <input
        name="key"
        value="${row?.key ?? ""}"
        placeholder="SHOP"
        pattern="[A-Za-z][A-Za-z0-9]{1,9}"
        required
        ${row === undefined ? "" : html`readonly aria-describedby="key-help"`}
      />
    </label>
    ${
      row === undefined
        ? ""
        : html`<p class="muted" id="key-help">
            Le code ne change pas : le widget, les canaux et les commandes le désignent.
          </p>`
    }
    <label>Nom <input name="name" value="${row?.name ?? ""}" maxlength="120" required /></label>
    <label>
      Description (facultative)
      <input name="description" value="${row?.description ?? ""}" maxlength="1000" />
    </label>
    <label>
      Client
      <select name="organizationId">
        <option value="">Aucun</option>
        ${options(
          organizations.map((org) => org.id),
          labels,
          row?.organizationId,
        )}
      </select>
    </label>
    <button class="primary" type="submit">
      ${row === undefined ? "Ajouter le projet" : "Enregistrer"}
    </button>
  </form>`;
}

export function projectsPage(
  view: ViewContext,
  rows: ProjectRow[],
  organizations: OrganizationRow[],
  feedback: Feedback = {},
): Fragment {
  return adminPage(
    view,
    "projects",
    "Projets",
    feedback,
    html`<div class="table">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Nom</th>
              <th>Client</th>
              <th>État</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) =>
                html`<tr>
                  <td><a href="/admin/projects/${row.id}">${row.key}</a></td>
                  <td>${row.name}</td>
                  <td>${row.organization ?? "—"}</td>
                  <td>${state(row.archived, "Archivé")}</td>
                  <td>
                    ${actionButton(
                      `/admin/projects/${row.id}/archive`,
                      row.archived ? "Réactiver" : "Archiver",
                      { archived: row.archived ? "false" : "true" },
                    )}
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      <p class="muted">
        Un projet archivé ne reçoit plus de nouvelle demande, et l'agent ne le propose plus. Ses
        demandes restent visibles par l'équipe.
      </p>
      <section class="card">
        <h2>Nouveau projet</h2>
        ${projectForm("/admin/projects", organizations)}
      </section>`,
  );
}

export function projectPage(
  view: ViewContext,
  row: ProjectRow,
  organizations: OrganizationRow[],
  feedback: Feedback = {},
): Fragment {
  return adminPage(
    view,
    "projects",
    row.key,
    feedback,
    html`<p><a href="/admin/projects">← Tous les projets</a></p>
      <section class="card">
        <h2>${row.key} · ${row.name}</h2>
        ${projectForm(`/admin/projects/${row.id}`, organizations, row)}
      </section>`,
  );
}

function contactForm(
  action: string,
  organizations: OrganizationRow[],
  projects: ProjectRow[],
  row?: ContactRow,
): Fragment {
  const labels = Object.fromEntries(organizations.map((org) => [org.id, org.name]));
  const chosen = new Set(row?.projectIds ?? []);
  return html`<form method="post" action="${action}">
    <label>E-mail <input type="email" name="email" value="${row?.email ?? ""}" /></label>
    <label>Nom <input name="name" value="${row?.name ?? ""}" maxlength="120" /></label>
    <label>
      Identifiant Slack (facultatif, par exemple U012AB3CD)
      <input
        name="slackUserId"
        value="${row?.slackUserId ?? ""}"
        pattern="[UuWw][A-Za-z0-9]{2,20}"
      />
    </label>
    <label>
      Client
      <select name="organizationId">
        <option value="">Aucun</option>
        ${options(
          organizations.map((org) => org.id),
          labels,
          row?.organizationId,
        )}
      </select>
    </label>
    <fieldset class="checks">
      <legend>Projets</legend>
      ${projects.map(
        (project) =>
          html`<label>
            <input
              type="checkbox"
              name="projectIds"
              value="${project.id}"
              ${chosen.has(project.id) ? "checked" : ""}
            />
            ${project.key}${project.archived ? " (archivé)" : ""}
          </label>`,
      )}
    </fieldset>
    <button class="primary" type="submit">
      ${row === undefined ? "Ajouter le contact" : "Enregistrer"}
    </button>
  </form>`;
}

export function contactsPage(
  view: ViewContext,
  rows: ContactRow[],
  organizations: OrganizationRow[],
  projects: ProjectRow[],
  feedback: Feedback = {},
): Fragment {
  return adminPage(
    view,
    "contacts",
    "Contacts",
    feedback,
    html`<div class="table">
        <table>
          <thead>
            <tr>
              <th>Contact</th>
              <th>Nom</th>
              <th>Slack</th>
              <th>Client</th>
              <th>Projets</th>
              <th>État</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) =>
                html`<tr>
                  <td><a href="/admin/contacts/${row.id}">${row.email ?? row.slackUserId}</a></td>
                  <td>${row.name ?? "—"}</td>
                  <td>${row.slackUserId ?? "—"}</td>
                  <td>${row.organization ?? "—"}</td>
                  <td>${row.projectKeys.join(", ") || "—"}</td>
                  <td>${state(row.disabled, "Désactivé")}</td>
                  <td>
                    ${actionButton(
                      `/admin/contacts/${row.id}/disable`,
                      row.disabled ? "Réactiver" : "Désactiver",
                      { disabled: row.disabled ? "false" : "true" },
                    )}
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      <p class="muted">
        Un contact désactivé, par exemple une personne qui a quitté le client, est traité comme un
        expéditeur inconnu : ses messages attendent une revue et il n'accède à aucune demande.
      </p>
      <section class="card">
        <h2>Nouveau contact</h2>
        ${contactForm("/admin/contacts", organizations, projects)}
      </section>`,
  );
}

export function contactPage(
  view: ViewContext,
  row: ContactRow,
  organizations: OrganizationRow[],
  projects: ProjectRow[],
  feedback: Feedback = {},
): Fragment {
  return adminPage(
    view,
    "contacts",
    row.email ?? row.slackUserId ?? "Contact",
    feedback,
    html`<p><a href="/admin/contacts">← Tous les contacts</a></p>
      <section class="card">
        <h2>${row.name ?? row.email ?? row.slackUserId}</h2>
        ${contactForm(`/admin/contacts/${row.id}`, organizations, projects, row)}
      </section>`,
  );
}

export function channelsPage(
  view: ViewContext,
  rows: ChannelLinkRow[],
  projects: ProjectRow[],
  feedback: Feedback = {},
): Fragment {
  const projectLabels = Object.fromEntries(projects.map((project) => [project.id, project.key]));
  return adminPage(
    view,
    "channels",
    "Canaux",
    feedback,
    html`<p class="muted">
        Un canal dédié à un projet l'identifie sans le modèle : un canal Slack (son identifiant, par
        exemple C012AB3CD), une adresse e-mail transférée à l'agent, ou le widget d'une application
        (le code du projet).
      </p>
      <div class="table">
        <table>
          <thead>
            <tr>
              <th>Projet</th>
              <th>Canal</th>
              <th>Identifiant</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) =>
                html`<tr>
                  <td>${row.projectKey}</td>
                  <td>${channelLabels[row.channel]}</td>
                  <td>${row.externalId}</td>
                  <td>${actionButton(`/admin/channels/${row.id}/remove`, "Retirer")}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      <section class="card">
        <h2>Nouveau canal</h2>
        <form method="post" action="/admin/channels">
          <label>
            Projet
            <select name="projectId" required>
              ${options(
                projects.map((project) => project.id),
                projectLabels,
                undefined,
              )}
            </select>
          </label>
          <label>
            Canal
            <select name="channel">
              ${options(channel.enumValues, channelLabels, undefined)}
            </select>
          </label>
          <label>Identifiant <input name="externalId" maxlength="254" required /></label>
          <button class="primary" type="submit">Ajouter le canal</button>
        </form>
      </section>`,
  );
}

const passwordField = (name: string, label: string) =>
  html`<label>
    ${label} (au moins ${minPasswordLength} caractères)
    <input
      type="password"
      name="${name}"
      minlength="${minPasswordLength}"
      maxlength="128"
      autocomplete="new-password"
      required
    />
  </label>`;

// The own password of the administrator, asked again before any change to an account of the team,
// so a session left open is not enough to take over the accounts.
const confirmField = html`<label>
  Votre mot de passe
  <input type="password" name="confirm" autocomplete="current-password" maxlength="128" required />
</label>`;

export function staffPage(view: ViewContext, rows: StaffRow[], feedback: Feedback = {}): Fragment {
  return adminPage(
    view,
    "staff",
    "Équipe",
    feedback,
    html`<div class="table">
        <table>
          <thead>
            <tr>
              <th>Compte</th>
              <th>Nom</th>
              <th>Rôle</th>
              <th>État</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (row) =>
                html`<tr>
                  <td><a href="/admin/staff/${row.contactId}">${row.email}</a></td>
                  <td>${row.name ?? "—"}</td>
                  <td>${roleLabels[row.role]}</td>
                  <td>${state(row.disabled, "Désactivé")}</td>
                  <td><a href="/admin/staff/${row.contactId}">Gérer</a></td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      <p class="muted">
        Un compte désactivé ne peut plus se connecter et ses sessions se ferment aussitôt. Il reste
        toujours au moins un administrateur actif.
      </p>
      <section class="card">
        <h2>Nouveau compte</h2>
        <form method="post" action="/admin/staff">
          <label>E-mail <input type="email" name="email" required /></label>
          <label>Nom <input name="name" maxlength="120" required /></label>
          <label>
            Rôle
            <select name="role">
              ${options(["MEMBER", "ADMIN"] as const, roleLabels, "MEMBER")}
            </select>
          </label>
          ${passwordField("password", "Mot de passe initial")} ${confirmField}
          <button class="primary" type="submit">Créer le compte</button>
        </form>
      </section>`,
  );
}

export function staffMemberPage(
  view: ViewContext,
  row: StaffRow,
  feedback: Feedback = {},
): Fragment {
  return adminPage(
    view,
    "staff",
    row.email ?? "Compte",
    feedback,
    html`<p><a href="/admin/staff">← Toute l'équipe</a></p>
      <p class="muted">Chaque action demande votre propre mot de passe.</p>
      <section class="card">
        <h2>Identité</h2>
        <form method="post" action="/admin/staff/${row.contactId}">
          <label>
            E-mail de connexion
            <input type="email" name="email" value="${row.email ?? ""}" maxlength="254" required />
          </label>
          <label
            >Nom <input name="name" value="${row.name ?? ""}" maxlength="120" required
          /></label>
          ${confirmField}
          <button class="primary" type="submit">Enregistrer</button>
        </form>
        <p class="muted">Un nouvel e-mail ferme toutes les sessions de la personne.</p>
      </section>
      <section class="card">
        <h2>Rôle</h2>
        <form method="post" action="/admin/staff/${row.contactId}/role">
          <label>
            Rôle
            <select name="role">
              ${options(["MEMBER", "ADMIN"] as const, roleLabels, row.role)}
            </select>
          </label>
          ${confirmField}
          <button class="primary" type="submit">Changer le rôle</button>
        </form>
      </section>
      <section class="card">
        <h2>${row.disabled ? "Réactiver le compte" : "Désactiver le compte"}</h2>
        <form method="post" action="/admin/staff/${row.contactId}/disable">
          <input type="hidden" name="disabled" value="${row.disabled ? "false" : "true"}" />
          ${confirmField}
          <button type="submit">${row.disabled ? "Réactiver" : "Désactiver"}</button>
        </form>
        <p class="muted">
          Un compte désactivé ne peut plus se connecter et ses sessions se ferment aussitôt.
        </p>
      </section>
      <section class="card">
        <h2>Nouveau mot de passe</h2>
        <form method="post" action="/admin/staff/${row.contactId}/password">
          ${passwordField("password", "Nouveau mot de passe")} ${confirmField}
          <button class="primary" type="submit">Donner ce mot de passe</button>
        </form>
        <p class="muted">Toutes les sessions de la personne se ferment.</p>
      </section>`,
  );
}

export function accountPage(view: ViewContext, feedback: Feedback = {}): Fragment {
  return page(
    "Mon compte",
    html`<h1>Mon compte</h1>
      ${feedbackOf(feedback)}
      <section class="card">
        <h2>Changer mon mot de passe</h2>
        <form method="post" action="/account/password">
          <label>
            Mot de passe actuel
            <input type="password" name="current" autocomplete="current-password" required />
          </label>
          ${passwordField("password", "Nouveau mot de passe")}
          <button class="primary" type="submit">Changer le mot de passe</button>
        </form>
        <p class="muted">Vos autres sessions se ferment ; celle-ci reste ouverte.</p>
      </section>`,
    view.staff,
    "account",
  );
}

// A size in megabytes, as people read it.
const megabytes = (bytes: number) =>
  `${(bytes / (1024 * 1024)).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`;

export function filesPage(
  view: ViewContext,
  retentionDays: number,
  files: StoredFiles,
  feedback: Feedback = {},
): Fragment {
  const pages = Math.max(1, Math.ceil(files.total / filesPageSize));
  return adminPage(
    view,
    "files",
    "Fichiers",
    feedback,
    html`<p>
        ${files.total} fichiers joints gardés sur le serveur, ${megabytes(files.totalBytes)} en
        tout.
      </p>
      <p class="muted">
        Les fichiers joints par le widget sont supprimés automatiquement ${retentionDays} jours
        après leur réception. Supprimer un fichier ici libère sa place tout de suite. Son nom, son
        type et sa taille restent avec son message.
      </p>
      ${
        files.rows.length === 0
          ? html`<p class="muted">Aucun fichier gardé.</p>`
          : html`<div class="table">
              <table>
                <thead>
                  <tr>
                    <th>Fichier</th>
                    <th>Demande</th>
                    <th>Taille</th>
                    <th>Reçu le</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${files.rows.map(
                    (row) =>
                      html`<tr>
                        <td><a href="/attachments/${row.id}">${row.filename}</a></td>
                        <td>
                          ${
                            row.reference === null
                              ? "—"
                              : html`<a href="/requests/${row.reference}">${row.reference}</a>`
                          }
                        </td>
                        <td>${megabytes(row.sizeBytes)}</td>
                        <td>${view.formatDate(row.createdAt.toISOString())}</td>
                        <td>${actionButton(`/admin/files/${row.id}/delete`, "Supprimer")}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
      }
      ${
        pages > 1
          ? html`<nav class="pages" aria-label="Pages">
              ${files.page > 1 ? html`<a href="/admin/files?page=${files.page - 1}">Précédente</a>` : ""}
              <span class="muted">Page ${files.page} sur ${pages}</span>
              ${files.page < pages ? html`<a href="/admin/files?page=${files.page + 1}">Suivante</a>` : ""}
            </nav>`
          : ""
      }`,
  );
}

export function forbiddenPage(view: ViewContext): Fragment {
  return page(
    "Accès refusé",
    html`<h1>Accès refusé</h1>
      <p>Cette page est réservée aux administrateurs.</p>`,
    view.staff,
  );
}
