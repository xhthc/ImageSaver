// tools/fixtures/offscreen-server.js - Finite deterministic HTTP fixture server for offscreen media testing
const http = require('http');

// Canonical binary signatures for media fixtures
const FIXTURE_BYTES = {
  jpeg: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60, 0x00, 0x60, 0x00, 0x00]),
  png: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52]),
  webp: Buffer.from([0x52, 0x49, 0x46, 0x46, 0x1C, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]),
  avif: Buffer.from([0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0x00, 0x00, 0x00, 0x00, 0x61, 0x76, 0x69, 0x66, 0x6D, 0x69, 0x66, 0x31, 0x6D, 0x69, 0x61, 0x66]),
  gif89a: Buffer.from([
    // Header GIF89a + Logical Screen Descriptor (10x10)
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x0A, 0x00, 0x0A, 0x00, 0x80, 0x00, 0x00,
    // Global Color Table (2 colors: 6 bytes)
    0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF,
    // Graphic Control Extension 1
    0x21, 0xF9, 0x04, 0x00, 0x0A, 0x00, 0x00, 0x00,
    // Image Descriptor 1
    0x2C, 0x00, 0x00, 0x00, 0x00, 0x0A, 0x00, 0x0A, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00,
    // Graphic Control Extension 2
    0x21, 0xF9, 0x04, 0x00, 0x0A, 0x00, 0x00, 0x00,
    // Image Descriptor 2
    0x2C, 0x00, 0x00, 0x00, 0x00, 0x0A, 0x00, 0x0A, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00,
    // Trailer
    0x3B
  ]),
  mp4: Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6F, 0x6D, 0x69, 0x73, 0x6F, 0x32]),
  webm: Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81, 0x01, 0x42, 0xF7, 0x81, 0x01, 0x42, 0xF2, 0x81]),
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="green"/></svg>'),
  malformedFtyp: Buffer.from([0x00, 0x00, 0x00, 0x08, 0x66, 0x74, 0x79, 0x70, 0x78, 0x78, 0x78, 0x78]),
  exact50: Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x60, 0x00, 0x60, 0x00, 0x00]), Buffer.alloc(30, 0x00)])
};

function createOffscreenTestServer() {
  let rateLimitAttempt = 0;
  const sockets = new Set();
  const activeTimers = new Set();
  const streamStats = {
    stream403: { bytesSent: 0, clientClosed: false },
    streamHtml: { bytesSent: 0, clientClosed: false },
    stream429: { bytesSent: 0, clientClosed: false },
    streamOverflow: { bytesSent: 0, clientClosed: false }
  };

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    const pathname = parsed.pathname;

    // Helper: track timer for cleanup
    const safeSetTimeout = (fn, ms) => {
      const id = setTimeout(() => {
        activeTimers.delete(id);
        fn();
      }, ms);
      activeTimers.add(id);
      return id;
    };

    if (pathname === '/valid.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': FIXTURE_BYTES.jpeg.length });
      res.end(FIXTURE_BYTES.jpeg);
      return;
    }

    if (pathname === '/valid.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': FIXTURE_BYTES.png.length });
      res.end(FIXTURE_BYTES.png);
      return;
    }

    if (pathname === '/valid.webp') {
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': FIXTURE_BYTES.webp.length });
      res.end(FIXTURE_BYTES.webp);
      return;
    }

    if (pathname === '/valid.avif') {
      res.writeHead(200, { 'Content-Type': 'image/avif', 'Content-Length': FIXTURE_BYTES.avif.length });
      res.end(FIXTURE_BYTES.avif);
      return;
    }

    if (pathname === '/valid.gif') {
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': FIXTURE_BYTES.gif89a.length });
      res.end(FIXTURE_BYTES.gif89a);
      return;
    }

    if (pathname === '/valid.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': FIXTURE_BYTES.mp4.length });
      res.end(FIXTURE_BYTES.mp4);
      return;
    }

    if (pathname === '/valid.webm') {
      res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': FIXTURE_BYTES.webm.length });
      res.end(FIXTURE_BYTES.webm);
      return;
    }

    if (pathname === '/valid.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': FIXTURE_BYTES.svg.length });
      res.end(FIXTURE_BYTES.svg);
      return;
    }

    if (pathname === '/misleading-svg.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': FIXTURE_BYTES.svg.length });
      res.end(FIXTURE_BYTES.svg);
      return;
    }

    if (pathname === '/misleading-svg-html') {
      const htmlBody = '<!DOCTYPE html><html><body><h1>Error</h1></body></html>';
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': Buffer.byteLength(htmlBody) });
      res.end(htmlBody);
      return;
    }

    if (pathname === '/misleading-svg-challenge') {
      const challengeBody = '<html><head><title>Just a moment...</title></head><body><div class="cf-challenge"></div></body></html>';
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': Buffer.byteLength(challengeBody) });
      res.end(challengeBody);
      return;
    }

    if (pathname === '/malformed-ftyp.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': FIXTURE_BYTES.malformedFtyp.length });
      res.end(FIXTURE_BYTES.malformedFtyp);
      return;
    }

    if (pathname === '/malformed-ftyp.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': FIXTURE_BYTES.malformedFtyp.length });
      res.end(FIXTURE_BYTES.malformedFtyp);
      return;
    }

    // Masquerading responses: HTTP 200 with image/jpeg header but non-media bodies
    if (pathname === '/masquerading-html') {
      const htmlBody = '<!DOCTYPE html><html><body><h1>Access Denied</h1></body></html>';
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': Buffer.byteLength(htmlBody) });
      res.end(htmlBody);
      return;
    }

    if (pathname === '/masquerading-json') {
      const jsonBody = JSON.stringify({ error: 'Rate limit exceeded', status: 429 });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': Buffer.byteLength(jsonBody) });
      res.end(jsonBody);
      return;
    }

    if (pathname === '/masquerading-text') {
      const textBody = '404 Not Found - Original resource was purged';
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': Buffer.byteLength(textBody) });
      res.end(textBody);
      return;
    }

    // Empty and truncated bodies
    if (pathname === '/empty.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': 0 });
      res.end();
      return;
    }

    if (pathname === '/truncated.jpg') {
      const truncBody = Buffer.from([0xFF, 0xD8]); // Only 2 bytes of SOI
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': 2 });
      res.end(truncBody);
      return;
    }

    // Misleading Content-Type: declared image/jpeg but actual WebP container
    if (pathname === '/misleading-webp.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': FIXTURE_BYTES.webp.length });
      res.end(FIXTURE_BYTES.webp);
      return;
    }

    // Rate limiting: 429 retry
    if (pathname === '/rate-limit-retry') {
      rateLimitAttempt++;
      if (rateLimitAttempt === 1) {
        res.writeHead(429, { 'Retry-After': '0', 'Content-Type': 'text/plain' });
        res.end('Too Many Requests');
      } else {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': FIXTURE_BYTES.jpeg.length });
        res.end(FIXTURE_BYTES.jpeg);
      }
      return;
    }

    if (pathname === '/rate-limit-fail') {
      res.writeHead(429, { 'Retry-After': '0', 'Content-Type': 'text/plain' });
      res.end('Too Many Requests');
      return;
    }

    // Slow streaming tests to prove prompt transport closure on rejected status / MIME / 429
    if (pathname === '/slow-stream-403') {
      res.writeHead(403, { 'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked' });
      const stats = streamStats.stream403;
      stats.bytesSent = 0;
      stats.clientClosed = false;

      req.on('close', () => {
        stats.clientClosed = true;
      });

      const chunk = Buffer.alloc(1024, 0x41);
      const sendNext = () => {
        if (res.writableEnded || res.destroyed || stats.clientClosed) return;
        res.write(chunk, () => {
          stats.bytesSent += 1024;
          safeSetTimeout(sendNext, 10);
        });
      };
      sendNext();
      return;
    }

    if (pathname === '/slow-stream-html') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Transfer-Encoding': 'chunked' });
      const stats = streamStats.streamHtml;
      stats.bytesSent = 0;
      stats.clientClosed = false;

      req.on('close', () => {
        stats.clientClosed = true;
      });

      const chunk = Buffer.alloc(1024, 0x42);
      const sendNext = () => {
        if (res.writableEnded || res.destroyed || stats.clientClosed) return;
        res.write(chunk, () => {
          stats.bytesSent += 1024;
          safeSetTimeout(sendNext, 10);
        });
      };
      sendNext();
      return;
    }

    if (pathname === '/slow-stream-429') {
      res.writeHead(429, { 'Retry-After': '0', 'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked' });
      const stats = streamStats.stream429;
      stats.bytesSent = 0;
      stats.clientClosed = false;

      req.on('close', () => {
        stats.clientClosed = true;
      });

      const chunk = Buffer.alloc(1024, 0x43);
      const sendNext = () => {
        if (res.writableEnded || res.destroyed || stats.clientClosed) return;
        res.write(chunk, () => {
          stats.bytesSent += 1024;
          safeSetTimeout(sendNext, 10);
        });
      };
      sendNext();
      return;
    }

    // Chunked streaming transfer
    if (pathname === '/chunked-stream') {
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Transfer-Encoding': 'chunked'
      });
      const data = FIXTURE_BYTES.jpeg;
      const part1 = data.subarray(0, 4);
      const part2 = data.subarray(4, 10);
      const part3 = data.subarray(10);
      res.write(part1);
      safeSetTimeout(() => {
        res.write(part2);
        safeSetTimeout(() => {
          res.write(part3);
          res.end();
        }, 15);
      }, 15);
      return;
    }

    // Stalled stream: writes initial chunk and stalls
    if (pathname === '/stalled-stream') {
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Transfer-Encoding': 'chunked'
      });
      res.write(FIXTURE_BYTES.jpeg.subarray(0, 4));
      // Never call res.end() or write further data
      return;
    }

    // Byte ceiling test endpoints
    if (pathname === '/declared-overflow.jpg') {
      const overflowBody = Buffer.alloc(1000, 0xFF);
      overflowBody[0] = 0xFF; overflowBody[1] = 0xD8; overflowBody[2] = 0xFF; overflowBody[3] = 0xE0;
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': overflowBody.length
      });
      res.end(overflowBody);
      return;
    }

    if (pathname === '/chunked-overflow.jpg') {
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Transfer-Encoding': 'chunked'
      });
      const stats = streamStats.streamOverflow;
      stats.bytesSent = 0;
      stats.clientClosed = false;

      req.on('close', () => {
        stats.clientClosed = true;
      });

      const chunk1 = Buffer.alloc(80, 0x41);
      chunk1[0] = 0xFF; chunk1[1] = 0xD8; chunk1[2] = 0xFF; chunk1[3] = 0xE0;
      const chunk2 = Buffer.alloc(80, 0x42);

      res.write(chunk1, () => {
        stats.bytesSent += 80;
        safeSetTimeout(() => {
          if (res.writableEnded || res.destroyed || stats.clientClosed) return;
          res.write(chunk2, () => {
            stats.bytesSent += 80;
            res.end();
          });
        }, 15);
      });
      return;
    }

    if (pathname === '/exact-budget.jpg') {
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': FIXTURE_BYTES.exact50.length
      });
      res.end(FIXTURE_BYTES.exact50);
      return;
    }

    if (pathname === '/slow-progress.jpg') {
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Transfer-Encoding': 'chunked'
      });
      const data = FIXTURE_BYTES.exact50;
      let sentOffset = 0;
      const sendNextChunk = () => {
        if (res.writableEnded || res.destroyed) return;
        if (sentOffset >= data.length) {
          res.end();
          return;
        }
        const nextSlice = data.subarray(sentOffset, sentOffset + 10);
        sentOffset += nextSlice.length;
        res.write(nextSlice, () => {
          safeSetTimeout(sendNextChunk, 15);
        });
      };
      sendNextChunk();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    FIXTURE_BYTES,
    resetRateLimit: () => { rateLimitAttempt = 0; },
    getStreamStats: () => streamStats,
    resetStreamStats: () => {
      streamStats.stream403 = { bytesSent: 0, clientClosed: false };
      streamStats.streamHtml = { bytesSent: 0, clientClosed: false };
      streamStats.stream429 = { bytesSent: 0, clientClosed: false };
      streamStats.streamOverflow = { bytesSent: 0, clientClosed: false };
    },
    start: () => {
      return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          resolve({
            port: addr.port,
            urlFor: (p) => `http://127.0.0.1:${addr.port}${p.startsWith('/') ? '' : '/'}${p}`
          });
        });
        server.on('error', reject);
      });
    },
    stop: () => {
      for (const t of activeTimers) {
        clearTimeout(t);
      }
      activeTimers.clear();
      for (const s of sockets) {
        try { s.destroy(); } catch (_) {}
      }
      sockets.clear();
      return new Promise((resolve) => {
        server.close(resolve);
      });
    }
  };
}

module.exports = {
  createOffscreenTestServer,
  FIXTURE_BYTES
};
