// The minified browser snippet, inlined at build time (`bun run build:snippet` first).
// @ts-expect-error: a text import of a generated file has no declaration
import js from "../dist/web.min.js" with { type: "text" };

export const SNIPPET: string = js;
