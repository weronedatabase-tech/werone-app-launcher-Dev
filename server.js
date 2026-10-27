const express = require('express');
const path = require('path');

const app = express();
const port = 3000;

// Bounded in-memory LRU cache & in-flight deduplication for /api/image-proxy
const IMAGE_CACHE_MAX_ITEMS = 150;
const IMAGE_CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour
const UPSTREAM_TIMEOUT_MS = 8000;
const imageCache = new Map();
const inFlightRequests = new Map();

function getCachedImage(url) {
  const entry = imageCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > IMAGE_CACHE_TTL_MS) {
    imageCache.delete(url);
    return null;
  }
  // Refresh LRU order
  imageCache.delete(url);
  imageCache.set(url, entry);
  return entry;
}

function setCachedImage(url, buffer, contentType) {
  if (imageCache.size >= IMAGE_CACHE_MAX_ITEMS) {
    const oldestKey = imageCache.keys().next().value;
    if (oldestKey !== undefined) imageCache.delete(oldestKey);
  }
  imageCache.set(url, {
    buffer,
    contentType,
    timestamp: Date.now()
  });
}

async function fetchUpstreamImage(targetUrl) {
  const existingPromise = inFlightRequests.get(targetUrl);
  if (existingPromise) return existingPromise;

  const fetchPromise = (async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      const response = await fetch(targetUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
        }
      });

      if (!response.ok) {
        const err = new Error(`Upstream error: ${response.status}`);
        err.status = response.status;
        throw err;
      }

      const contentType = response.headers.get('content-type') || 'image/png';
      if (contentType.includes('text/html')) {
        const err = new Error('Upstream returned HTML instead of an image');
        err.status = 422;
        throw err;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      setCachedImage(targetUrl, buffer, contentType);
      return { buffer, contentType };
    } finally {
      clearTimeout(timeoutId);
      inFlightRequests.delete(targetUrl);
    }
  })();

  inFlightRequests.set(targetUrl, fetchPromise);
  return fetchPromise;
}

// Proxy remote images (Google Drive thumbnails & external icons) with CORS headers for Canvas IconStudio
app.get('/api/image-proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).send('Missing url parameter');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return res.status(400).send('Invalid url protocol');
    }
  } catch {
    return res.status(400).send('Malformed url parameter');
  }

  const normalizedUrl = parsedUrl.toString();
  const cached = getCachedImage(normalizedUrl);
  if (cached) {
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('X-Cache', 'HIT');
    return res.send(cached.buffer);
  }

  try {
    const { buffer, contentType } = await fetchUpstreamImage(normalizedUrl);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.setHeader('X-Cache', 'MISS');
    return res.send(buffer);
  } catch (err) {
    const status = err.status || (err.name === 'AbortError' ? 504 : 502);
    return res.status(status).send(err.message || 'Failed to fetch image');
  }
});

// Serve static files with optimized cache control headers
app.use(express.static(path.join(__dirname, '/'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.png') || filePath.endsWith('.ico') || filePath.endsWith('.svg') || filePath.endsWith('.webp')) {
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    } else if (filePath.endsWith('sw.js') || filePath.endsWith('config.js') || filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// For SPA routing fallback (in case it uses History API)
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on port ${port} (0.0.0.0)`);
});

