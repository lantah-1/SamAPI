import { URL } from "node:url";
import { joinUrl, v1BaseUrl } from "./text.js";

export function proxyEndpointCandidates(baseUrl: string, endpoint: string) {
  return [joinUrl(v1BaseUrl(baseUrl), endpoint)];
}

export function modelEndpointCandidates(baseUrl: string) {
  return [joinUrl(v1BaseUrl(baseUrl), "models")];
}

export function newApiPricingEndpointCandidates(baseUrl: string) {
  const candidates: string[] = [];
  try {
    const parsed = new URL(baseUrl);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (/\/v\d+$/i.test(pathname)) {
      parsed.pathname = pathname.replace(/\/v\d+$/i, "");
      candidates.push(joinUrl(parsed.toString(), "api/pricing"));
    }
  } catch {
    // Base URLs are validated before storage; keep the regular candidate if this ever fails.
  }
  candidates.push(joinUrl(baseUrl, "api/pricing"));
  return Array.from(new Set(candidates));
}
