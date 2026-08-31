import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse an OpenAI content-part array: text-only payloads become a plain
// string (string-safe guarantee for the strictest OpenAI-compatible providers);
// any other modality keeps the typed array. Matches existing translator behavior.
export function collapseTextParts(parts) {
  if (parts.length >= 1 && parts.every(p => p.type === OPENAI_BLOCK.TEXT)) {
    return parts.map(p => p.text || "").join("\n");
  }
  return parts;
}
