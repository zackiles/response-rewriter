# response-rewriter

Deno library for modifying Response objects by replacing text patterns in headers, bodies, and URLs. Supports streaming responses, multiple encodings, and complex Unicode scenarios. Handles even the most nightmarish of edge-cases. Perfect for rewriting Responses in proxies.

[![JSR Score](https://jsr.io/badges/@zackiles/response-rewriter/score)](https://jsr.io/@zackiles/response-rewriter)
[![JSR](https://jsr.io/badges/@zackiles/response-rewriter)](https://jsr.io/@zackiles/response-rewriter)
[![JSR Scope](https://jsr.io/badges/scope/@zackiles)](https://jsr.io/@zackiles)

## Features

- 🔄 Replace text in Response objects (headers, body, URLs)
- 🌊 Streaming support with proper chunking
- 🌐 Full Unicode support with proper surrogate pair handling
- 📝 JSON-aware with circular reference detection
- 🎭 Multipart response support
- 📚 Comprehensive test coverage
- 🔒 Safe header handling
- 🚀 High performance with minimal memory usage

## Installation

```bash
deno add jsr:@zackiles/response-rewriter
```

## Usage

```typescript
import { replaceInResponse } from "jsr:@zackiles/response-rewriter";

// Simple string replacement
const response = new Response("Hello world!", {
  headers: { "x-custom": "old-value" }
});
const modified = await replaceInResponse("world", "Deno", response);
console.log(await modified.text()); // "Hello Deno!"
console.log(modified.headers.get("x-custom")); // "old-value"

// Regex with capture groups
const jsonResponse = new Response(JSON.stringify({
  email: "user@old-domain.com",
  nested: { value: "prefix_old_suffix" }
}), {
  headers: { "content-type": "application/json" }
});

const regex = /(\w+)@old-domain\.com/;
const modified = await replaceInResponse(
  regex,
  "$1@new-domain.com",
  jsonResponse
);

const result = await modified.json();
console.log(result.email); // "user@new-domain.com"
```

## API

### replaceInResponse(search, replacement, response)

Replaces all occurrences of a pattern in both headers and body of an HTTP response.

#### Parameters

- `search` (string | RegExp): The text or regex pattern to search for
- `replacement` (string): The replacement text
- `response` (Response): The original HTTP response to modify

#### Returns

- Promise<Response>: A new Response object with the replacements applied

## Advanced Features

### Streaming Support

The library properly handles chunked transfer encoding and streaming responses:

```typescript
const stream = new ReadableStream({
  start(controller) {
    controller.enqueue('Hello ');
    controller.enqueue('world!');
    controller.close();
  }
});

const response = new Response(stream, {
  headers: { "transfer-encoding": "chunked" }
});

const modified = await replaceInResponse("world", "Deno", response);
// Streams the response with replacements
```

### Unicode & Surrogate Pairs

Properly handles complex Unicode scenarios including surrogate pairs:

```typescript
const response = new Response(
  "Hello 🌎!", // Uses surrogate pairs
  { headers: { "content-type": "text/plain; charset=utf-8" }}
);

const modified = await replaceInResponse("🌎", "🦕", response);
console.log(await modified.text()); // "Hello 🦕!"
```

### JSON Processing

Intelligently processes JSON content with circular reference protection:

```typescript
const obj = { name: "old" };
obj.self = obj; // Circular reference

const response = new Response(JSON.stringify(obj), {
  headers: { "content-type": "application/json" }
});

const modified = await replaceInResponse("old", "new", response);
// Safely handles circular references
```

## License

MIT - See [LICENSE](LICENSE) for details.
