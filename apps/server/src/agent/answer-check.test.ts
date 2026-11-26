import { describe, expect, it } from "vitest";

import {
  type AnswerContext,
  answerProblems,
  maxAnswerLength,
  toPlainText,
} from "./answer-check.ts";

const context: AnswerContext = {
  knownReferences: new Set([6]),
  forwarded: false,
  inProgress: false,
};

describe("answerProblems", () => {
  it("accepts a plain answer about a request the tools returned", () => {
    expect(
      answerProblems(
        "La demande REQ-0006 est nouvelle : personne de l'équipe ne l'a encore prise en charge.",
        context,
      ),
    ).toEqual([]);
  });

  it("refuses an empty or overlong answer", () => {
    expect(answerProblems("  ", context)).toHaveLength(1);
    expect(answerProblems("a".repeat(maxAnswerLength + 1), context)).toHaveLength(1);
  });

  it("refuses a request that no tool returned, whatever its number of zeros", () => {
    expect(answerProblems("Voir REQ-6 et REQ-0042.", context)).toEqual([
      expect.stringContaining("REQ-0042"),
    ]);
  });

  it("refuses codes, tool names and the words of the instructions", () => {
    for (const answer of [
      "Elle est en statut NEW.",
      "Priorité : HIGH.",
      "J'ai appelé get_request_status.",
      "Voici le JSON.",
      "D'après les faits fournis, elle est nouvelle.",
      "Je ne trouve rien dans les faits concernant l'administration.",
      "The facts do not say.",
      "Elle est nouvelle (statut : new).",
      "<message>",
    ]) {
      expect(answerProblems(answer, context)).toHaveLength(1);
    }
  });

  it("keeps the word bug, which reads the same for the sender", () => {
    expect(answerProblems("C'est un BUG de priorité haute.", context)).toEqual([]);
  });

  it("refuses promises that nobody keeps", () => {
    for (const answer of [
      "Vous serez informé dès qu'elle avance.",
      "Nous allons corriger cela.",
      "Je vais vérifier.",
      "L'équipe vous répondra rapidement.",
      "Elle sera corrigée d'ici demain.",
      "You will be notified.",
      "We will fix it.",
      "I'll check.",
      "The team will answer.",
      "Ils examineront la demande.",
      "Nous procéderons à la clôture.",
      "La priorité sera mise à jour en critique par l'équipe.",
      "Ils lui diront qui s'en occupe.",
      "Elle est notée par l'équipe, qui vous répondra.",
      "Celle-ci procédera à la clôture.",
      "L'équipe technique va examiner ce dysfonctionnement et vous tiendra informé.",
      "L'équipe technique examinera ce dysfonctionnement.",
      "Ils vont corriger le bouton.",
      "Un développeur vous recontactera.",
      "L’équipe technique va examiner ce dysfonctionnement.",
    ]) {
      expect(answerProblems(answer, context)).toHaveLength(1);
    }
  });

  it("refuses to say a question was passed to the team unless it really was", () => {
    for (const answer of [
      "Je n'ai pas cette information : votre question est transmise à l'équipe.",
      "Je passe votre demande à l'équipe.",
    ]) {
      expect(answerProblems(answer, context)).toHaveLength(1);
      expect(answerProblems(answer, { ...context, forwarded: true })).toEqual([]);
    }
  });

  it("refuses to say tu to the sender", () => {
    expect(answerProblems("Voici ta demande REQ-0006.", context)).toHaveLength(1);
    expect(answerProblems("Je t'indique le statut.", context)).toHaveLength(1);
  });

  it("refuses to say a request is being handled unless a request is in progress", () => {
    const answer = "La demande REQ-0006 est en cours de traitement.";

    expect(answerProblems(answer, context)).toHaveLength(1);
    expect(answerProblems(answer, { ...context, inProgress: true })).toEqual([]);
    expect(answerProblems("Vous n'avez aucune demande ouverte.", context)).toEqual([]);
  });

  it("refuses a title such as Madame or Monsieur, which assumes how the sender is addressed", () => {
    for (const answer of ["Madame De Souza, voici la demande.", "M. Leroy, voici la demande."]) {
      expect(answerProblems(answer, context)).toHaveLength(1);
    }
    expect(answerProblems("La demande REQ-0006 concerne Mmes et messieurs.", context)).toEqual([]);
  });

  it("accepts plain facts about what exists and what does not", () => {
    for (const answer of [
      "La demande REQ-0006 est nouvelle : personne de l'équipe n'a encore commencé dessus.",
      "Le système n'enregistre ni date prévue ni personne en charge pour cette demande.",
      "Elle a été classée en priorité haute automatiquement, à sa création.",
      "Votre requête REQ-0006 a été notée.",
    ]) {
      expect(answerProblems(answer, context)).toEqual([]);
    }
  });
});

describe("toPlainText", () => {
  it("removes Markdown marks, keeping the text and the lists", () => {
    expect(toPlainText("## Statut\n- **REQ-0006** : `nouvelle`\n__fin__")).toBe(
      "Statut\n- REQ-0006 : nouvelle\nfin",
    );
  });

  it("removes the marks of other people's text that the model copied", () => {
    expect(toPlainText("La demande <sender_text>Panier vide</sender_text> est en cours.")).toBe(
      "La demande Panier vide est en cours.",
    );
  });
});
