import { Engine } from "./engine.js";
/** Open (or create) a document index stored in the SQLite file at `path`. */
export function openIndex(path, options = {}) {
    return new Engine(path, options);
}
