import clarinet from 'npm:clarinet@0.12.6'

/**
 * State machine states for handling JSON string escape sequences.
 * Used to properly handle Unicode surrogate pairs and other escape sequences
 * across chunk boundaries in streaming responses.
 */
enum EscapeState {
  /** Normal string processing state */
  Normal = 0,
  /** Just encountered a backslash */
  Escaped = 1,
  /** Processing \u in Unicode escape */
  Unicode1 = 2,
  /** Processing first hex digit after \u */
  Unicode2 = 3,
  /** Processing second hex digit */
  Unicode3 = 4,
  /** Processing third hex digit */
  Unicode4 = 5,
  /** Completed high surrogate, waiting for low surrogate */
  HighSurrogate = 6,
  /** Processing \u after high surrogate */
  LowSurrogate1 = 7,
  /** Processing \uD after high surrogate */
  LowSurrogate2 = 8,
  /** Processing \uDC after high surrogate */
  LowSurrogate3 = 9,
  /** Processing \uDC0 after high surrogate */
  LowSurrogate4 = 10,
}

/**
 * Transformer for handling JSON content streams.
 * Implements proper escape sequence handling and surrogate pair processing
 * while maintaining streaming capabilities.
 */
interface JsonTransformer extends Transformer<string, string> {
  /** Accumulates partial chunks for processing */
  buffer: string
  /** Stores processed JSON tokens before output */
  tokens: string[]
  /** Clarinet streaming JSON parser instance */
  parser: ReturnType<typeof clarinet.parser>
  /** Current nesting depth in JSON structure */
  depth: number
  /** Whether currently processing a string value */
  inString: boolean
  /** Current state in escape sequence processing */
  escapeState: EscapeState
  /** Buffer for Unicode escape sequence characters */
  unicodeChars: string
  /** Stores high surrogate until matching low surrogate is found */
  highSurrogate: string | null
  /** Accumulates low surrogate characters during processing */
  lowSurrogate: string
}

/**
 * Transformer for handling text content streams.
 * Provides UTF-8 aware chunking and proper word boundary detection
 * for various scripts including CJK.
 */
interface TextTransformer extends Transformer<string, string> {
  /** Accumulates partial chunks for processing */
  buffer: string
  /** Set of characters that mark safe break points for chunking */
  safeBreakPoints: Set<string>
  /** Maximum chunk size before forcing a break */
  maxWindowSize: number
  /** Buffer for incomplete UTF-8 sequences */
  utf8Buffer: number[]
  /** Word segmenter for CJK text */
  segmenter: Intl.Segmenter
  /** Tracks script changes for mixed-script content */
  lastScript: string | null
}

// Export interfaces for mod.ts
export type { JsonTransformer, TextTransformer }

// Export the enum for mod.ts
export { EscapeState }

// UTF-8 sequence length detection and validation
/**
 * Determines the length and validation rules for a UTF-8 sequence.
 * @param byte - The first byte of a potential UTF-8 sequence
 * @returns Object containing sequence length and expected continuation bytes
 */
function getUtf8SequenceInfo(byte: number): {
  length: number
  expectedBytes?: number[]
} {
  if ((byte & 0x80) === 0) return { length: 1 }
  if ((byte & 0xe0) === 0xc0) return { length: 2, expectedBytes: [0x80, 0xbf] }
  if ((byte & 0xf0) === 0xe0) return { length: 3, expectedBytes: [0x80, 0xbf, 0x80, 0xbf] }
  if ((byte & 0xf8) === 0xf0) return { length: 4, expectedBytes: [0x80, 0xbf, 0x80, 0xbf, 0x80, 0xbf] }
  return { length: 0 } // Invalid UTF-8 sequence
}

/**
 * Validates a UTF-8 byte sequence.
 * @param bytes - Array of bytes representing a potential UTF-8 sequence
 * @returns Whether the sequence is valid UTF-8
 */
function isValidUtf8Sequence(bytes: Uint8Array): boolean {
  const first = bytes[0]
  switch (bytes.length) {
    case 1:
      // Must be <= 0x7F for a single-byte ASCII
      return first <= 0x7f
    case 2:
      // Leading byte must be >= 0xC2 to avoid overlong encoding
      if (first < 0xc2 || first > 0xdf) return false
      break
    case 3:
      // Prevent overlong if first == 0xE0 but second < 0xA0, etc.
      if (first === 0xe0 && (bytes[1] < 0xa0 || bytes[1] > 0xbf)) return false
      if (first >= 0xe1 && first <= 0xec) {
        /* valid if second is [0x80..0xbf] */
      }
      if (first === 0xed && (bytes[1] < 0x80 || bytes[1] > 0x9f)) return false // Avoid surrogates
      if (first === 0xee || first === 0xef) {
        /* valid if second is [0x80..0xbf] */
      }

      break
    case 4:
      // Prevent overlong if first == 0xF0 but second < 0x90, etc.
      if (first === 0xf0 && (bytes[1] < 0x90 || bytes[1] > 0xbf)) return false
      if (first === 0xf4 && (bytes[1] < 0x80 || bytes[1] > 0x8f)) return false
      // Leading byte must be <= 0xF4
      if (first < 0xf0 || first > 0xf4) return false
      break
    default:
      return false
  }
  // Validate continuation bytes for everything after the first
  for (let i = 1; i < bytes.length; i++) {
    if (bytes[i] < 0x80 || bytes[i] > 0xbf) return false
  }
  return true
}

/**
 * Converts a valid UTF-8 byte sequence to its Unicode code point.
 * @param bytes - Valid UTF-8 byte sequence
 * @returns Unicode code point or null if invalid
 */
function codePointFromUtf8(bytes: Uint8Array): number | null {
  if (!isValidUtf8Sequence(bytes)) {
    return null // Invalid sequence
  }

  let codePoint = 0
  const first = bytes[0]

  if (bytes.length === 1) {
    return first
  } else if (bytes.length === 2) {
    codePoint = ((first & 0x1f) << 6) | (bytes[1] & 0x3f)
  } else if (bytes.length === 3) {
    codePoint = ((first & 0x0f) << 12) | ((bytes[1] & 0x3f) << 6) | (bytes[2] & 0x3f)
  } else if (bytes.length === 4) {
    codePoint = ((first & 0x07) << 18) | ((bytes[1] & 0x3f) << 12) | ((bytes[2] & 0x3f) << 6) | (bytes[3] & 0x3f)
  }

  return codePoint
}

/**
 * Type guard for objects.
 * @param value - Value to check
 * @returns Whether the value is a non-null object
 * @internal
 */
function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

/**
 * Unwraps a potentially proxied object to get its target.
 * @param value - Value that might be a proxy
 * @returns Unwrapped value
 */
function unwrapProxy(value: unknown): unknown {
  if (!isObject(value)) return value
  try {
    // Vue/MobX convention.  If it exists, use it.
    if (typeof value === 'object' && value !== null) {
      const raw = Reflect.get(value, '__raw__')
      if (raw) return raw
    }
    // deno-lint-ignore no-empty
  } catch {}
  return value
}

/**
 * Default set of characters that indicate safe points to split text chunks.
 * Includes common sentence endings, punctuation, and CJK text boundaries.
 */
const DEFAULT_SAFE_BREAK_POINTS = new Set([
  ' ',
  '\n',
  '\r',
  '\t',
  '.',
  ',',
  '!',
  '?',
  ';',
  ':',
  ')',
  ']',
  '}',
  // Add common word boundaries for CJK text
  '。',
  '、',
  '，',
  '！',
  '？',
  '；',
  '：',
  '）',
  '】',
  '』',
  '》',
])

/**
 * Maximum number of bytes to buffer before forcing a chunk split.
 * Used to prevent excessive memory usage during streaming.
 */
const DEFAULT_MAX_WINDOW = 1024

/**
 * Creates a transform stream for JSON content that replaces text in string values.
 * Handles escape sequences and surrogate pairs across chunk boundaries.
 *
 * @internal
 * @param regex - Global regular expression for matching
 * @param replacement - Replacement string
 * @param _encoding - Character encoding (currently unused)
 * @returns Transform stream for JSON content
 */
function createJsonTransformStream(
  regex: RegExp,
  replacement: string,
  _encoding: string,
): TransformStream<string, string> {
  return new TransformStream<string, string>({
    start(controller) {
      ;(this as JsonTransformer).buffer = ''
      ;(this as JsonTransformer).tokens = []
      ;(this as JsonTransformer).parser = clarinet.parser()
      ;(this as JsonTransformer).depth = 0
      ;(this as JsonTransformer).inString = false
      ;(this as JsonTransformer).escapeState = EscapeState.Normal
      ;(this as JsonTransformer).unicodeChars = ''
      ;(this as JsonTransformer).highSurrogate = null
      ;(this as JsonTransformer).lowSurrogate = ''

      const transformer = this as JsonTransformer
      transformer.parser.onerror = (e: Error) => controller.error(e)

      transformer.parser.onopenobject = (key: string) => {
        transformer.depth++
        transformer.tokens.push('{')
        transformer.tokens.push(JSON.stringify(key))
        transformer.tokens.push(':')
      }

      transformer.parser.onkey = (key: string) => {
        transformer.tokens.push(',')
        transformer.tokens.push(JSON.stringify(key))
        transformer.tokens.push(':')
      }

      transformer.parser.oncloseobject = () => {
        transformer.depth--
        transformer.tokens.push('}')
      }

      transformer.parser.onopenarray = () => {
        transformer.depth++
        transformer.tokens.push('[')
      }

      transformer.parser.onvalue = (v: unknown) => {
        if (
          transformer.tokens.length > 0 &&
          transformer.tokens[transformer.tokens.length - 1] !== '[' &&
          transformer.tokens[transformer.tokens.length - 1] !== '{' &&
          transformer.tokens[transformer.tokens.length - 1] !== ':'
        ) {
          transformer.tokens.push(',')
        }
        if (typeof v === 'string') {
          const replaced = v.replace(regex, replacement)
          transformer.tokens.push(JSON.stringify(replaced))
        } else {
          transformer.tokens.push(JSON.stringify(v))
        }
      }

      transformer.parser.onclosearray = () => {
        transformer.depth--
        transformer.tokens.push(']')
      }
    },

    transform(chunk: string, controller) {
      const transformer = this as JsonTransformer

      // Process the chunk character by character with proper escape sequence handling
      for (let i = 0; i < chunk.length; i++) {
        const char = chunk[i]

        switch (transformer.escapeState) {
          case EscapeState.Normal:
            if (char === '\\') {
              transformer.escapeState = EscapeState.Escaped
            } else if (char === '"' && transformer.depth === 0) {
              transformer.inString = !transformer.inString
            }
            break

          case EscapeState.Escaped:
            if (char === 'u') {
              transformer.escapeState = transformer.highSurrogate ? EscapeState.LowSurrogate1 : EscapeState.Unicode1
              transformer.unicodeChars = ''
              transformer.lowSurrogate = ''
            } else {
              if (transformer.highSurrogate) {
                // Invalid sequence after high surrogate
                transformer.highSurrogate = null
              }
              transformer.escapeState = EscapeState.Normal
            }
            break

          case EscapeState.Unicode1:
          case EscapeState.Unicode2:
          case EscapeState.Unicode3:
            if (/[0-9a-fA-F]/.test(char)) {
              transformer.unicodeChars += char
              transformer.escapeState++
            } else {
              transformer.escapeState = EscapeState.Normal
              transformer.highSurrogate = null // Reset on invalid sequence
            }
            break

          case EscapeState.Unicode4:
            if (/[0-9a-fA-F]/.test(char)) {
              transformer.unicodeChars += char
              // Check if this is a high surrogate
              const codePoint = Number.parseInt(transformer.unicodeChars, 16)
              if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
                transformer.highSurrogate = transformer.unicodeChars
                transformer.escapeState = EscapeState.HighSurrogate
              } else {
                if (transformer.highSurrogate) {
                  // Invalid sequence, reset high surrogate
                  transformer.highSurrogate = null
                }
                transformer.escapeState = EscapeState.Normal
              }
            } else {
              transformer.escapeState = EscapeState.Normal
              transformer.highSurrogate = null // Reset on invalid sequence
            }
            break

          case EscapeState.HighSurrogate:
            if (char === '\\') {
              transformer.escapeState = EscapeState.Escaped
            } else {
              // Invalid sequence after high surrogate
              // DO NOT reset highSurrogate here.  Wait for flush().
              transformer.escapeState = EscapeState.Normal
            }
            break

          case EscapeState.LowSurrogate1:
          case EscapeState.LowSurrogate2:
          case EscapeState.LowSurrogate3:
            if (/[0-9a-fA-F]/.test(char)) {
              transformer.lowSurrogate += char
              transformer.escapeState++
            } else {
              // Invalid low surrogate sequence
              transformer.highSurrogate = null
              transformer.escapeState = EscapeState.Normal
            }
            break

          case EscapeState.LowSurrogate4:
            if (/[0-9a-fA-F]/.test(char)) {
              transformer.lowSurrogate += char
              const lowCodePoint = Number.parseInt(transformer.lowSurrogate, 16)
              if (lowCodePoint >= 0xdc00 && lowCodePoint <= 0xdfff && transformer.highSurrogate) {
                // Valid surrogate pair, combine them
                const highCodePoint = Number.parseInt(transformer.highSurrogate, 16)
                const combinedCodePoint = ((highCodePoint - 0xd800) << 10) + (lowCodePoint - 0xdc00) + 0x10000
                transformer.unicodeChars = combinedCodePoint.toString(16)
                transformer.escapeState = EscapeState.Normal
              }
              transformer.highSurrogate = null // Always reset after processing low surrogate
            } else {
              // Invalid low surrogate sequence
              transformer.highSurrogate = null
              transformer.escapeState = EscapeState.Normal
            }
            break
        }

        transformer.buffer += char
      }

      // NEW: Handle incomplete escape sequence at the end of the chunk.
      if (transformer.escapeState === EscapeState.Escaped && !transformer.buffer.endsWith('\\')) {
        transformer.buffer += '\\' // Store the escape character for the next chunk
      }
      if (transformer.escapeState === EscapeState.Escaped) {
        return
      }

      if (transformer.tokens.length > 0) {
        controller.enqueue(transformer.tokens.join(''))
        transformer.tokens.length = 0 // Clear instead of reassign
      }
    },

    flush(controller) {
      const transformer = this as JsonTransformer

      // Add this handling for incomplete surrogates:
      if (transformer.escapeState === EscapeState.HighSurrogate) {
        // If we're still in HighSurrogate state at the end,
        // it means we didn't get a matching low surrogate.
        // Treat this as an incomplete/invalid sequence.
        // Buffer the high surrogate
        transformer.buffer = `\\u${transformer.highSurrogate}${transformer.buffer}`
        transformer.highSurrogate = null // Reset now.
        transformer.escapeState = EscapeState.Normal
      }

      if (transformer.buffer.length > 0) {
        try {
          transformer.parser.write(transformer.buffer)
        } catch (e) {
          // Handle the error here.  For example, log it and/or enqueue an error message.
          console.error('JSON parsing error during flush:', e)
          controller.error(e) // This will terminate the stream with an error.
          return // Important: Stop processing after an error.
        }
      }

      try {
        transformer.parser.close()
      } catch (e) {
        // Handle close errors as well
        console.error('JSON parsing error during close:', e)
        controller.error(e) // Terminate the stream.
        return
      }

      if (transformer.tokens.length > 0) {
        controller.enqueue(transformer.tokens.join(''))
        transformer.tokens.length = 0 // Clear instead of reassign
      }
    },
  })
}

/**
 * Replaces text patterns in an HTTP response's headers and body while preserving the streaming nature
 * and handling complex Unicode scenarios correctly.
 *
 * Features:
 * - Streaming support with proper backpressure
 * - UTF-8 aware text chunking
 * - Proper JSON string handling including escape sequences
 * + - Multipart response handling with content-type specific processing
 * - Content-type specific processing
 * - Header modification
 *
 * @param search - String or RegExp pattern to search for
 * @param replacement - Replacement string (can include regex capture groups)
 * @param response - Original HTTP Response object
 * @returns A new Response with replacements applied
 *
 * @example
 * ```ts
 * // Replace all occurrences of "original" with "new" in a response
 * const newResponse = await replaceInResponse("original", "new", response);
 *
 * // Use regex with capture groups
 * const newResponse = await replaceInResponse(
 *   /user_(\d+)/g,
 *   "member_$1",
 *   response
 * );
 * ```
 */
export async function replaceInResponse(
  search: string | RegExp,
  replacement: string,
  response: Response,
): Promise<Response> {
  // Store original transfer-encoding state
  const hadTransferEncoding = response.headers.has('transfer-encoding')

  // Normalize search into a fresh global RegExp instance
  const regex =
    typeof search === 'string'
      ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
      : new RegExp(search.source, search.flags.includes('g') ? search.flags : `${search.flags}g`)

  function deepReplace(value: unknown, seen: WeakSet<object | unknown[]>, path: (string | number)[] = []): unknown {
    // Unwrap any Proxy objects
    value = unwrapProxy(value)

    if (typeof value === 'string') {
      return value.replace(regex, replacement)
    }
    if (value && typeof value === 'object') {
      // Check for circular references at current path
      if (seen.has(value as object)) {
        console.warn(`Circular reference detected at path: ${path.join('.')}`)
        return value
      }
      seen.add(value as object)

      if (Array.isArray(value)) {
        // Track array itself and its path
        seen.add(value)
        return value.map((v, i) => deepReplace(unwrapProxy(v), seen, [...path, i]))
      }

      const replacedObj: Record<string | symbol, unknown> = {}
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') continue
        const desc = Object.getOwnPropertyDescriptor(value, key)
        if (!desc?.enumerable) continue

        replacedObj[key] = deepReplace(unwrapProxy(Reflect.get(value, key)), seen, [...path, String(key)])
      }
      return replacedObj
    }
    return value
  }

  // Overwrite ALL headers (including sensitive ones)
  const updatedHeaders = new Headers(response.headers)
  updatedHeaders.forEach((value, key) => {
    updatedHeaders.set(key, value.replace(regex, replacement))
  })

  // Determine content type and character encoding
  const contentType = (updatedHeaders.get('content-type') || '').toLowerCase()
  const isJson = /^application\/(\w+\+)?json/.test(contentType)
  const isMultipart = contentType.startsWith('multipart/')
  const isTextLike =
    contentType.includes('text') ||
    contentType.includes('html') ||
    contentType.includes('xml') ||
    contentType.includes('csv')

  // Get boundary for multipart responses
  let boundary = ''
  if (isMultipart) {
    const boundaryMatch = /boundary=([^;]+)/i.exec(contentType)
    if (boundaryMatch) {
      boundary = boundaryMatch[1]
    }
  }

  // Improved charset detection with strict validation
  let encoding = 'utf-8'
  const charsetMatch = /charset\s*=\s*([^;]+)/i.exec(contentType)
  if (charsetMatch) {
    try {
      // Verify the encoding is supported with strict mode
      new TextDecoder(charsetMatch[1], { fatal: true })
      encoding = charsetMatch[1]
    } catch (e) {
      console.warn(`Unsupported charset: ${charsetMatch[1]}, falling back to UTF-8`, (e as Error).message)
    }
  }

  const decoder = new TextDecoder(encoding, { fatal: true })
  const encoder = new TextEncoder()

  // Handle transfer-encoding consistently
  const isChunked = updatedHeaders.has('transfer-encoding')
  if (isChunked || hadTransferEncoding) {
    updatedHeaders.delete('content-length')
  }

  // If body is not JSON, multipart, or text-like, return unmodified body with updated headers
  if (!isJson && !isMultipart && !isTextLike) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: updatedHeaders,
    })
  }

  // Ensure response.body exists
  if (!response.body) {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: updatedHeaders,
    })
  }

  // For multipart responses
  if (isMultipart && boundary) {
    const textBuffer = await response.arrayBuffer()
    const originalText = decoder.decode(textBuffer)
    const parts = originalText.split(`--${boundary}`)

    const processedParts = parts.map((part) => {
      if (!part.trim() || part.trim() === '--') return part

      const [headers, ...bodyParts] = part.split('\r\n\r\n')
      const body = bodyParts.join('\r\n\r\n')

      // Process the body based on its content type
      const contentTypeMatch = /content-type:\s*([^;\r\n]+)/i.exec(headers)
      if (contentTypeMatch) {
        const partContentType = contentTypeMatch[1].toLowerCase()
        if (partContentType.includes('json')) {
          try {
            const jsonData = JSON.parse(body)
            const seen = new WeakSet<object | unknown[]>()
            const replacedJson = deepReplace(jsonData, seen)
            return `${headers}\r\n\r\n${JSON.stringify(replacedJson)}`
          } catch {
            // If JSON parsing fails, fall back to text replacement
            return `${headers}\r\n\r\n${body.replace(regex, replacement)}`
          }
        } else if (
          partContentType.includes('text') ||
          partContentType.includes('html') ||
          partContentType.includes('xml')
        ) {
          return `${headers}\r\n\r\n${body.replace(regex, replacement)}`
        }
      }
      return `${headers}\r\n\r\n${body}` // Return unmodified for unknown content types
    })

    const modifiedText = processedParts.join(`--${boundary}`)
    const replacedBytes = encoder.encode(modifiedText)

    // Only set content-length if response wasn't originally chunked AND wasn't chunked now
    if (!hadTransferEncoding && !isChunked) {
      updatedHeaders.set('content-length', String(replacedBytes.length))
    }

    return new Response(replacedBytes, {
      status: response.status,
      statusText: response.statusText,
      headers: updatedHeaders,
    })
  }

  // For JSON responses
  if (isJson) {
    if (!isChunked && !hadTransferEncoding) {
      const textBuffer = await response.arrayBuffer()
      const originalText = decoder.decode(textBuffer)
      try {
        const jsonData = JSON.parse(originalText)
        // Deep replacement with full circular reference protection
        const seen = new WeakSet<object | unknown[]>()
        const replacedJson = deepReplace(jsonData, seen)
        const modifiedText = JSON.stringify(replacedJson)
        const replacedBytes = encoder.encode(modifiedText)

        // Only set content-length if response wasn't originally chunked AND wasn't chunked now
        if (!hadTransferEncoding && !isChunked) {
          updatedHeaders.set('content-length', String(replacedBytes.length))
        }

        return new Response(replacedBytes, {
          status: response.status,
          statusText: response.statusText,
          headers: updatedHeaders,
        })
      } catch (_e) {
        // On JSON parse failure, fall back to simple text replacement
        const modifiedText = originalText.replace(regex, replacement)
        const replacedBytes = encoder.encode(modifiedText)

        // Only set content-length if response wasn't originally chunked AND wasn't chunked now
        if (!hadTransferEncoding && !isChunked) {
          updatedHeaders.set('content-length', String(replacedBytes.length))
        }

        return new Response(replacedBytes, {
          status: response.status,
          statusText: response.statusText,
          headers: updatedHeaders,
        })
      }
    } else {
      // For chunked JSON responses, use streaming JSON parser with proper escape handling
      const jsonTransformStream = createJsonTransformStream(regex, replacement, encoding)
      const transformedStream = response.body
        .pipeThrough(new TextDecoderStream(encoding, { fatal: true }))
        .pipeThrough(jsonTransformStream)
        .pipeThrough(new TextEncoderStream())
      return new Response(transformedStream, {
        status: response.status,
        statusText: response.statusText,
        headers: updatedHeaders,
      })
    }
  }

  // For text-like responses, use optimized streaming with UTF-8 aware break points
  const textTransformStream = new TransformStream<string, string>({
    start() {
      ;(this as TextTransformer).buffer = ''
      ;(this as TextTransformer).safeBreakPoints = DEFAULT_SAFE_BREAK_POINTS
      ;(this as TextTransformer).maxWindowSize = DEFAULT_MAX_WINDOW
      ;(this as TextTransformer).utf8Buffer = []
      // Get locale from Content-Language, or default to browser locale
      const contentLanguage = response.headers.get('content-language')
      const locales = contentLanguage ? contentLanguage.split(',').map((lang) => lang.trim()) : undefined
      ;(this as TextTransformer).segmenter = new Intl.Segmenter(locales, {
        granularity: 'word',
      })
      ;(this as TextTransformer).lastScript = null
    },
    transform(chunk: string, controller) {
      const transformer = this as TextTransformer

      // Since chunk comes from TextDecoderStream, we need to encode it to process UTF-8 sequences
      const encodedChunk = encoder.encode(chunk)
      const allBytes = new Uint8Array(transformer.utf8Buffer.length + encodedChunk.length)
      allBytes.set(transformer.utf8Buffer)
      allBytes.set(encodedChunk, transformer.utf8Buffer.length)
      transformer.utf8Buffer.length = 0 // Clear instead of reassign

      let lastSafeIndex = 0
      let i = 0
      let currentScript = transformer.lastScript
      const codePoints: number[] = [] // Array to store code points - only use push operations

      while (i < allBytes.length) {
        const seqInfo = getUtf8SequenceInfo(allBytes[i])

        if (seqInfo.length === 0 || i + seqInfo.length > allBytes.length) {
          const remaining = allBytes.slice(i)
          transformer.utf8Buffer.length = 0
          transformer.utf8Buffer.push(...Array.from(remaining)) // Push instead of reassign
          break
        }

        let isValidSequence = true
        const charBytes = allBytes.slice(i, i + seqInfo.length)

        if (!isValidUtf8Sequence(charBytes)) {
          isValidSequence = false
        }

        if (!isValidSequence) {
          i++
          continue
        }

        const codePoint = codePointFromUtf8(charBytes)
        if (codePoint === null || codePoint > 0x10ffff) {
          i++
          continue
        }

        // Store the code point
        codePoints.push(codePoint)

        // Detect script changes (using code points)
        let script = null
        if (
          (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified Ideographs
          (codePoint >= 0x3040 && codePoint <= 0x309f) || // Hiragana
          (codePoint >= 0x30a0 && codePoint <= 0x30ff)
        ) {
          // Katakana
          script = 'CJK'
        } else if (
          (codePoint >= 0x0041 && codePoint <= 0x005a) || // Latin (uppercase)
          (codePoint >= 0x0061 && codePoint <= 0x007a)
        ) {
          // Latin (lowercase)
          script = 'Latin'
        }

        // Check for safe break points (using code points)
        const char = String.fromCodePoint(codePoint) // Convert to string for easier checks
        if (transformer.safeBreakPoints.has(char)) {
          lastSafeIndex = codePoints.length
        } else if (script === 'CJK') {
          const segments = transformer.segmenter.segment(char)
          if (Array.from(segments).some((seg) => seg.isWordLike)) {
            if (currentScript !== 'Latin') {
              lastSafeIndex = codePoints.length
            }
          }
        } else if (script === 'Latin' && currentScript === 'CJK') {
          lastSafeIndex = codePoints.length
        }

        currentScript = script || currentScript

        // Check for exceeding maxWindowSize (using code point count)
        if (codePoints.length - lastSafeIndex > transformer.maxWindowSize && lastSafeIndex > 0) {
          const processCodePoints = codePoints.slice(0, lastSafeIndex)
          const processText = String.fromCodePoint(...processCodePoints)
          const replaced = processText.replace(regex, replacement)

          // Enqueue the replaced text directly - encoding will be handled by TextEncoderStream
          controller.enqueue(replaced)

          // Clear the array instead of reassigning
          codePoints.length = 0
          codePoints.push(...codePoints.slice(lastSafeIndex))
          lastSafeIndex = 0
        }

        i += seqInfo.length
      }

      transformer.lastScript = currentScript

      // Process remaining code points
      if (codePoints.length > 0) {
        const processText = String.fromCodePoint(...codePoints)
        const replaced = processText.replace(regex, replacement)

        // Enqueue the replaced text directly - encoding will be handled by TextEncoderStream
        controller.enqueue(replaced)

        // Clear the code points array since we've processed everything
        codePoints.length = 0
      }

      // Store remaining bytes directly
      const remainingBytes = encoder.encode(String.fromCodePoint(...codePoints))
      transformer.utf8Buffer.length = 0
      transformer.utf8Buffer.push(...Array.from(remainingBytes))
    },
    flush(controller) {
      const transformer = this as TextTransformer
      if (transformer.utf8Buffer.length > 0) {
        try {
          // Process remaining bytes the same way as in transform
          const remainingBytes = new Uint8Array(transformer.utf8Buffer)
          const codePoints: number[] = []
          let i = 0

          while (i < remainingBytes.length) {
            const seqInfo = getUtf8SequenceInfo(remainingBytes[i])
            if (seqInfo.length === 0 || i + seqInfo.length > remainingBytes.length) {
              break
            }

            const charBytes = remainingBytes.slice(i, i + seqInfo.length)
            if (!isValidUtf8Sequence(charBytes)) {
              i++
              continue
            }

            const codePoint = codePointFromUtf8(charBytes)
            if (codePoint === null || codePoint > 0x10ffff) {
              i++
              continue
            }

            codePoints.push(codePoint)
            i += seqInfo.length
          }

          if (codePoints.length > 0) {
            const finalText = String.fromCodePoint(...codePoints)
            const replaced = finalText.replace(regex, replacement)
            controller.enqueue(replaced)
          }
        } catch (e: unknown) {
          console.error((e as Error).message)
          console.warn('Failed to process final UTF-8 bytes:', transformer.utf8Buffer)
        }
      }
    },
  })

  const transformedStream = response.body
    .pipeThrough(new TextDecoderStream(encoding, { fatal: true }))
    .pipeThrough(textTransformStream)
    .pipeThrough(new TextEncoderStream())

  if (!isChunked && !hadTransferEncoding) {
    // Accumulate full text to compute content-length
    const chunks: Uint8Array[] = []
    const reader = transformedStream.getReader()
    let result: ReadableStreamReadResult<Uint8Array>

    // Avoid assignment in expression
    while (true) {
      result = await reader.read()
      if (result.done) break
      chunks.push(result.value)
    }

    const finalBytes = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0))
    let offset = 0
    for (const chunk of chunks) {
      finalBytes.set(chunk, offset)
      offset += chunk.length
    }

    // Only set content-length if response wasn't originally chunked AND wasn't chunked now
    if (!hadTransferEncoding && !isChunked) {
      updatedHeaders.set('content-length', String(finalBytes.length))
    }

    return new Response(finalBytes, {
      status: response.status,
      statusText: response.statusText,
      headers: updatedHeaders,
    })
  }

  return new Response(transformedStream, {
    status: response.status,
    statusText: response.statusText,
    headers: updatedHeaders,
  })
}
