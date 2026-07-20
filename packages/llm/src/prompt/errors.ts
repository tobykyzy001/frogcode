export class PromptTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptTemplateError";
  }
}
