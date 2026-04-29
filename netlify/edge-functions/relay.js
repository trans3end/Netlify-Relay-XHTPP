// Performance optimizations: Pre-compute constants at module load time
const TARGET_BASE = (Netlify.env.get("TARGET_DOMAIN") || "").replace(/\/$/, "");
const IS_PROD = Netlify.env.get("CONTEXT") === "production";

// Optimized header filtering using Set + RegExp patterns
const STRIP_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate", 
  "proxy-authorization", "te", "trailer", "transfer-encoding", 
  "upgrade", "forwarded", "x-forwarded-host", "x-forwarded-proto", 
  "x-forwarded-port", "content-length", // Edge manages this internally
]);

// Pre-compiled regex for Netlify headers
const NETLIFY_HEADER_PATTERN = /^x-nf-|^x-netlify-/i;

// Allowed methods that can have a body
const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Timeout configuration (Netlify Edge Functions have 50ms CPU time limit)
const UPSTREAM_TIMEOUT = 45000; // 45 seconds
const MAX_PAYLOAD_SIZE = 6 * 1024 * 1024; // 6MB (Netlify limit)

export default async function handler(request, context) {
  // Early validation with helpful error message
  if (!TARGET_BASE) {
    console.error("Relay: TARGET_DOMAIN environment variable not set");
    return new Response(
      JSON.stringify({ error: "Relay configuration missing" }), 
      { 
        status: 500, 
        headers: { "content-type": "application/json" }
      }
    );
  }

  // Performance: Validate request size before processing
  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength) > MAX_PAYLOAD_SIZE) {
    return new Response(
      JSON.stringify({ error: "Payload too large" }), 
      { 
        status: 413, 
        headers: { "content-type": "application/json" }
      }
    );
  }

  try {
    const url = new URL(request.url);
    const targetUrl = TARGET_BASE + url.pathname + url.search;

    // Build filtered headers efficiently
    const headers = buildFilteredHeaders(request);
    
    // Add client IP for upstream logging (works behind Netlify CDN)
    const clientIp = getClientIp(request, context);
    if (clientIp) {
      headers.set("x-forwarded-for", clientIp);
      headers.set("x-real-ip", clientIp);
    }

    // Add request ID for tracing
    const requestId = crypto.randomUUID();
    headers.set("x-request-id", requestId);

    // Prepare fetch with timeout and size limits
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);

    const fetchOptions = {
      method: request.method,
      headers,
      redirect: "manual",
      signal: controller.signal,
    };

    // Handle body efficiently - stream when possible
    if (METHODS_WITH_BODY.has(request.method)) {
      fetchOptions.body = request.body; // Stream directly, no memory copy
    }

    const upstreamResponse = await fetch(targetUrl, fetchOptions);
    clearTimeout(timeoutId);

    // Build response headers (remove hop-by-hop headers)
    const responseHeaders = buildResponseHeaders(upstreamResponse);
    
    // Add relay metadata in non-production environments for debugging
    if (!IS_PROD) {
      responseHeaders.set("x-relay-target", TARGET_BASE);
      responseHeaders.set("x-relay-request-id", requestId);
    }

    // Return streaming response for better memory efficiency
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });

  } catch (error) {
    // Detailed error handling with appropriate status codes
    console.error(`Relay error: ${error.name} - ${error.message}`);
    
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
function buildFilteredHeaders(request) {
  const headers = new Headers();
  
  for (const [key, value] of request.headers) {
    const lowerKey = key.toLowerCase();
    
    // Skip filtered headers and Netlify internal headers
    if (STRIP_HEADERS.has(lowerKey)) continue;
    if (NETLIFY_HEADER_PATTERN.test(lowerKey)) continue;
    
    // Skip empty or invalid values
    if (!value || value.trim() === "") continue;
    
    headers.set(key, value);
  }
  
  return headers;
}

// Helper: Get client IP with fallback chain
function getClientIp(request, context) {
  // Priority order: Cloudflare → Netlify → X-Forwarded-For → Direct
  return (request.headers.get("cf-connecting-ip") ||
          request.headers.get("x-nf-client-connection-ip") ||
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          context?.ip ||
          null);
}

// Helper: Build response headers (remove hop-by-hop)
function buildResponseHeaders(upstreamResponse) {
  const responseHeaders = new Headers();
  
  for (const [key, value] of upstreamResponse.headers) {
    const lowerKey = key.toLowerCase();
    
    // Skip problematic headers
    if (lowerKey === "transfer-encoding") continue;
    if (lowerKey === "connection") continue;
    if (lowerKey === "keep-alive") continue;
    
    // Add CORS headers for browser compatibility (optional)
    if (lowerKey === "access-control-allow-origin") {
      responseHeaders.set(key, value);
    } else {
      responseHeaders.set(key, value);
    }
  }
  
  // Add security headers
  responseHeaders.set("x-content-type-options", "nosniff");
  
  return responseHeaders;
}