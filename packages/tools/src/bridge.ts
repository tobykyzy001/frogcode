/**
 * Bridge types between `@frogcode/tools` and the PRAO execution loop.
 *
 * `ToolActHandler.act()` returns a `ToolActResult` describing what happened
 * during the Act phase. The execution loop converts each entry into a
 * `tool_call` / `tool_result` StepRecord whose `input` / `output` shapes are
 * documented by `ToolCallStepInput` and `ToolResultStepOutput`.
 */

export interface ToolResultError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

export interface ToolResultEntry {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly success: boolean;
  readonly output?: unknown;
  readonly error?: ToolResultError;
}

export interface ToolActResult {
  readonly toolCallsMade: boolean;
  readonly toolResults: ReadonlyArray<ToolResultEntry>;
}

/**
 * Shape of a `tool_call` StepRecord's `input` field — what the LLM asked to call.
 */
export interface ToolCallStepInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: unknown;
}

/**
 * Shape of a `tool_result` StepRecord's `output` field — what the tool returned
 * (or the error it threw).
 */
export interface ToolResultStepOutput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly success: boolean;
  readonly output?: unknown;
  readonly error?: ToolResultError;
}
