import type { ToolHandler, ToolDefinition } from "../../../types.js";
import { TOOL_SCHEMAS } from "./schema.js";
import {
  listFilesHandler,
  readFileHandler,
  listSymbolsHandler,
  searchFilesHandler,
  applyPatchHandler,
  writeFileHandler,
  createFileHandler,
  deleteFileHandler,
  executeCommandHandler,
  runTestsHandler,
  gitStatusHandler,
  gitDiffHandler,
  gitCheckpointHandler,
  gitRollbackHandler,
} from "./files.js";

const HANDLERS: Record<string, ToolHandler> = {
  list_files: listFilesHandler,
  read_file: readFileHandler,
  list_symbols: listSymbolsHandler,
  search_files: searchFilesHandler,
  apply_patch: applyPatchHandler,
  write_file: writeFileHandler,
  create_file: createFileHandler,
  delete_file: deleteFileHandler,
  execute_command: executeCommandHandler,
  run_tests: runTestsHandler,
  git_status: gitStatusHandler,
  git_diff: gitDiffHandler,
  git_checkpoint: gitCheckpointHandler,
  git_rollback: gitRollbackHandler,
};

export class ToolRegistry {
  private handlers: Record<string, ToolHandler>;
  private schemas: typeof TOOL_SCHEMAS;

  constructor() {
    this.handlers = { ...HANDLERS };
    this.schemas = [...TOOL_SCHEMAS];
  }

  getHandler(name: string): ToolHandler | undefined {
    return this.handlers[name];
  }

  getSchema(name: string): ToolDefinition | undefined {
    return this.schemas.find((s) => s.function.name === name)?.function;
  }

  get allSchemas() {
    return [...this.schemas];
  }

  get toolNames(): string[] {
    return Object.keys(this.handlers);
  }

  has(name: string): boolean {
    return name in this.handlers;
  }
}

export const defaultRegistry = new ToolRegistry();
