/**
 * A powerful Deno library for modifying Response objects by replacing text patterns in headers, bodies, and URLs.
 * Supports streaming responses, multiple encodings, and complex Unicode scenarios.
 * 
 * @module
 */

export { replaceInResponse } from "./main.ts";

// Re-export types that might be useful for consumers
export type { JsonTransformer, TextTransformer } from "./main.ts"; 