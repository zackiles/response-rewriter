/**
 * Strip or replace any and all instances of a string in a Response object (Fetch-based).
 * Rewrite URLs, headers, bodies, with streaming responses, multiple encodings, and complex Unicode scenarios and transport support.
 *
 *
 * @module
 */

// Export the main function and types
export { replaceInResponse } from './main.ts'
export type { JsonTransformer, TextTransformer } from './main.ts'
