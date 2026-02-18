import type { GrokSettings } from "../settings";
import { getDynamicHeaders } from "./headers";
import { encodeGrpcWebFrame, parseGrpcWebFetchResponse } from "./grpcWeb";

const ACCEPT_TOS_URL = "https://accounts.x.ai/auth_mgmt.AuthManagement/SetTosAcceptedVersion";
const SET_BIRTH_DATE_URL = "https://grok.com/rest/auth/set-birth-date";
const UPDATE_FEATURE_CONTROLS_URL = "https://grok.com/auth_mgmt.AuthManagement/UpdateUserFeatureControls";

const PATH_ACCEPT_TOS = "/auth_mgmt.AuthManagement/SetTosAcceptedVersion";
const PATH_SET_BIRTH = "/rest/auth/set-birth-date";
const PATH_UPDATE_FEATURE_CONTROLS = "/auth_mgmt.AuthManagement/UpdateUserFeatureControls";

const NSFW_FEATURE_NAME = "always_show_nsfw_content";

export type AccountSettingsStep = "accept-tos" | "set-birth" | "nsfw";

export interface AccountSettingsStepResult {
  step: AccountSettingsStep;
  ok: boolean;
  status?: number;
  grpc_status?: number;
  error?: string;
}

export interface AccountSettingsFlowResult {
  ok: boolean;
  steps: AccountSettingsStepResult[];
}

export interface AccountSettingsArgs {
  cookie: string;
  settings: GrokSettings;
}

export interface SetBirthDateArgs extends AccountSettingsArgs {
  birthDate?: string;
}

export interface AccountSettingsFlowArgs extends AccountSettingsArgs {
  birthDate?: string;
}

function stepResult(input: {
  step: AccountSettingsStep;
  ok: boolean;
  status?: number;
  grpcStatus?: number | null;
  error?: string;
}): AccountSettingsStepResult {
  return {
    step: input.step,
    ok: input.ok,
    ...(typeof input.status === "number" ? { status: input.status } : {}),
    ...(typeof input.grpcStatus === "number" ? { grpc_status: input.grpcStatus } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function trimText(text: string, max = 200): string {
  const cleaned = text.trim();
  if (!cleaned) return "";
  return cleaned.slice(0, max);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomBirthDateIso(): string {
  const now = new Date();
  const year = now.getUTCFullYear() - randomInt(20, 48);
  const month = randomInt(1, 12);
  const day = randomInt(1, 28);
  const hour = randomInt(0, 23);
  const minute = randomInt(0, 59);
  const second = randomInt(0, 59);
  const ms = randomInt(0, 999);
  const birthDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  return birthDate.toISOString();
}

function buildGrpcHeaders(
  settings: GrokSettings,
  pathname: string,
  cookie: string,
  origin: string,
  referer: string,
): Record<string, string> {
  const headers = getDynamicHeaders(settings, pathname);
  headers.Cookie = cookie;
  headers.Origin = origin;
  headers.Referer = referer;
  headers["Content-Type"] = "application/grpc-web+proto";
  headers["x-grpc-web"] = "1";
  headers["x-user-agent"] = "connect-es/2.1.1";
  headers["Cache-Control"] = "no-cache";
  headers.Pragma = "no-cache";
  headers.Accept = "*/*";
  headers["Sec-Fetch-Dest"] = "empty";
  headers["Sec-Fetch-Site"] = "same-site";
  return headers;
}

function buildNsfwPayload(): Uint8Array {
  const name = new TextEncoder().encode(NSFW_FEATURE_NAME);
  const inner = new Uint8Array(2 + name.length);
  inner[0] = 0x0a;
  inner[1] = name.length;
  inner.set(name, 2);

  const payload = new Uint8Array(6 + inner.length);
  payload.set([0x0a, 0x02, 0x10, 0x01, 0x12, inner.length], 0);
  payload.set(inner, 6);
  return payload;
}

function grpcErrorText(status: number, grpcStatus: number | null, grpcMessage: string): string {
  if (typeof grpcStatus === "number" && grpcStatus !== 0) {
    return grpcMessage ? `gRPC ${grpcStatus}: ${grpcMessage}` : `gRPC ${grpcStatus}`;
  }
  return `HTTP ${status}`;
}

async function callGrpcStep(args: {
  step: AccountSettingsStep;
  url: string;
  pathname: string;
  cookie: string;
  settings: GrokSettings;
  origin: string;
  referer: string;
  payload: Uint8Array;
}): Promise<AccountSettingsStepResult> {
  try {
    const headers = buildGrpcHeaders(
      args.settings,
      args.pathname,
      args.cookie,
      args.origin,
      args.referer,
    );
    const response = await fetch(args.url, {
      method: "POST",
      headers,
      body: toArrayBuffer(encodeGrpcWebFrame(args.payload)),
    });

    const parsed = await parseGrpcWebFetchResponse(response);
    const grpcStatus = parsed.grpc_status;
    const ok = response.ok && (grpcStatus === null || grpcStatus === 0);
    if (!ok) {
      return stepResult({
        step: args.step,
        ok: false,
        status: response.status,
        grpcStatus,
        error: grpcErrorText(response.status, grpcStatus, parsed.grpc_message),
      });
    }
    return stepResult({
      step: args.step,
      ok: true,
      status: response.status,
      grpcStatus,
    });
  } catch (err) {
    return stepResult({ step: args.step, ok: false, error: errText(err) });
  }
}

export async function setTosAcceptedVersion(args: AccountSettingsArgs): Promise<AccountSettingsStepResult> {
  return callGrpcStep({
    step: "accept-tos",
    url: ACCEPT_TOS_URL,
    pathname: PATH_ACCEPT_TOS,
    cookie: args.cookie,
    settings: args.settings,
    origin: "https://accounts.x.ai",
    referer: "https://accounts.x.ai/accept-tos",
    payload: new Uint8Array([0x10, 0x01]),
  });
}

export async function setBirthDate(args: SetBirthDateArgs): Promise<AccountSettingsStepResult> {
  try {
    const headers = getDynamicHeaders(args.settings, PATH_SET_BIRTH);
    headers.Cookie = args.cookie;
    headers.Origin = "https://grok.com";
    headers.Referer = "https://grok.com/?_s=home";
    headers["Content-Type"] = "application/json";
    headers.Accept = "*/*";
    headers["Sec-Fetch-Dest"] = "empty";
    headers["Sec-Fetch-Site"] = "same-origin";

    const birthDate = (args.birthDate ?? "").trim() || randomBirthDateIso();
    const response = await fetch(SET_BIRTH_DATE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ birthDate }),
    });

    if (response.status !== 200 && response.status !== 204) {
      const bodyText = trimText(await response.text().catch(() => ""));
      const error = bodyText ? `HTTP ${response.status}: ${bodyText}` : `HTTP ${response.status}`;
      return stepResult({ step: "set-birth", ok: false, status: response.status, error });
    }
    return stepResult({ step: "set-birth", ok: true, status: response.status });
  } catch (err) {
    return stepResult({ step: "set-birth", ok: false, error: errText(err) });
  }
}

export async function updateUserFeatureControls(
  args: AccountSettingsArgs,
): Promise<AccountSettingsStepResult> {
  return callGrpcStep({
    step: "nsfw",
    url: UPDATE_FEATURE_CONTROLS_URL,
    pathname: PATH_UPDATE_FEATURE_CONTROLS,
    cookie: args.cookie,
    settings: args.settings,
    origin: "https://grok.com",
    referer: "https://grok.com/?_s=data",
    payload: buildNsfwPayload(),
  });
}

export async function runAccountSettingsFlow(
  args: AccountSettingsFlowArgs,
): Promise<AccountSettingsFlowResult> {
  const steps: AccountSettingsStepResult[] = [];

  const tos = await setTosAcceptedVersion({ cookie: args.cookie, settings: args.settings });
  steps.push(tos);
  if (!tos.ok) return { ok: false, steps };

  const birthArgs: SetBirthDateArgs = { cookie: args.cookie, settings: args.settings };
  if (typeof args.birthDate === "string") birthArgs.birthDate = args.birthDate;
  const birth = await setBirthDate(birthArgs);
  steps.push(birth);
  if (!birth.ok) return { ok: false, steps };

  const nsfw = await updateUserFeatureControls({ cookie: args.cookie, settings: args.settings });
  steps.push(nsfw);
  return { ok: nsfw.ok, steps };
}
