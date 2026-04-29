const TARGET_BASE = (Netlify.env.get("TARGET_DOMAIN") || "").replace(/\/$/, "");
const TIMEOUT_MS = 30000; // 30 seconds timeout
const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5MB limit

const STRIP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "content-length", // Let fetch handle this
]);

export default async function handler(request) {
  // Early validation
  if (!TARGET_BASE) {
    console.error("Relay: TARGET_DOMAIN not configured");
    return new Response(
      JSON.stringify({ error: "Relay configuration missing" }),
      { 
        status: 500,
        headers: { "content-type": "application/json" }
      }
    );
  }

  // Health check endpoint (bypass relay)
  const url = new URL(request.url);
  if (url.pathname === "/health" || url.pathname === "/_health") {
    return new Response("OK", { 
      status: 200,
      headers: { "content-type": "text/plain" }
    });
  }

  // Validate body size
  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength) > MAX_BODY_SIZE) {
    return new Response(
      JSON.stringify({ error: "Request body too large" }),
      { 
        status: 413,
        headers: { "content-type": "application/json" }
      }
    );
  }

  try {
    const targetUrl = TARGET_BASE + url.pathname + url.search;
    
    // Build filtered headers
    const headers = buildHeaders(request);
    
    // Add client IP for upstream
    const clientIp = getClientIP(request);
    if (clientIp) {
      headers.set("x-forwarded-for", clientIp);
      headers.set("x-real-ip", clientIp);
    }
    
    // Add request ID for tracing
    const requestId = crypto.randomUUID();
    headers.set("x-request-id", requestId);

    // Setup timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const method = request.method;
    const hasBody = method !== "GET" && method !== "HEAD";

    const fetchOptions = {
      method,
      headers,
      redirect: "manual",
      signal: controller.signal,
    };

    if (hasBody) {
      fetchOptions.body = request.body; // Stream directly
    }

    const upstream = await fetch(targetUrl, fetchOptions);
    clearTimeout(timeoutId);

    // Build response headers
    const responseHeaders = buildResponseHeaders(upstream);

    // Add debug headers in development
    if (Netlify.env.get("CONTEXT") !== "production") {
      responseHeaders.set("x-relay-target", TARGET_BASE);
      responseHeaders.set("x-relay-request-id", requestId);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error(`Relay error: ${error.name} - ${error.message}`);
    
    // Handle specific error types
    if (error.name === "AbortError") {
      return new Response(
        JSON.stringify({ error: "Upstream timeout" }),
        { 
          status: 504,
          headers: { "content-type": "application/json" }
        }
      );
    }
    
    if (error.name === "TypeError" && error.message.includes("fetch")) {
      return new Response(
        JSON.stringify({ error: "Upstream connection failed" }),
        { 
          status: 502,
          headers: { "content-type": "application/json" }
        }
      );
    }

    return new Response(
      JSON.stringify({ error: "Internal relay error" }),
      { 
        status: 502,
        headers: { "content-type": "application/json" }
      }
    );
  }
}

// Helper: Build filtered request headers
function buildHeaders(request) {
  const headers = new Headers();
  
  for (const [key, value] of request.headers) {
    const lowerKey = key.toLowerCase();
    
    if (STRIP_HEADERS.has(lowerKey)) continue;
    if (lowerKey.startsWith("x-nf-")) continue;
    if (lowerKey.startsWith("x-netlify-")) continue;
    if (!value || value.trim() === "") continue;
    
    headers.set(key, value);
  }
  
  return headers;
}

// Helper: Extract client IP from various headers
function getClientIP(request) {
  return (request.headers.get("cf-connecting-ip") ||
          request.headers.get("x-nf-client-connection-ip") ||
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          request.headers.get("x-real-ip") ||
          null);
}

// Helper: Build response headers (remove hop-by-hop)
function buildResponseHeaders(upstream) {
  const headers = new Headers();
  
  for (const [key, value] of upstream.headers) {
    const lowerKey = key.toLowerCase();
    
    if (lowerKey === "transfer-encoding") continue;
    if (lowerKey === "connection") continue;
    if (lowerKey === "keep-alive") continue;
    
    headers.set(key, value);
  }
  
  // Security headers
  headers.set("x-content-type-options", "nosniff");
  
  return headers;
}
