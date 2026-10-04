import type { OutlineEntry } from "./types";

function sanitize(title: string): string {
  return title.replace(/[\r\n]+/g, " ");
}

function renderEntry(entry: OutlineEntry, depth: number, lines: string[]): void {
  const indent = "  ".repeat(depth);
  lines.push(`${indent}- ${sanitize(entry.title)} (ID: ${entry.id})`);
  for (const child of entry.children) {
    renderEntry(child, depth + 1, lines);
  }
  for (const reference of entry.references) {
    lines.push(
      `${indent}  - → ${sanitize(reference.targetTitle)} (ID: ${reference.targetId})`
    );
  }
}

/** Renders top-level entries to a deterministic Markdown outline. */
export function renderMarkdown(entries: OutlineEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    renderEntry(entry, 0, lines);
  }
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}
