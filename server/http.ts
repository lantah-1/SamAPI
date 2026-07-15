import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { DEFAULT_CORS_HEADERS, WEB_DIR } from "./config.js";

export function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown, headers: http.OutgoingHttpHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS,HEAD",
    "Access-Control-Allow-Headers": DEFAULT_CORS_HEADERS,
    "Access-Control-Expose-Headers": "*",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

export function sendCorsPreflight(request: http.IncomingMessage, response: http.ServerResponse) {
  const requestedHeaders = valueToHeaderText(request.headers["access-control-request-headers"]);
  response.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS,HEAD",
    "Access-Control-Allow-Headers": requestedHeaders || DEFAULT_CORS_HEADERS,
    "Access-Control-Max-Age": "86400",
    Vary: "Access-Control-Request-Headers"
  });
  response.end();
}

export async function readJson(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export function routeParam(parts: string[], index: number) {
  return decodeURIComponent(parts[index] || "");
}

export function notFound(response: http.ServerResponse) {
  sendJson(response, 404, { error: "Not found" });
}

function staticContentType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

function safeStaticPath(pathname: string) {
  let decoded = "/";
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(WEB_DIR, relativePath);
  const root = WEB_DIR.endsWith(path.sep) ? WEB_DIR : `${WEB_DIR}${path.sep}`;
  if (resolved !== WEB_DIR && !resolved.startsWith(root)) return undefined;
  return resolved;
}

function sendStaticFile(request: http.IncomingMessage, response: http.ServerResponse, filePath: string) {
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;
  response.writeHead(200, {
    "Content-Type": staticContentType(filePath),
    "Content-Length": stats.size,
    "Cache-Control": path.basename(filePath) === "index.html" ? "no-store" : "public, max-age=31536000, immutable"
  });
  if (request.method === "HEAD") {
    response.end();
    return true;
  }
  createReadStream(filePath).pipe(response);
  return true;
}

export function handleStatic(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
  if (!["GET", "HEAD"].includes(request.method || "")) return false;
  if (!existsSync(WEB_DIR)) return false;
  const filePath = safeStaticPath(url.pathname);
  if (filePath && sendStaticFile(request, response, filePath)) return true;
  const indexPath = path.join(WEB_DIR, "index.html");
  return sendStaticFile(request, response, indexPath);
}

export function valueToHeaderText(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.join(", ");
  return value || "";
}
