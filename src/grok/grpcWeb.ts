const BASE64_BODY_RE = /^[A-Za-z0-9+/=\r\n]+$/;

export interface GrpcWebParseResult {
  messages: Uint8Array[];
  trailers: Record<string, string>;
  grpc_status: number | null;
  grpc_message: string;
}

export interface ParseGrpcWebResponseArgs {
  body: ArrayBuffer | Uint8Array;
  headers?: Headers | Record<string, string>;
  contentType?: string | null;
}

function toUint8Array(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function readHeader(headers: Headers | Record<string, string> | undefined, name: string): string {
  if (!headers) return "";
  const key = name.toLowerCase();

  if (headers instanceof Headers) {
    const value = headers.get(name) ?? headers.get(key);
    return value ? value.trim() : "";
  }

  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === key) return String(v ?? "").trim();
  }
  return "";
}

function decodeGrpcMessage(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function isProbablyBase64Body(body: Uint8Array): boolean {
  if (body.length === 0) return false;
  const head = body.subarray(0, Math.min(body.length, 1024));
  let text = "";
  for (let i = 0; i < head.length; i++) text += String.fromCharCode(head[i]!);
  return BASE64_BODY_RE.test(text);
}

function decodeBase64Body(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function maybeDecodeGrpcWebText(body: Uint8Array, contentType: string): Uint8Array {
  const contentTypeLower = contentType.toLowerCase();
  const shouldDecodeText = contentTypeLower.includes("grpc-web-text");
  const shouldTryHeuristic = !shouldDecodeText && isProbablyBase64Body(body);
  if (!shouldDecodeText && !shouldTryHeuristic) return body;

  const compact = new TextDecoder().decode(body).replace(/\s+/g, "");
  if (!compact) return body;
  const decoded = decodeBase64Body(compact);
  return decoded ?? body;
}

function parseTrailerBlock(payload: Uint8Array): Record<string, string> {
  const text = new TextDecoder().decode(payload);
  const trailers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || !line.includes(":")) continue;
    const index = line.indexOf(":");
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (!key) continue;
    trailers[key] = key === "grpc-message" ? decodeGrpcMessage(value) : value;
  }
  return trailers;
}

function parseGrpcStatus(value: string): number | null {
  const raw = value.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}

export function encodeGrpcWebFrame(payload: ArrayBuffer | Uint8Array): Uint8Array {
  const data = toUint8Array(payload);
  const frame = new Uint8Array(5 + data.length);
  frame[0] = 0x00;
  const length = data.length;
  frame[1] = (length >>> 24) & 0xff;
  frame[2] = (length >>> 16) & 0xff;
  frame[3] = (length >>> 8) & 0xff;
  frame[4] = length & 0xff;
  frame.set(data, 5);
  return frame;
}

export function parseGrpcWebResponse(args: ParseGrpcWebResponseArgs): GrpcWebParseResult {
  const sourceHeaders = args.headers;
  const contentType = args.contentType ?? readHeader(sourceHeaders, "content-type");
  const rawBody = toUint8Array(args.body);
  const decodedBody = maybeDecodeGrpcWebText(rawBody, contentType ?? "");

  const messages: Uint8Array[] = [];
  const trailers: Record<string, string> = {};

  let offset = 0;
  while (offset + 5 <= decodedBody.length) {
    const flag = decodedBody[offset] ?? 0;
    const length =
      ((decodedBody[offset + 1] ?? 0) << 24) |
      ((decodedBody[offset + 2] ?? 0) << 16) |
      ((decodedBody[offset + 3] ?? 0) << 8) |
      (decodedBody[offset + 4] ?? 0);
    offset += 5;

    if (length < 0 || offset + length > decodedBody.length) break;
    const payload = decodedBody.subarray(offset, offset + length);
    offset += length;

    if (flag & 0x80) {
      Object.assign(trailers, parseTrailerBlock(payload));
      continue;
    }
    if (flag & 0x01) {
      throw new Error("grpc-web compressed frame is not supported");
    }
    messages.push(payload.slice());
  }

  if (!trailers["grpc-status"]) {
    const headerStatus = readHeader(sourceHeaders, "grpc-status");
    if (headerStatus) trailers["grpc-status"] = headerStatus;
  }
  if (!trailers["grpc-message"]) {
    const headerMessage = readHeader(sourceHeaders, "grpc-message");
    if (headerMessage) trailers["grpc-message"] = decodeGrpcMessage(headerMessage);
  }

  const grpc_status = parseGrpcStatus(trailers["grpc-status"] ?? "");
  const grpc_message = trailers["grpc-message"] ?? "";

  return { messages, trailers, grpc_status, grpc_message };
}

export async function parseGrpcWebFetchResponse(response: Response): Promise<GrpcWebParseResult> {
  const body = await response.arrayBuffer();
  return parseGrpcWebResponse({
    body,
    headers: response.headers,
    contentType: response.headers.get("content-type"),
  });
}
