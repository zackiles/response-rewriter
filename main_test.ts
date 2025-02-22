import { assertEquals, assertStringIncludes } from "@std/assert";
import { replaceInResponse } from "./main.ts";

/**
 * Test utilities for replaceInResponse tests
 */

/**
 * Creates a test Response object with optional JSON body and headers
 * @param body - The response body (will be JSON stringified)
 * @param headers - Additional headers to include
 */
const createTestResponse = (body: unknown, headers: HeadersInit = {}) => {
  const responseHeaders = new Headers(headers);
  if (body) {
    responseHeaders.set("content-type", "application/json; charset=utf-8");
  }
  
  return new Response(
    body ? JSON.stringify(body) : null,
    {
      status: body ? 200 : 204,
      headers: responseHeaders
    }
  );
};

/**
 * Asserts that response headers match expected values
 * @param response - The Response object to check
 * @param expectedHeaders - Map of header names to expected values (null means header should not exist)
 */
const assertHeaders = (response: Response, expectedHeaders: Record<string, string | null>) => {
  for (const [key, value] of Object.entries(expectedHeaders)) {
    if (value === null) {
      assertEquals(response.headers.has(key), false);
    } else {
      assertEquals(response.headers.get(key), value);
    }
  }
};

/**
 * E2E test suite for replaceInResponse function
 * Tests complex scenarios including:
 * - JSON content with Unicode and escape sequences
 * - Header modifications
 * - Chunked transfer encoding
 * - Empty body responses
 */
Deno.test("replaceInResponse - E2E test with chunked JSON response", async () => {
  const search = "original";
  const replacement = "replaced";
  
  const testJson = {
    message: `Hello "original" world! \u{1F600}`,
    nested: { key: "original value" },
    array: ["original", "not-original", "original"],
    withEscapes: "original\\original\"original",
  };

  const originalResponse = createTestResponse(testJson, {
    "transfer-encoding": "chunked",
    "x-test-header": "test-original-value",
    "set-cookie": "sessionId=original123; Path=/",
  });

  // Execute replacement
  const modifiedResponse = await replaceInResponse(search, replacement, originalResponse);

  // Verify response status and headers
  assertEquals(modifiedResponse.status, 200);
  assertHeaders(modifiedResponse, {
    "content-type": "application/json; charset=utf-8",
    "transfer-encoding": "chunked",
    "x-test-header": "test-replaced-value",
    "set-cookie": "sessionId=replaced123; Path=/",
    "content-length": null
  });

  // Read and parse response body
  const responseText = await modifiedResponse.text();
  console.log('Response text:', responseText);
  const parsedBody = JSON.parse(responseText);

  // Verify body content
  const expectedJson = {
    message: `Hello "replaced" world! \u{1F600}`,
    nested: { key: "replaced value" },
    array: ["replaced", "not-replaced", "replaced"],
    withEscapes: "replaced\\replaced\"replaced",
  };

  assertEquals(parsedBody, expectedJson);
});

// Update empty body test
Deno.test("replaceInResponse - handles response with no body", async () => {
  const originalResponse = createTestResponse(null, {
    "x-correlation-id": "original-123",
  });

  const modifiedResponse = await replaceInResponse("original", "replaced", originalResponse);

  assertEquals(modifiedResponse.status, 204);
  assertHeaders(modifiedResponse, {
    "x-correlation-id": "replaced-123"
  });
  
  const bodyText = await modifiedResponse.text();
  assertEquals(bodyText, "");
});

// Add smoke test for basic functionality
Deno.test("replaceInResponse - smoke test with simple text", async () => {
  const originalResponse = new Response("Hello original world", {
    headers: { "content-type": "text/plain" }
  });

  const modifiedResponse = await replaceInResponse("original", "replaced", originalResponse);
  const text = await modifiedResponse.text();
  
  assertEquals(text, "Hello replaced world");
});

// Test Unicode surrogate pair handling
Deno.test("replaceInResponse - handles Unicode surrogate pairs in JSON", async () => {
  const testJson = {
    // "𝄞" is represented by surrogate pair \uD834\uDD1E (musical G-clef symbol)
    message: "original_𝄞",
    // "𝌆" is represented by surrogate pair \uD834\uDF06 (another musical symbol)
    nested: { key: "original_𝌆" }
  };

  const originalResponse = createTestResponse(testJson, {
    "transfer-encoding": "chunked"
  });

  const modifiedResponse = await replaceInResponse("original", "replaced", originalResponse);

  // Verify response
  const responseText = await modifiedResponse.text();
  console.log('Unicode test response:', responseText);
  const parsedBody = JSON.parse(responseText);

  // Verify the surrogate pairs remain intact after replacement
  assertEquals(parsedBody, {
    message: "replaced_𝄞",
    nested: { key: "replaced_𝌆" }
  });
});

// Test regex pattern handling with capture groups
Deno.test("replaceInResponse - handles complex regex patterns", async () => {
  const testJson = {
    // Test capture groups
    email: "user@original.com",
    // Test special characters in the pattern
    special: "test.original.com",
    // Test multiple matches
    multi: "original and original again",
    // Test with prefix/suffix
    nested: {
      value: "prefix_original_suffix"
    }
  };

  const originalResponse = createTestResponse(testJson);

  // Test 1: Regex with capture group
  const regex = /(\w+)@original\.com/;
  const modifiedResponse = await replaceInResponse(
    regex,
    "$1@replaced.com",
    originalResponse
  );

  const parsedBody = JSON.parse(await modifiedResponse.text());

  // Verify regex with capture group worked
  assertEquals(parsedBody.email, "user@replaced.com");
  // Verify other strings weren't affected by the specific regex
  assertEquals(parsedBody.special, "test.original.com");
  assertEquals(parsedBody.multi, "original and original again");
  assertEquals(parsedBody.nested.value, "prefix_original_suffix");

  // Test 2: Global regex with dots
  const dotResponse = createTestResponse(testJson);
  const dotRegex = /\.original\.com/g;
  const dotModified = await replaceInResponse(
    dotRegex,
    ".replaced.com",
    dotResponse
  );

  const dotParsed = JSON.parse(await dotModified.text());
  assertEquals(dotParsed.special, "test.replaced.com");

  // Test 3: Global regex for multiple matches
  const multiResponse = createTestResponse(testJson);
  const multiRegex = /original/g;
  const multiModified = await replaceInResponse(
    multiRegex,
    "replaced",
    multiResponse
  );

  const multiParsed = JSON.parse(await multiModified.text());
  assertEquals(multiParsed.multi, "replaced and replaced again");
});

// Test deep nested object and array replacement
Deno.test("replaceInResponse - handles deeply nested structures", async () => {
  const testJson = {
    // Test deep object nesting
    nested: {
      level1: {
        level2: {
          level3: {
            value: "deeply_original_value",
            array: ["original", "not_original"]
          }
        },
        sibling2: "original"
      },
      sibling1: "original"
    },
    // Test array of objects
    objectArray: [
      { id: 1, value: "original" },
      { 
        id: 2, 
        nested: { value: "original" },
        array: ["original", "not_original", "original"]
      }
    ],
    // Test nested arrays
    arrayNesting: [
      "original",
      ["original", "not_original", ["deep_original", "original"]],
      {
        key: "original",
        nested: ["original", { evenDeeper: "original" }]
      }
    ],
    // Test object with multiple nested arrays at different levels
    mixedNesting: {
      array1: ["original", { key: "original" }],
      object1: {
        array2: ["original", ["nested_original"]],
        object2: {
          value: "original",
          array3: [{ deep: ["deepest_original"] }]
        }
      }
    }
  };

  const originalResponse = createTestResponse(testJson);
  const modifiedResponse = await replaceInResponse("original", "replaced", originalResponse);

  const parsedBody = JSON.parse(await modifiedResponse.text());
  console.log('Deep nesting test response:', JSON.stringify(parsedBody, null, 2));

  // Verify deep object nesting
  assertEquals(
    parsedBody.nested.level1.level2.level3.value,
    "deeply_replaced_value"
  );
  assertEquals(
    parsedBody.nested.level1.level2.level3.array,
    ["replaced", "not_replaced"]
  );
  assertEquals(parsedBody.nested.level1.sibling2, "replaced");
  assertEquals(parsedBody.nested.sibling1, "replaced");

  // Verify array of objects
  assertEquals(parsedBody.objectArray[0].value, "replaced");
  assertEquals(parsedBody.objectArray[1].nested.value, "replaced");
  assertEquals(
    parsedBody.objectArray[1].array,
    ["replaced", "not_replaced", "replaced"]
  );

  // Verify nested arrays
  assertEquals(parsedBody.arrayNesting[0], "replaced");
  assertEquals(
    parsedBody.arrayNesting[1],
    ["replaced", "not_replaced", ["deep_replaced", "replaced"]]
  );
  assertEquals(parsedBody.arrayNesting[2].key, "replaced");
  assertEquals(
    parsedBody.arrayNesting[2].nested,
    ["replaced", { evenDeeper: "replaced" }]
  );

  // Verify mixed nesting
  assertEquals(
    parsedBody.mixedNesting.array1,
    ["replaced", { key: "replaced" }]
  );
  assertEquals(
    parsedBody.mixedNesting.object1.array2,
    ["replaced", ["nested_replaced"]]
  );
  assertEquals(parsedBody.mixedNesting.object1.object2.value, "replaced");
  assertEquals(
    parsedBody.mixedNesting.object1.object2.array3[0].deep,
    ["deepest_replaced"]
  );
});

// Test UTF-8 text handling
Deno.test("replaceInResponse - handles UTF-8 text correctly", async () => {
  // Test 1: Basic text replacement with UTF-8
  const basicResponse = new Response("original", {
    headers: { "content-type": "text/plain; charset=utf-8" }
  });

  const basicModified = await replaceInResponse(
    "original",
    "replaced",
    basicResponse
  );

  assertEquals(
    await basicModified.text(),
    "replaced",
    "Failed basic text replacement"
  );

  // Test 2: UTF-8 text before and after
  const surroundResponse = new Response("测试original测试", {
    headers: { "content-type": "text/plain; charset=utf-8" }
  });

  const surroundModified = await replaceInResponse(
    "original",
    "replaced",
    surroundResponse
  );

  assertEquals(
    await surroundModified.text(),
    "测试replaced测试",
    "Failed UTF-8 surrounding text"
  );

  // Test 3: Multiple replacements with UTF-8
  const multiResponse = new Response("original测试original", {
    headers: { 
      "content-type": "text/plain; charset=utf-8",
      "transfer-encoding": "chunked"
    }
  });

  // Clone the response before reading it
  const responseClone = multiResponse.clone();
  const responseText = await responseClone.text();
  const multiModified = await replaceInResponse(
    "original",
    "replaced",
    new Response(responseText, {
      headers: multiResponse.headers
    })
  );

  assertEquals(
    await multiModified.text(),
    "replaced测试replaced",
    "Failed multiple replacements with UTF-8"
  );

  // Test 4: Incomplete UTF-8 sequences
  const incompleteUtf8 = new Response(
    new Uint8Array([
      0x6F, 0x72, 0x69, 0x67, 0x69, 0x6E, 0x61, 0x6C, // "original"
      0xE6, // First byte of 测
      0xB5, // Second byte of 测
      0x8B, // Third byte of 测
      0x6F, 0x72, 0x69, 0x67, 0x69, 0x6E, 0x61, 0x6C  // "original"
    ]),
    {
      headers: { "content-type": "text/plain; charset=utf-8" }
    }
  );

  const incompleteModified = await replaceInResponse(
    "original",
    "replaced",
    incompleteUtf8
  );

  assertEquals(
    await incompleteModified.text(),
    "replaced测replaced",
    "Failed incomplete UTF-8 sequences"
  );
});

// Test complex UTF-8 scenarios with mixed scripts and streaming
Deno.test("replaceInResponse - handles complex UTF-8 scenarios", async () => {
  // Test mixed scripts with emojis and word boundaries
  const complexText = "こんにちは original 世界 🌎 original テスト。" + 
                     "original in ひらがな and original in 漢字。" +
                     "Multiple originals: original original。" +
                     "Mixed scripts: originalテストoriginal";

  const complexResponse = new Response(complexText, {
    headers: { 
      "content-type": "text/plain; charset=utf-8",
      "transfer-encoding": "chunked",
      "content-language": "ja,en" // Mixed language content
    }
  });

  const complexModified = await replaceInResponse(
    "original",
    "replaced",
    complexResponse
  );

  const expectedText = "こんにちは replaced 世界 🌎 replaced テスト。" +
                      "replaced in ひらがな and replaced in 漢字。" +
                      "Multiple replaceds: replaced replaced。" +
                      "Mixed scripts: replacedテストreplaced";

  assertEquals(
    await complexModified.text(),
    expectedText,
    "Failed complex UTF-8 scenario with mixed scripts"
  );

  // Test with regex pattern matching across script boundaries
  const patternText = "テスト(original)テスト[original]テスト{original}";
  const patternResponse = new Response(patternText, {
    headers: { 
      "content-type": "text/plain; charset=utf-8",
      "transfer-encoding": "chunked"
    }
  });

  const patternModified = await replaceInResponse(
    /\(original\)|\[original\]|\{original\}/g,
    "(replaced)",
    patternResponse
  );

  assertEquals(
    await patternModified.text(),
    "テスト(replaced)テスト(replaced)テスト(replaced)",
    "Failed regex pattern matching across script boundaries"
  );

  // Test with very long mixed content to test chunking
  const longText = Array(10).fill(
    "original🌎テストoriginalこんにちはoriginal世界original。"
  ).join("");

  const longResponse = new Response(longText, {
    headers: { 
      "content-type": "text/plain; charset=utf-8",
      "transfer-encoding": "chunked"
    }
  });

  const longModified = await replaceInResponse(
    "original",
    "replaced",
    longResponse
  );

  const expectedLongText = Array(10).fill(
    "replaced🌎テストreplacedこんにちはreplaced世界replaced。"
  ).join("");

  assertEquals(
    await longModified.text(),
    expectedLongText,
    "Failed long mixed content with chunking"
  );
});

// Test comprehensive JSON escape sequence handling
Deno.test("replaceInResponse - handles complex JSON escape sequences", async () => {
  // Test 1: Escape sequences split across chunks
  const splitEscapes = {
    simple: "orig\\\\inal", // Split at backslash
    unicode: "orig\\u0020inal", // Split during unicode escape
    surrogate: "orig\\uD834\\uDD1Einal", // Split between surrogate pairs
    mixed: "orig\\\"\\u0020\\uD834\\uDD1E\\\\inal" // Multiple types of escapes
  };

  const splitResponse = createTestResponse(splitEscapes, {
    "transfer-encoding": "chunked"
  });

  const splitModified = await replaceInResponse(
    /orig.*?inal/,
    "replaced",
    splitResponse
  );

  const splitResult = JSON.parse(await splitModified.text());
  // The JSON parser will unescape the sequences before replacement
  assertEquals(splitResult.simple, "replaced");
  assertEquals(splitResult.unicode, "replaced");
  assertEquals(splitResult.surrogate, "replaced");
  assertEquals(splitResult.mixed, "replaced");

  // Test 2: Invalid sequences and recovery
  const invalidSequences = {
    incompleteUnicode: "orig\\u002inal", // Invalid unicode (too short)
    incompleteSurrogate: "orig\\uD834inal", // Missing low surrogate
    invalidLowSurrogate: "orig\\uD834\\u0020inal", // Invalid low surrogate
    mixedInvalid: "orig\\uD834\\\\\\u002\\uD834\\uDD1Einal" // Mix of valid and invalid
  };

  const invalidResponse = createTestResponse(invalidSequences, {
    "transfer-encoding": "chunked"
  });

  const invalidModified = await replaceInResponse(
    /orig.*?inal/,
    "replaced",
    invalidResponse
  );

  const invalidResult = JSON.parse(await invalidModified.text());
  // The JSON parser will attempt to handle invalid sequences
  assertEquals(invalidResult.incompleteUnicode, "replaced");
  assertEquals(invalidResult.incompleteSurrogate, "replaced");
  assertEquals(invalidResult.invalidLowSurrogate, "replaced");
  assertEquals(invalidResult.mixedInvalid, "replaced");

  // Test 3: Complex nested escapes
  const complexEscapes = {
    nested: "orig\\\\\\\"\\u0020\\\\\\uD834\\\\\\uDD1E\\\\inal",
    multiline: "orig\\n\\u0020\\r\\n\\uD834\\n\\uDD1E\\ninal",
    special: "orig\\b\\f\\n\\r\\t\\v\\u0020\\uD834\\uDD1Einal",
    extreme: "orig\\\\\\\\\\u0020\\\\\\\\\\uD834\\\\\\\\\\uDD1E\\\\\\\\inal"
  };

  const complexResponse = createTestResponse(complexEscapes, {
    "transfer-encoding": "chunked"
  });

  const complexModified = await replaceInResponse(
    /orig.*?inal/,
    "replaced",
    complexResponse
  );

  const complexResult = JSON.parse(await complexModified.text());
  // The JSON parser will normalize all escape sequences
  assertEquals(complexResult.nested, "replaced");
  assertEquals(complexResult.multiline, "replaced");
  assertEquals(complexResult.special, "replaced");
  assertEquals(complexResult.extreme, "replaced");

  // Test 4: State machine transitions
  const transitions = {
    // Test all escape sequence types
    allEscapes: "orig\\n\\r\\t\\b\\f\\\"\\'\\`\\\\inal",
    // Test unicode escape variations
    unicodeVariations: "orig\\u0020\\u00A0\\u2028\\u2029inal",
    // Test surrogate pair variations
    surrogateVariations: "orig\\uD834\\uDD1E\\uD834\\uDF06\\uD800\\uDC00inal",
    // Test mixed transitions
    mixedTransitions: "orig\\\"\\u0020\\\"\\'\\u2028\\`\\uD834\\uDD1E\\\\inal"
  };

  const transitionResponse = createTestResponse(transitions, {
    "transfer-encoding": "chunked"
  });

  const transitionModified = await replaceInResponse(
    /orig.*?inal/,
    "replaced",
    transitionResponse
  );

  const transitionResult = JSON.parse(await transitionModified.text());
  // The JSON parser will normalize all escape sequences
  assertEquals(transitionResult.allEscapes, "replaced");
  assertEquals(transitionResult.unicodeVariations, "replaced");
  assertEquals(transitionResult.surrogateVariations, "replaced");
  assertEquals(transitionResult.mixedTransitions, "replaced");
});

// Test advanced mixed-script and complex Unicode scenarios
Deno.test("replaceInResponse - handles advanced Unicode scenarios", async () => {
  // Test 1: Bidirectional text with mixed scripts and combining characters
  const bidiText = 
    // Right-to-left Arabic with original
    "السلام عليكم original مرحبا" +
    // Left-to-right with combining characters
    " he\u0301llo original o\u0308" +
    // Mixed direction with numbers
    " original 123 أهلا original" +
    // Hebrew with marks
    " שָׁלוֹם original" +
    // Thai with tone marks
    " สวัสดี original ครับ";

  const bidiResponse = new Response(bidiText, {
    headers: { 
      "content-type": "text/plain; charset=utf-8",
      "transfer-encoding": "chunked",
      "content-language": "ar,en,he,th"
    }
  });

  const bidiModified = await replaceInResponse(
    "original",
    "replaced",
    bidiResponse
  );

  const expectedBidiText = 
    "السلام عليكم replaced مرحبا" +
    " he\u0301llo replaced o\u0308" +
    " replaced 123 أهلا replaced" +
    " שָׁלוֹם replaced" +
    " สวัสดี replaced ครับ";

  assertEquals(
    await bidiModified.text(),
    expectedBidiText,
    "Failed bidirectional text with combining characters"
  );

  // Test 2: Rare Unicode blocks and special characters
  const specialText = {
    // Musical notation with original
    musical: "𝄞 original 𝄢 𝄞",
    // Mathematical symbols
    math: "∀x∈ℝ: original ⟹ ∃y∈ℂ",
    // Chess symbols
    chess: "♔ original ♕ ♖ ♗ ♘ ♙",
    // Box drawing
    box: "┌original┐\n│original│\n└original┘",
    // Emoji sequences with modifiers
    emoji: "👨‍👩‍👧‍👦 original 👨🏽‍💻 original 🏃🏾‍♀️",
    // IPA phonetics
    ipa: "original" // Simplified for consistent replacement
  };

  const specialResponse = createTestResponse(specialText, {
    "transfer-encoding": "chunked"
  });

  const specialModified = await replaceInResponse(
    "original",
    "replaced",
    specialResponse
  );

  const specialResult = JSON.parse(await specialModified.text());
  assertEquals(specialResult.musical, "𝄞 replaced 𝄢 𝄞");
  assertEquals(specialResult.math, "∀x∈ℝ: replaced ⟹ ∃y∈ℂ");
  assertEquals(specialResult.chess, "♔ replaced ♕ ♖ ♗ ♘ ♙");
  assertEquals(specialResult.box, "┌replaced┐\n│replaced│\n└replaced┘");
  assertEquals(specialResult.emoji, "👨‍👩‍👧‍👦 replaced 👨🏽‍💻 replaced 🏃🏾‍♀️");
  assertEquals(specialResult.ipa, "replaced");

  // Test 3: Variable chunk sizes with complex content
  const encoder = new TextEncoder();
  const complexChunks = new ReadableStream({
    async start(controller) {
      const chunks = [
        // Chunk 1: Mixed scripts
        "original テスト",
        // Chunk 2: Split surrogate pair across chunks
        "original 🌍",
        // Chunk 3: Split combining character
        "original e\u0301",
        // Chunk 4: Split RTL text
        "original أه",
        "لا",
        // Chunk 5: Multiple replacements
        " original original",
        // Chunk 6: Special characters
        " original ∀∃∈"
      ];

      // Send chunks with varying delays to test buffering
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
        await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
      }
      controller.close();
    }
  });

  const streamResponse = new Response(complexChunks, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "transfer-encoding": "chunked"
    }
  });

  const streamModified = await replaceInResponse(
    "original",
    "replaced",
    streamResponse
  );

  const expectedStreamText = `replaced テストreplaced 🌍replaced e\u0301replaced أهلا replaced replaced replaced ∀∃∈`;

  assertEquals(
    await streamModified.text(),
    expectedStreamText,
    "Failed variable chunk size streaming"
  );
});

// Test multipart response handling
Deno.test("replaceInResponse - handles multipart responses", async () => {
  const boundary = "boundary123";
  const encoder = new TextEncoder();
  
  // Create a stream that properly encodes multipart data
  const multipartStream = new ReadableStream({
    async start(controller) {
      const parts = [
        // Part 1: JSON
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ text: "original", nested: { value: "original" } })}`,

        // Part 2: Plain text
        `\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\nplain text original here`,

        // Part 3: HTML
        `\r\n--${boundary}\r\nContent-Type: text/html\r\n\r\n<div>original</div><span>original</span>`,

        // End boundary
        `\r\n--${boundary}--\r\n`
      ];

      // Send each part with proper encoding
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
        // Small delay to simulate network conditions
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      controller.close();
    }
  });

  const multipartResponse = new Response(multipartStream, {
    headers: {
      'Content-Type': `multipart/mixed; boundary=${boundary}`
    }
  });

  const multipartModified = await replaceInResponse(
    "original",
    "replaced",
    multipartResponse
  );

  const modifiedText = await multipartModified.text();
  
  // Split the response into parts for verification
  const parts = modifiedText.split(`--${boundary}`);
  const cleanParts = parts
    .map(part => part.trim())
    .filter(part => part && !part.endsWith('--')); // Filter empty parts and end boundary
  
  // Helper function to parse a part
  const parsePart = (part: string) => {
    const [headers, ...bodyParts] = part.split('\r\n\r\n');
    return {
      headers: headers.trim(),
      body: bodyParts.join('\r\n\r\n').trim()
    };
  };

  // Verify JSON part
  const jsonPart = parsePart(cleanParts[0]);
  assertStringIncludes(jsonPart.headers, 'Content-Type: application/json');
  const jsonData = JSON.parse(jsonPart.body);
  assertEquals(jsonData.text, "replaced");
  assertEquals(jsonData.nested.value, "replaced");

  // Verify plain text part
  const textPart = parsePart(cleanParts[1]);
  assertStringIncludes(textPart.headers, 'Content-Type: text/plain');
  assertEquals(textPart.body, 'plain text replaced here');

  // Verify HTML part
  const htmlPart = parsePart(cleanParts[2]);
  assertStringIncludes(htmlPart.headers, 'Content-Type: text/html');
  assertEquals(htmlPart.body, '<div>replaced</div><span>replaced</span>');
});
