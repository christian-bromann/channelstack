import type { SseFrame } from "../../../core/stream/index.ts";
import { audioSeconds, base64Of, type Media } from "../media.ts";
import type { ModelRequest } from "../request.ts";
import { type Answer, textChunks } from "./answer.ts";

/** What a media answer repeats of its request, and where its images can be downloaded. */
export interface MediaMeta {
  /** Seconds since the epoch. */
  readonly created: number;
  /** Where an image answered as a URL is served, by its name. */
  imageUrl(media: Media): string;
}

/** The Images API's answer: each image as base64 or a URL, as `response_format` asks, and its usage for the GPT image models. */
export function imagesResponse(answer: Answer, request: ModelRequest, meta: MediaMeta): Record<string, unknown> {
  const media = request.media;
  const images = answer.media?.images ?? [];
  const gptImage = !/^dall-e/.test(request.model);
  return {
    created: meta.created,
    data: images.map((image) =>
      media?.responseFormat === "url"
        ? { url: meta.imageUrl(image) }
        : { b64_json: base64Of(image.bytes), ...(answer.text === "" ? {} : { revised_prompt: answer.text }) },
    ),
    ...(gptImage
      ? {
          background: media?.background === "transparent" ? "transparent" : "opaque",
          output_format: media?.outputFormat ?? "png",
          size: media?.size !== undefined && media.size !== "auto" ? media.size : "1024x1024",
          quality: media?.quality !== undefined && media.quality !== "auto" ? media.quality : "medium",
          usage: {
            input_tokens: answer.usage.input,
            input_tokens_details: { text_tokens: answer.usage.input, image_tokens: 0 },
            output_tokens: answer.usage.output,
            total_tokens: answer.usage.input + answer.usage.output,
          },
        }
      : {}),
  };
}

/** Speech as a stream of `speech.audio.delta` events (`stream_format: "sse"`), then `speech.audio.done` with its usage. */
export function speechFrames(answer: Answer): SseFrame[] {
  const audio = answer.media?.audio;
  const data = base64Of(audio?.bytes ?? new Uint8Array());
  const pieces = data.match(/[\s\S]{1,8192}/g) ?? [];
  return [
    ...pieces.map((piece) => ({ data: JSON.stringify({ type: "speech.audio.delta", audio: piece }), content: true })),
    {
      data: JSON.stringify({
        type: "speech.audio.done",
        usage: {
          input_tokens: answer.usage.input,
          output_tokens: answer.usage.output,
          total_tokens: answer.usage.input + answer.usage.output,
        },
      }),
    },
  ];
}

/** The transcript in segments of a sentence, spread evenly over how long the audio plays. */
function segmentsOf(text: string, seconds: number) {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g)?.map((sentence) => sentence.trim()) ?? [];
  const parts = sentences.filter((sentence) => sentence !== "");
  const each = parts.length === 0 ? seconds : seconds / parts.length;
  return parts.map((part, id) => ({ id, start: id * each, end: (id + 1) * each, text: part }));
}

const clock = (seconds: number, separator: "," | ".") => {
  const ms = Math.round(seconds * 1000);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
};

/** How long the audio plays: from its header when it has one, a second otherwise. */
const durationOf = (file: Media | undefined) =>
  Math.round(((file === undefined ? undefined : audioSeconds(file)) ?? 1) * 100) / 100;

/**
 * A transcription's or translation's answer in the format the request asks for: JSON, text,
 * SRT, VTT, verbose JSON (segments, the duration) or diarized JSON. Text formats are plain text.
 */
export function transcriptBody(
  answer: Answer,
  request: ModelRequest,
  file: Media | undefined,
): { json: Record<string, unknown> } | { text: string } {
  const format = request.media?.responseFormat ?? "json";
  const seconds = durationOf(file);
  const segments = segmentsOf(answer.text, seconds);
  const whisper = request.model === "whisper-1";
  const usage = whisper
    ? { type: "duration", seconds: Math.ceil(seconds) }
    : {
        type: "tokens",
        input_tokens: answer.usage.input,
        input_token_details: { text_tokens: 0, audio_tokens: answer.usage.input },
        output_tokens: answer.usage.output,
        total_tokens: answer.usage.input + answer.usage.output,
      };
  switch (format) {
    case "text":
      return { text: `${answer.text}\n` };
    case "srt":
      return {
        text: segments
          .map(
            (segment) =>
              `${segment.id + 1}\n${clock(segment.start, ",")} --> ${clock(segment.end, ",")}\n${segment.text}\n`,
          )
          .join("\n"),
      };
    case "vtt":
      return {
        text: `WEBVTT\n\n${segments.map((segment) => `${clock(segment.start, ".")} --> ${clock(segment.end, ".")}\n${segment.text}\n`).join("\n")}`,
      };
    case "verbose_json":
      return {
        json: {
          task: request.endpoint === "audio.translations" ? "translate" : "transcribe",
          language: request.endpoint === "audio.translations" ? "english" : (request.media?.language ?? "english"),
          duration: seconds,
          text: answer.text,
          segments: segments.map((segment) => ({
            ...segment,
            seek: 0,
            tokens: [],
            temperature: 0,
            avg_logprob: -0.2,
            compression_ratio: 1.2,
            no_speech_prob: 0.01,
          })),
          ...(request.endpoint === "audio.transcriptions"
            ? { usage: { type: "duration", seconds: Math.ceil(seconds) } }
            : {}),
        },
      };
    case "diarized_json":
      return {
        json: {
          task: "transcribe",
          duration: seconds,
          text: answer.text,
          segments: segments.map((segment) => ({
            type: "transcript.text.segment",
            id: `seg_${segment.id}`,
            start: segment.start,
            end: segment.end,
            text: segment.text,
            speaker: "A",
          })),
          usage,
        },
      };
    default:
      return { json: { text: answer.text, ...(request.endpoint === "audio.transcriptions" ? { usage } : {}) } };
  }
}

/** A streamed transcription: the text in `transcript.text.delta` events, then `transcript.text.done` with its usage. */
export function transcriptFrames(answer: Answer): SseFrame[] {
  const chunks = answer.chunks.length > 0 ? answer.chunks : textChunks(answer.text);
  return [
    ...chunks.map((delta) => ({ data: JSON.stringify({ type: "transcript.text.delta", delta }), content: true })),
    {
      data: JSON.stringify({
        type: "transcript.text.done",
        text: answer.text,
        usage: {
          type: "tokens",
          input_tokens: answer.usage.input,
          input_token_details: { text_tokens: 0, audio_tokens: answer.usage.input },
          output_tokens: answer.usage.output,
          total_tokens: answer.usage.input + answer.usage.output,
        },
      }),
    },
  ];
}
