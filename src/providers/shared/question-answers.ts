import type { QuestionAnswer } from "../interface.js";

/** Labels and recorded IDs are not part of the searchable presentation text. */
export function questionAnswerFields(questionAnswers: QuestionAnswer[]) {
  let offset = 0;
  return questionAnswers.flatMap(({ question, answer }) => [
    { kind: "question" as const, text: question },
    { kind: "answer" as const, text: answer }
  ]).map((field) => {
    const result = { ...field, offset };
    offset += field.text.length + 2;
    return result;
  });
}

export function questionAnswersText(questionAnswers: QuestionAnswer[]): string {
  return questionAnswerFields(questionAnswers).map((field) => field.text).join("\n\n");
}
