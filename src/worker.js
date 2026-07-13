"use strict";

// ===========================================================================
// Proxy vidéo Stremio sur Cloudflare Workers.
//
// Remplace le proxy hébergé sur Vercel (qui facture la bande passante « Fast
// Origin Transfer »). Cloudflare ne facture pas l'egress → bande passante
// gratuite pour le streaming.
//
// Deux routes, mêmes jetons que les addons (base64url de {u: url, r: referer}) :
//   /hls/{token}.m3u8|.ts  → réécrit les playlists HLS et streame les segments
//   /mp4/{token}.mp4       → streame un MP4 avec relais des requêtes Range
//
// nodejs_compat est activé (wrangler.toml) pour disposer de Buffer et décoder
// les jetons exactement comme les addons Node.
// ===========================================================================

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const HLS_PREFIX = "/hls/";
const MP4_PREFIX = "/mp4/";
// Extraction directe DANS le Worker (indispensable pour Vidmoly/StreamTape qui
// verrouillent le lien à l'IP d'extraction : ainsi extraction ET proxy sont sur
// la même IP Cloudflare). Le jeton est le base64url de l'URL de l'iframe.
const VIDMOLY_PREFIX = "/vidmoly/";
const STREAMTAPE_PREFIX = "/streamtape/";

const b64d = (t) => Buffer.from(t, "base64url").toString("utf8");

function decodeToken(token) {
  return JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
}
function encodeToken(target, referer) {
  return Buffer.from(JSON.stringify({ u: target, r: referer }), "utf8").toString(
    "base64url"
  );
}

// ----------------------------- HLS -----------------------------------------

function proxyChild(rawUrl, baseUrl, referer, origin) {
  const abs = new URL(rawUrl, baseUrl).href;
  const isPlaylist = new URL(abs).pathname.endsWith(".m3u8");
  const ext = isPlaylist ? ".m3u8" : ".ts";
  return `${origin}${HLS_PREFIX}${encodeToken(abs, referer)}${ext}`;
}

function rewritePlaylist(text, baseUrl, referer, origin) {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(
          /URI="([^"]+)"/g,
          (_m, uri) => `URI="${proxyChild(uri, baseUrl, referer, origin)}"`
        );
      }
      return proxyChild(trimmed, baseUrl, referer, origin);
    })
    .join("\n");
}

async function handleHls(request, path, origin) {
  const tokenWithExt = path.slice(HLS_PREFIX.length);
  const token = tokenWithExt.replace(/\.(m3u8|ts)$/, "");
  const { u: target, r: referer } = decodeToken(token);

  const upstream = await fetch(target, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: referer,
      Origin: new URL(referer).origin,
    },
  });
  if (!upstream.ok) return new Response(null, { status: upstream.status });

  const isPlaylist = new URL(target).pathname.endsWith(".m3u8");

  if (isPlaylist) {
    const text = await upstream.text();
    return new Response(rewritePlaylist(text, target, referer, origin), {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache",
      },
    });
  }

  // Segment binaire : on streame le corps tel quel (aucun buffering).
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": upstream.headers.get("content-type") || "video/MP2T",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

// ----------------------------- MP4 -----------------------------------------

async function handleMp4(request, path) {
  const token = path.slice(MP4_PREFIX.length).replace(/\.mp4$/, "");
  const { u: target, r: referer } = decodeToken(token);

  const range = request.headers.get("Range");
  const upstream = await fetch(target, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: referer,
      Range: range || "bytes=0-",
    },
    redirect: "follow",
  });

  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Type", upstream.headers.get("content-type") || "video/mp4");

  const contentRange = upstream.headers.get("content-range");
  if (range && contentRange) {
    headers.set("Content-Range", contentRange);
    const len = upstream.headers.get("content-length");
    if (len) headers.set("Content-Length", len);
  } else if (contentRange) {
    const total = contentRange.split("/")[1];
    if (total) headers.set("Content-Length", total);
  }

  const status = range ? upstream.status : 200;
  return new Response(upstream.body, { status, headers });
}

// ------------------------- Vidmoly (extraction) ----------------------------

async function extractVidmolyMaster(embedUrl) {
  const host = new URL(embedUrl).host;
  const referer = `https://${host}/`;
  const html = await (
    await fetch(embedUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Origin: `https://${host}`,
        Referer: referer,
        "Sec-Fetch-Dest": "iframe",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    })
  ).text();
  const block = html.match(/sources:\s*(\[[\s\S]*?\])/);
  const scope = block ? block[1] : html;
  const m = scope.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/);
  return m ? { master: m[1], referer } : null;
}

async function handleVidmoly(request, path, origin) {
  const embedUrl = b64d(path.slice(VIDMOLY_PREFIX.length).replace(/\.m3u8$/, ""));
  const ext = await extractVidmolyMaster(embedUrl);
  if (!ext) return new Response(null, { status: 502 });

  const upstream = await fetch(ext.master, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: ext.referer,
      Origin: new URL(ext.referer).origin,
    },
  });
  if (!upstream.ok) return new Response(null, { status: upstream.status });

  // master → variantes/segments réécrits vers /hls (fetchés par le Worker,
  // même IP Cloudflare → cohérent avec l'extraction).
  const text = await upstream.text();
  return new Response(rewritePlaylist(text, ext.master, ext.referer, origin), {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-cache",
    },
  });
}

// ----------------------- StreamTape (extraction) ---------------------------

async function extractStreamtapeUrl(embedUrl) {
  const EMBED_BASE = "https://streamtape.com/e/";
  let url = embedUrl;
  if (!url.startsWith(EMBED_BASE)) {
    const id = url.split("/")[4];
    if (!id) return null;
    url = EMBED_BASE + id;
  }
  const html = await (
    await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Referer: "https://streamtape.com/" },
    })
  ).text();
  const m = html.match(
    /robotlink'\)\.innerHTML\s*=\s*'([^']*)'\s*\+\s*\('xcd([^']*)'/
  );
  return m ? "https:" + m[1] + m[2] : null;
}

async function handleStreamtape(request, path) {
  const embedUrl = b64d(
    path.slice(STREAMTAPE_PREFIX.length).replace(/\.mp4$/, "")
  );
  const videoUrl = await extractStreamtapeUrl(embedUrl);
  if (!videoUrl) return new Response(null, { status: 502 });

  const range = request.headers.get("Range");
  const upstream = await fetch(videoUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: "https://streamtape.com/",
      Range: range || "bytes=0-",
    },
    redirect: "follow",
  });

  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Type", upstream.headers.get("content-type") || "video/mp4");
  const contentRange = upstream.headers.get("content-range");
  if (range && contentRange) {
    headers.set("Content-Range", contentRange);
    const len = upstream.headers.get("content-length");
    if (len) headers.set("Content-Length", len);
  } else if (contentRange) {
    const total = contentRange.split("/")[1];
    if (total) headers.set("Content-Length", total);
  }
  return new Response(upstream.body, {
    status: range ? upstream.status : 200,
    headers,
  });
}

// ----------------------------- Entrée --------------------------------------

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path.startsWith(HLS_PREFIX)) return await handleHls(request, path, url.origin);
      if (path.startsWith(MP4_PREFIX)) return await handleMp4(request, path);
      if (path.startsWith(VIDMOLY_PREFIX)) return await handleVidmoly(request, path, url.origin);
      if (path.startsWith(STREAMTAPE_PREFIX)) return await handleStreamtape(request, path);
      return new Response("Stremio video proxy — OK", { status: 200 });
    } catch (err) {
      return new Response("proxy error: " + err.message, { status: 502 });
    }
  },
};
