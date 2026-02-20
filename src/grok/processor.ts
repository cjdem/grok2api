import type { GrokSettings, GlobalSettings } from "../settings";
import { ToolUsageCardStreamParser, replaceToolUsageCardsInText } from "./toolUsageCard";

type GrokNdjson = Record<string, unknown>;
type GrokObj = Record<string, unknown>;

export interface GrokConversationMeta {
  grokConversationId: string;
  lastResponseId: string;
}

interface StreamFinishResult {
  status: number;
  duration: number;
  meta: GrokConversationMeta;
}

function asObj(v: unknown): GrokObj | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as GrokObj) : null;
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function extractMetaFromLine(data: GrokNdjson): Partial<GrokConversationMeta> {
  const result = asObj((data as any).result);
  if (!result) return {};

  const conversation = asObj(result.conversation);
  const response = asObj(result.response);
  const userResponse = asObj(result.userResponse);
  const modelResponse = asObj(result.modelResponse);
  const responseModel = asObj(response?.modelResponse);

  return {
    grokConversationId: asStr(conversation?.conversationId),
    lastResponseId:
      asStr(response?.responseId) ||
      asStr(responseModel?.responseId) ||
      asStr(modelResponse?.responseId) ||
      asStr(userResponse?.responseId),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<ReadableStreamReadResult<Uint8Array> | { timeout: true }> {
  if (ms <= 0) return { timeout: true };
  return Promise.race([
    reader.read(),
    sleep(ms).then(() => ({ timeout: true }) as const),
  ]);
}

function makeChunk(
  id: string,
  created: number,
  model: string,
  content: string,
  finish_reason?: "stop" | "error" | null,
): string {
  const payload: Record<string, unknown> = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: content ? { role: "assistant", content } : {},
        finish_reason: finish_reason ?? null,
      },
    ],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function makeDone(): string {
  return "data: [DONE]\n\n";
}

function toImgProxyUrl(globalCfg: GlobalSettings, origin: string, path: string): string {
  const baseUrl = (globalCfg.base_url ?? "").trim() || origin;
  return `${baseUrl}/images/${path}`;
}

function buildVideoTag(src: string): string {
  return `<video src="${src}" controls="controls" width="500" height="300"></video>\n`;
}

function buildVideoPosterPreview(videoUrl: string, posterUrl?: string): string {
  const href = String(videoUrl || "").replace(/"/g, "&quot;");
  const poster = String(posterUrl || "").replace(/"/g, "&quot;");
  if (!href) return "";
  if (!poster) return `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>\n`;
  return `<a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;position:relative;max-width:100%;text-decoration:none;">
  <img src="${poster}" alt="video" style="max-width:100%;height:auto;border-radius:12px;display:block;" />
  <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
    <span style="width:64px;height:64px;border-radius:9999px;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;">
      <span style="width:0;height:0;border-top:12px solid transparent;border-bottom:12px solid transparent;border-left:18px solid #fff;margin-left:4px;"></span>
    </span>
  </span>
</a>\n`;
}

function buildVideoHtml(args: { videoUrl: string; posterUrl?: string; posterPreview: boolean }): string {
  if (args.posterPreview) return buildVideoPosterPreview(args.videoUrl, args.posterUrl);
  return buildVideoTag(args.videoUrl);
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeAssetPath(raw: string): string {
  try {
    const u = new URL(raw);
    // Keep full URL (query etc.) to avoid lossy pathname-only encoding (some URLs may encode the real path in query).
    return `u_${base64UrlEncode(u.toString())}`;
  } catch {
    const p = raw.startsWith("/") ? raw : `/${raw}`;
    return `p_${base64UrlEncode(p)}`;
  }
}

function normalizeGeneratedAssetUrls(input: unknown): string[] {
  if (!Array.isArray(input)) return [];

  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s) continue;
    if (s === "/") continue;

    try {
      const u = new URL(s);
      if (u.pathname === "/" && !u.search && !u.hash) continue;
    } catch {
      // ignore (path-style strings are allowed)
    }

    out.push(s);
  }

  return out;
}

export function createOpenAiStreamFromGrokNdjson(
  grokResp: Response,
  opts: {
    cookie: string;
    settings: GrokSettings;
    global: GlobalSettings;
    origin: string;
    onMeta?: (meta: GrokConversationMeta) => Promise<void> | void;
    onFinish?: (result: StreamFinishResult) => Promise<void> | void;
  },
): ReadableStream<Uint8Array> {
  const { settings, global, origin } = opts;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const filteredTags = (settings.filtered_tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const showThinking = settings.show_thinking !== false;
  const showSearch = settings.show_search === true;

  const firstTimeoutMs = Math.max(0, (settings.stream_first_response_timeout ?? 30) * 1000);
  const chunkTimeoutMs = Math.max(0, (settings.stream_chunk_timeout ?? 120) * 1000);
  const totalTimeoutMs = Math.max(0, (settings.stream_total_timeout ?? 600) * 1000);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const body = grokResp.body;
      if (!body) {
        controller.enqueue(encoder.encode(makeChunk(id, created, "grok-4-mini-thinking-tahoe", "Empty response", "error")));
        controller.enqueue(encoder.encode(makeDone()));
        controller.close();
        return;
      }

      const reader = body.getReader();
      const startTime = Date.now();
      let finalStatus = 200;
      let lastChunkTime = startTime;
      let firstReceived = false;

      let currentModel = "grok-4-mini-thinking-tahoe";
      let isImage = false;
      let thinkTagOpen = false;
      let lastIsThinking = false;
      let videoProgressStarted = false;
      let lastVideoProgress = -1;
      let lastToolRolloutId = "";
      const toolUsageParser = new ToolUsageCardStreamParser();
      const passthroughFilteredTags = filteredTags.filter((tag) => tag.toLowerCase() !== "xai:tool_usage_card");
      const shouldEmitToolLines = showThinking && showSearch;
      const meta: GrokConversationMeta = { grokConversationId: "", lastResponseId: "" };

      let buffer = "";

      const emitTextDelta = (args: { text: string; lines: string[]; isThinking: boolean; messageTag?: unknown }) => {
        const pieces: string[] = [];

        if (showThinking) {
          if (args.isThinking && !thinkTagOpen) {
            pieces.push("<think>\n");
            thinkTagOpen = true;
          } else if (!args.isThinking && thinkTagOpen) {
            pieces.push("\n</think>\n");
            thinkTagOpen = false;
          }
        }

        if (!args.isThinking || showThinking) {
          for (const line of args.lines) pieces.push(`${line}\n`);
          if (args.text) {
            const body = args.messageTag === "header" ? `\n\n${args.text}\n\n` : args.text;
            pieces.push(body);
          }
        }

        const payload = pieces.join("");
        if (payload) controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, payload)));
        lastIsThinking = args.isThinking;
      };

      const flushToolBuffer = (isThinkingFrame: boolean) => {
        const flushed = toolUsageParser.flush({
          emitLines: shouldEmitToolLines,
          fallbackRolloutId: lastToolRolloutId,
          emitIncompleteAsText: true,
        });
        if (!flushed.text && !flushed.lines.length) return;
        emitTextDelta({ text: flushed.text, lines: flushed.lines, isThinking: isThinkingFrame });
      };

      const closeThinkWrappers = () => {
        if (showThinking && thinkTagOpen) {
          controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, "\n</think>\n")));
          thinkTagOpen = false;
        }
        if (showThinking && videoProgressStarted) {
          controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, "</think>\n")));
          videoProgressStarted = false;
        }
      };

      const flushStop = () => {
        flushToolBuffer(lastIsThinking);
        closeThinkWrappers();
        controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, "", "stop")));
        controller.enqueue(encoder.encode(makeDone()));
      };

      const updateMeta = async (part: Partial<GrokConversationMeta>) => {
        let changed = false;
        if (part.grokConversationId && part.grokConversationId !== meta.grokConversationId) {
          meta.grokConversationId = part.grokConversationId;
          changed = true;
        }
        if (part.lastResponseId && part.lastResponseId !== meta.lastResponseId) {
          meta.lastResponseId = part.lastResponseId;
          changed = true;
        }
        if (changed && opts.onMeta) await opts.onMeta(meta);
      };

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const now = Date.now();
          const elapsed = now - startTime;
          if (!firstReceived && elapsed > firstTimeoutMs) {
            flushStop();
            if (opts.onFinish) {
              await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000, meta });
            }
            controller.close();
            return;
          }
          if (totalTimeoutMs > 0 && elapsed > totalTimeoutMs) {
            flushStop();
            if (opts.onFinish) {
              await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000, meta });
            }
            controller.close();
            return;
          }
          const idle = now - lastChunkTime;
          if (firstReceived && idle > chunkTimeoutMs) {
            flushStop();
            if (opts.onFinish) {
              await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000, meta });
            }
            controller.close();
            return;
          }

          const perReadTimeout = Math.min(
            firstReceived ? chunkTimeoutMs : firstTimeoutMs,
            totalTimeoutMs > 0 ? Math.max(0, totalTimeoutMs - elapsed) : Number.POSITIVE_INFINITY,
          );

          const res = await readWithTimeout(reader, perReadTimeout);
          if ("timeout" in res) {
            flushStop();
            if (opts.onFinish) {
              await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000, meta });
            }
            controller.close();
            return;
          }

          const { value, done } = res;
          if (done) break;
          if (!value) continue;
          buffer += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;

            let data: GrokNdjson;
            try {
              data = JSON.parse(line) as GrokNdjson;
            } catch {
              continue;
            }
            await updateMeta(extractMetaFromLine(data));

            firstReceived = true;
            lastChunkTime = Date.now();

            const err = (data as any).error;
            if (err?.message) {
              finalStatus = 500;
              flushToolBuffer(lastIsThinking);
              closeThinkWrappers();
              controller.enqueue(
                encoder.encode(makeChunk(id, created, currentModel, `Error: ${String(err.message)}`, "stop")),
              );
              controller.enqueue(encoder.encode(makeDone()));
              if (opts.onFinish) {
                await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000, meta });
              }
              controller.close();
              return;
            }

            const grok = (data as any).result?.response;
            if (!grok) continue;

            const userRespModel = grok.userResponse?.model;
            if (typeof userRespModel === "string" && userRespModel.trim()) currentModel = userRespModel.trim();

            // Video generation stream
            const videoResp = grok.streamingVideoGenerationResponse;
            if (videoResp) {
              const progress = typeof videoResp.progress === "number" ? videoResp.progress : 0;
              const videoUrl = typeof videoResp.videoUrl === "string" ? videoResp.videoUrl : "";
              const thumbUrl = typeof videoResp.thumbnailImageUrl === "string" ? videoResp.thumbnailImageUrl : "";

              if (progress > lastVideoProgress) {
                lastVideoProgress = progress;
                if (showThinking) {
                  let msg = "";
                  if (!videoProgressStarted) {
                    msg = `<think>视频已生成${progress}%\n`;
                    videoProgressStarted = true;
                  } else if (progress < 100) {
                    msg = `视频已生成${progress}%\n`;
                  } else {
                    msg = `视频已生成${progress}%</think>\n`;
                    videoProgressStarted = false;
                  }
                  controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, msg)));
                }
              }

              if (videoUrl) {
                const videoPath = encodeAssetPath(videoUrl);
                const src = toImgProxyUrl(global, origin, videoPath);

                let poster: string | undefined;
                if (thumbUrl) {
                  const thumbPath = encodeAssetPath(thumbUrl);
                  poster = toImgProxyUrl(global, origin, thumbPath);
                }

                controller.enqueue(
                  encoder.encode(
                    makeChunk(
                      id,
                      created,
                      currentModel,
                      buildVideoHtml({
                        videoUrl: src,
                        posterPreview: settings.video_poster_preview === true,
                        ...(poster ? { posterUrl: poster } : {}),
                      }),
                    ),
                  ),
                );
              }
              continue;
            }

            if (grok.imageAttachmentInfo) isImage = true;
            const rawToken = grok.token;

            if (isImage) {
              const modelResp = grok.modelResponse;
              if (modelResp) {
                const urls = normalizeGeneratedAssetUrls(modelResp.generatedImageUrls);
                if (urls.length) {
                  const linesOut: string[] = [];
                  for (const u of urls) {
                    const imgPath = encodeAssetPath(u);
                    const imgUrl = toImgProxyUrl(global, origin, imgPath);
                    linesOut.push(`![Generated Image](${imgUrl})`);
                  }
                  controller.enqueue(
                    encoder.encode(makeChunk(id, created, currentModel, linesOut.join("\n"), "stop")),
                  );
                  closeThinkWrappers();
                  controller.enqueue(encoder.encode(makeDone()));
                  if (opts.onFinish) {
                    await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000, meta });
                  }
                  controller.close();
                  return;
                }
              } else if (typeof rawToken === "string" && rawToken) {
                controller.enqueue(encoder.encode(makeChunk(id, created, currentModel, rawToken)));
              }
              continue;
            }

            // Text chat stream
            const currentIsThinking = Boolean(grok.isThinking);
            const messageTag = grok.messageTag;
            const rolloutId = asStr(grok.rolloutId);
            const toolCardId = asStr(grok.toolUsageCardId);
            if (rolloutId) lastToolRolloutId = rolloutId;
            else if (toolCardId) lastToolRolloutId = toolCardId;

            let token = typeof rawToken === "string" ? rawToken : "";
            if (token && passthroughFilteredTags.some((tag) => token.includes(tag))) token = "";

            const parsed = toolUsageParser.consume(token, {
              emitLines: shouldEmitToolLines,
              fallbackRolloutId: lastToolRolloutId,
            });

            emitTextDelta({
              text: parsed.text,
              lines: parsed.lines,
              isThinking: currentIsThinking,
              messageTag,
            });
          }
        }

        flushStop();
        if (opts.onFinish) {
          await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000, meta });
        }
        controller.close();
      } catch (e) {
        finalStatus = 500;
        flushToolBuffer(lastIsThinking);
        closeThinkWrappers();
        controller.enqueue(
          encoder.encode(
            makeChunk(id, created, currentModel, `处理错误: ${e instanceof Error ? e.message : String(e)}`, "error"),
          ),
        );
        controller.enqueue(encoder.encode(makeDone()));
        if (opts.onFinish) {
          await opts.onFinish({ status: finalStatus, duration: (Date.now() - startTime) / 1000, meta });
        }
        controller.close();
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
    },
  });
}

export async function parseOpenAiFromGrokNdjson(
  grokResp: Response,
  opts: {
    cookie: string;
    settings: GrokSettings;
    global: GlobalSettings;
    origin: string;
    requestedModel: string;
    onMeta?: (meta: GrokConversationMeta) => Promise<void> | void;
  },
): Promise<Record<string, unknown>> {
  const { global, origin, requestedModel, settings } = opts;
  const text = await grokResp.text();
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  let model = requestedModel;
  const showThinking = settings.show_thinking !== false;
  const showSearch = settings.show_search === true;
  const shouldEmitToolLines = showThinking && showSearch;
  const filteredTags = (settings.filtered_tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  let latestMessage = "";
  let latestToolLines: string[] = [];
  let tokenParts: string[] = [];
  let mergedContent: string | null = null;
  let lastToolRolloutId = "";
  const meta: GrokConversationMeta = { grokConversationId: "", lastResponseId: "" };
  for (const line of lines) {
    let data: GrokNdjson;
    try {
      data = JSON.parse(line) as GrokNdjson;
    } catch {
      continue;
    }
    const lineMeta = extractMetaFromLine(data);
    if (lineMeta.grokConversationId) meta.grokConversationId = lineMeta.grokConversationId;
    if (lineMeta.lastResponseId) meta.lastResponseId = lineMeta.lastResponseId;

    const err = (data as any).error;
    if (err?.message) throw new Error(String(err.message));

    const grok = (data as any).result?.response;
    if (!grok) continue;

    const rawToken = typeof grok.token === "string" ? grok.token : "";
    if (rawToken && !filteredTags.some((t) => rawToken.includes(t))) tokenParts.push(rawToken);
    const rolloutId = asStr(grok.rolloutId);
    const toolCardId = asStr(grok.toolUsageCardId);
    if (rolloutId) lastToolRolloutId = rolloutId;
    else if (toolCardId) lastToolRolloutId = toolCardId;

    const videoResp = grok.streamingVideoGenerationResponse;
    if (videoResp?.videoUrl && typeof videoResp.videoUrl === "string") {
      const videoPath = encodeAssetPath(videoResp.videoUrl);
      const src = toImgProxyUrl(global, origin, videoPath);

      let poster: string | undefined;
      if (typeof videoResp.thumbnailImageUrl === "string" && videoResp.thumbnailImageUrl) {
        const thumbPath = encodeAssetPath(videoResp.thumbnailImageUrl);
        poster = toImgProxyUrl(global, origin, thumbPath);
      }

      mergedContent = buildVideoHtml({
        videoUrl: src,
        posterPreview: settings.video_poster_preview === true,
        ...(poster ? { posterUrl: poster } : {}),
      });
      model = requestedModel;
      continue;
    }

    const modelResp = grok.modelResponse;
    if (!modelResp) continue;
    if (typeof modelResp.error === "string" && modelResp.error) throw new Error(modelResp.error);

    if (typeof modelResp.model === "string" && modelResp.model) model = modelResp.model;
    if (typeof modelResp.message === "string") {
      const parsed = replaceToolUsageCardsInText(modelResp.message, {
        emitLines: shouldEmitToolLines,
        fallbackRolloutId: lastToolRolloutId,
      });
      if (modelResp.message.length > 0 || parsed.lines.length > 0) {
        latestMessage = parsed.text;
        latestToolLines = parsed.lines;
      }
    }

    const rawUrls = modelResp.generatedImageUrls;
    const urls = normalizeGeneratedAssetUrls(rawUrls);
    if (urls.length) {
      const imageLines: string[] = [];
      for (const u of urls) {
        const imgPath = encodeAssetPath(u);
        const imgUrl = toImgProxyUrl(global, origin, imgPath);
        imageLines.push(`![Generated Image](${imgUrl})`);
      }
      const prefix = latestMessage ? `${latestMessage}\n` : "";
      mergedContent = `${prefix}${imageLines.join("\n")}`;
      continue;
    }

    // If upstream emits placeholder/empty generatedImageUrls in intermediate frames, keep scanning.
    if (Array.isArray(rawUrls)) continue;
  }

  let content = mergedContent ?? latestMessage;
  if (!content && tokenParts.length) content = tokenParts.join("");
  if (latestToolLines.length) {
    const toolBlock = latestToolLines.join("\n");
    content = content ? `<think>\n${toolBlock}\n</think>\n${content}` : `<think>\n${toolBlock}\n</think>`;
  }
  if (opts.onMeta) await opts.onMeta(meta);

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: null,
  };
}
