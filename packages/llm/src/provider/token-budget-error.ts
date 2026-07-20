export class TokenBudgetExceededError extends Error {
  constructor(
    public readonly used: number,
    public readonly max: number,
    public readonly exceeded: number,
  ) {
    super(
      `Token budget exceeded: used ${used} of ${max} (over by ${exceeded})`,
    );
    this.name = "TokenBudgetExceededError";
  }
}
