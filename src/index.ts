import { Engine } from "./engine.js";
import type { EngineOptions } from "./options.js";
import type { DocumentIndex } from "./types.js";

export type { EngineOptions } from "./options.js";
export type { Doc, DocumentIndex, RebuildResult, RebuildStatus, SearchResult } from "./types.js";

/** Open (or create) a document index stored in the SQLite file at `path`. */
export function openIndex(path: string, options: EngineOptions = {}): DocumentIndex {
  return new Engine(path, options);
}
