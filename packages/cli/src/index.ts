import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { registerChatCommand } from "./commands/chat.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerTraceCommand } from "./commands/trace.js";

export function createProgram(): Command {
  const program = new Command();
  program
    .name("frogcode")
    .description("FrogCode — AI Agent execution framework")
    .version("0.1.0");

  registerChatCommand(program);
  registerTraceCommand(program);
  registerConfigCommand(program);
  return program;
}

const entryPath = process.argv[1];
const isMain =
  entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;
if (isMain) {
  createProgram().parse();
}
