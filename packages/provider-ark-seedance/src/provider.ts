import { canonicalize, defineEndpointPackage, wakeAfter } from "@hypit/hypit/endpoint-kit";
import type { AsyncEndpoint, EndpointRequest } from "@hypit/hypit/endpoint-kit";
import { compileWireRequest, generationTypes, sealGeneratedVideoSet } from "@hypit/hypit/generation";
import type { GenerationRequest, GenerationWireMapping } from "@hypit/hypit/generation";

export const providerModule = { name: "@volcengine/provider-ark-seedance", version: "1" } as const;

/** Ark model id per Hypit capability name. Kept in one place so the Profile only names a variant. */
export const arkModelByCapability = {
  "seedance-2": "doubao-seedance-2-0-260128",
  "seedance-2-fast": "doubao-seedance-2-0-fast-260128",
  "seedance-2-mini": "doubao-seedance-2-0-mini-260615",
  "seedance-2.5": "doubao-seedance-2-5-260628",
} as const;

export type ArkCapabilityName = keyof typeof arkModelByCapability;

/** Resolutions each Ark Seedance variant actually accepts (observed on the live API). */
const resolutionsByCapability: Readonly<Record<ArkCapabilityName, readonly string[]>> = {
  "seedance-2": ["480p", "720p", "1080p", "4k"],
  "seedance-2-fast": ["480p", "720p"],
  "seedance-2-mini": ["480p", "720p"],
  "seedance-2.5": ["480p", "720p", "1080p"],
};

/** 火山官方按「元/百万 completion token」计费（2026-07-26 价目快照）。2.5 尚未取到官方价。 */
const arkRates: Readonly<Record<ArkCapabilityName, Readonly<Record<string, number>>>> = {
  "seedance-2": { "480p": 46.0, "720p": 46.0, "1080p": 51.0, "4k": 26.0 },
  "seedance-2-fast": { "480p": 37.0, "720p": 37.0 },
  "seedance-2-mini": { "480p": 23.0, "720p": 23.0 },
  "seedance-2.5": {},
};

function capabilityMapping(capabilityName: ArkCapabilityName): GenerationWireMapping {
  return {
    capability: { module: { name: "@hypit/seedance", version: "1" }, name: capabilityName },
    result: "video",
    routes: [{ model: arkModelByCapability[capabilityName] }],
    fields: {
      prompt: { as: "value", field: "prompt" },
      referenceImage: { as: "urlArray", field: "referenceImages", resourceFields: ["personReference"] },
      referenceVideo: { as: "urlArray", field: "referenceVideos", resourceFields: ["personReference"] },
      referenceAudio: { as: "urlArray", field: "referenceAudios" },
      firstFrame: { as: "url", field: "firstFrame", resourceFields: ["personReference"] },
      lastFrame: { as: "url", field: "lastFrame", resourceFields: ["personReference"] },
      resolution: { as: "value", field: "resolution" },
      aspectRatio: { as: "value", field: "ratio" },
      duration: { as: "value", field: "duration" },
      generateAudio: { as: "value", field: "generateAudio" },
      // Accepted so the port resolves; the Endpoint still refuses webSearch=true (no verified Ark mapping).
      webSearch: { as: "value", field: "webSearch" },
    },
  };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected service object");
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Expected nonempty ${label}`);
  return value;
}
function address(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("Ark baseUrl requires HTTPS");
  }
  return url.href.replace(/\/$/u, "");
}

/** Ark accepts inline media as data URLs; the subtype must be lower case. */
function dataUrl(bytes: Uint8Array, mediaType: string): string {
  const [family, subtype = "octet-stream"] = mediaType.split("/");
  return `data:${family}/${subtype.toLowerCase()};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function createArkSeedanceProvider(options: {
  instance: string;
  pool: string;
  baseUrl: string;
  arkModel: string;
  capabilityName: ArkCapabilityName;
  watermark?: boolean;
  concurrency?: number;
  pollIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
}) {
  const base = address(options.baseUrl);
  const fetcher = options.fetch ?? globalThis.fetch;
  const interval = options.pollIntervalMs ?? 5_000;
  const mapping = capabilityMapping(options.capabilityName);
  const allowedResolutions = resolutionsByCapability[options.capabilityName];

  function support(request: EndpointRequest) {
    const ports = (request.constraints as unknown as GenerationRequest).ports;
    const unknownPort = Object.keys(ports).find((port) => !(port in mapping.fields));
    if (unknownPort !== undefined) {
      return { status: "unsupported" as const, reason: `Ark Seedance has no wire mapping for the ${unknownPort} port` };
    }
    if (ports.webSearch?.[0] === true) {
      return { status: "unsupported" as const, reason: "This Endpoint does not implement Seedance Web Search" };
    }
    const resolution = ports.resolution?.[0];
    if (typeof resolution === "string" && !allowedResolutions.includes(resolution)) {
      return {
        status: "unsupported" as const,
        reason: `doubao ${options.arkModel} accepts ${allowedResolutions.join(", ")}, not ${resolution}`,
      };
    }
    const duration = ports.duration?.[0];
    if (typeof duration === "number" && duration !== -1 && (duration < 4 || duration > 15)) {
      return { status: "unsupported" as const, reason: "Ark Seedance duration must be -1 or between 4 and 15 seconds" };
    }
    return { status: "supported" as const };
  }

  async function json(path: string, secret: string, init: RequestInit = {}) {
    const response = await fetcher(`${base}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(60_000),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = body === undefined ? undefined : object(body).error;
      const message = error === undefined ? undefined : object(error).message;
      throw new Error(`Ark ${path} returned HTTP ${response.status}${typeof message === "string" ? `: ${message}` : ""}`);
    }
    return object(body);
  }

  const endpoint: AsyncEndpoint = {
    async start(context) {
      const supported = support(context.need);
      if (supported.status === "unsupported") throw new Error(supported.reason);
      const secret = text(context.credentials.apiKey?.secret, "Ark API key");
      const wire = await compileWireRequest(
        mapping,
        context.need.constraints as unknown as GenerationRequest,
        async (artifact) => {
          const bytes = await context.resources.get(artifact.resource);
          if (bytes === undefined) throw new Error("Reference media is unavailable");
          return dataUrl(bytes, artifact.mediaType);
        },
      );
      const input = object(wire.input);
      const content: Record<string, unknown>[] = [
        { type: "text", text: text(input.prompt, "Ark prompt") },
      ];
      const media = (item: unknown, type: "image_url" | "video_url" | "audio_url", role: string) => {
        const key = type === "audio_url" ? "audio_url" : type === "video_url" ? "video_url" : "image_url";
        content.push({ type, [key]: { url: text(item, `Ark ${role} url`) }, role });
      };
      if (typeof input.firstFrame === "string") media(input.firstFrame, "image_url", "first_frame");
      if (typeof input.lastFrame === "string") media(input.lastFrame, "image_url", "last_frame");
      for (const url of (input.referenceImages as unknown[] | undefined) ?? []) media(url, "image_url", "reference_image");
      for (const url of (input.referenceVideos as unknown[] | undefined) ?? []) media(url, "video_url", "reference_video");
      for (const url of (input.referenceAudios as unknown[] | undefined) ?? []) media(url, "audio_url", "reference_audio");

      const body = {
        model: options.arkModel,
        content,
        resolution: input.resolution,
        ratio: input.ratio,
        duration: input.duration,
        generate_audio: input.generateAudio ?? false,
        watermark: options.watermark ?? false,
      };
      const task = await json("/contents/generations/tasks", secret, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const id = text(task.id, "Ark task id");
      const handle = { id };
      const receipt = { id };
      await context.checkpoint?.({ handle, receipt });
      return { ...wakeAfter(handle, interval), receipt };
    },
    async poll(context) {
      const id = text(object(context.handle).id, "Ark task id");
      const task = await json(`/contents/generations/tasks/${encodeURIComponent(id)}`, text(context.credentials.apiKey?.secret, "Ark API key"));
      if (task.status === "queued" || task.status === "running") {
        return wakeAfter({ id }, interval, Date.now(), { phase: String(task.status) });
      }
      if (task.status === "failed") {
        const failure = object(task.error ?? {});
        return {
          status: "failed",
          failure: {
            code: typeof failure.code === "string" ? failure.code : "ARK_TASK_FAILED",
            message: typeof failure.message === "string" ? failure.message : "Ark video task failed",
          },
        };
      }
      if (task.status !== "succeeded") throw new Error(`Ark returned unknown task status ${String(task.status)}`);
      const content = object(task.content);
      return { status: "ready", handle: { id, url: text(content.video_url, "Ark video url") } };
    },
    async collect(context) {
      // The returned media URL is signed by Ark; account credentials stay on its API.
      const url = text(object(context.handle).url, "Ark video url");
      const response = await fetcher(url, { signal: AbortSignal.timeout(600_000) });
      if (!response.ok) throw new Error(`Ark video download returned HTTP ${response.status}`);
      const artifact = await context.resources.put(new Uint8Array(await response.arrayBuffer()), "video/mp4");
      return {
        status: "completed",
        result: { value: { kind: "inline", value: canonicalize(sealGeneratedVideoSet({ videos: [artifact] })) } },
      };
    },
  };

  return defineEndpointPackage({
    module: providerModule,
    facet: "ark-seedance",
    instance: options.instance,
    pool: options.pool,
    credentials: { apiKey: { store: "os", key: options.instance } },
    credentialInputs: { apiKey: { label: "火山方舟 Ark API Key" } },
    defaultConcurrency: options.concurrency ?? 2,
    actionLimits: { submit: { concurrency: 1 }, poll: { concurrency: 4 }, collect: { concurrency: 1 } },
    pricing: { kind: "page", url: "https://www.volcengine.com/docs/82379/1544106" },
    async readPricing() {
      // 官方按"元/百万 completion token"计费；实测 720p/5s ≈ 108,900 token。
      return [{
        source: "https://www.volcengine.com/docs/82379/1544106",
        data: canonicalize({
          unit: "CNY per million completion tokens",
          asOf: "2026-07-26",
          variant: options.capabilityName,
          arkModel: options.arkModel,
          rates: arkRates[options.capabilityName],
          observedTokens: { "480p/5s": 50_638, "720p/5s": 108_900 },
        }),
        summary: "火山方舟 Seedance 按 completion token 计费；以上为官方价目快照，实际以控制台账单为准",
      }];
    },
    capabilities: [{
      capability: mapping.capability,
      returns: generationTypes.videoSet,
      lifecycle: "asynchronous",
      supports: support,
      endpoint,
    }],
  });
}
