import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { registerChatCommand } from "./commands/chat.js";

export function createProgram(): Command {
  const program = new Command();
  program
    .name("frogcode")
    .description("FrogCode — AI Agent execution framework")
    .version("0.1.0");

  registerChatCommand(program);
  return program;
}

const entryPath = process.argv[1];
const isMain =
  entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;
if (isMain) {
  createProgram().parse();
}
