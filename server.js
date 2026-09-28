const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 8080;
const WEB_DIR = path.join(__dirname, 'web');
const GAME_DIR = path.join(__dirname, 'game');

// Ensure game directory exists
if (!fs.existsSync(GAME_DIR)) {
  fs.mkdirSync(GAME_DIR, { recursive: true });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.jar': 'application/java-archive',
  '.jad': 'text/vnd.sun.j2me.app-descriptor',
  '.zip': 'application/zip',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
};

function getGameFiles() {
  try {
    const searchDirs = [GAME_DIR, path.join(WEB_DIR, 'game')];
    let files = [];
    let activeDir = GAME_DIR;

    for (const dir of searchDirs) {
      if (fs.existsSync(dir)) {
        const list = fs.readdirSync(dir);
        if (list.some(f => f.toLowerCase().endsWith('.jar'))) {
          files = list;
          activeDir = dir;
          break;
        }
      }
    }

    const jarFiles = files.filter(f => f.toLowerCase().endsWith('.jar'));
    const jadFiles = files.filter(f => f.toLowerCase().endsWith('.jad'));

    if (jarFiles.length === 0) {
      return { found: false, files: files };
    }

    // Prefer citybloxx.jar or city-bloxx.jar if multiple
    let targetJar = jarFiles.find(f => f.toLowerCase().includes('city')) ||
                    jarFiles.find(f => f.toLowerCase().includes('bloxx')) ||
                    jarFiles[0];

    const baseName = targetJar.replace(/\.jar$/i, '');
    let targetJad = jadFiles.find(f => f.toLowerCase().startsWith(baseName.toLowerCase())) ||
                    jadFiles[0] || null;

    const jarStat = fs.statSync(path.join(activeDir, targetJar));

    return {
      found: true,
      jarName: targetJar,
      jadName: targetJad,
      jarUrl: `/game/${encodeURIComponent(targetJar)}`,
      jadUrl: targetJad ? `/game/${encodeURIComponent(targetJad)}` : null,
      size: jarStat.size,
      allJars: jarFiles,
      allJads: jadFiles
    };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

// Simple multipart form parser for uploading jar/jad
function handleUpload(req, res) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    try {
      const buffer = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      
      if (contentType.includes('multipart/form-data')) {
        const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
        if (!boundaryMatch) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Missing boundary in multipart request' }));
        }
        const boundary = boundaryMatch[1] || boundaryMatch[2];
        const parts = parseMultipart(buffer, boundary);
        
        let savedCount = 0;
        for (const part of parts) {
          if (part.filename) {
            let filename = path.basename(part.filename);
            const ext = path.extname(filename).toLowerCase();
            if (ext === '.jar' || ext === '.jad') {
              fs.writeFileSync(path.join(GAME_DIR, filename), part.data);
              savedCount++;
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, savedCount, game: getGameFiles() }));
      } else {
        // Direct binary upload with header X-Filename
        const filename = path.basename(req.headers['x-filename'] || 'game.jar');
        const ext = path.extname(filename).toLowerCase();
        if (ext === '.jar' || ext === '.jad') {
          fs.writeFileSync(path.join(GAME_DIR, filename), buffer);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, filename, game: getGameFiles() }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Only .jar and .jad files are accepted' }));
        }
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from('--' + boundary);
  const endBoundaryBuffer = Buffer.from('--' + boundary + '--');
  
  let start = 0;
  while (start < buffer.length) {
    const boundaryIndex = buffer.indexOf(boundaryBuffer, start);
    if (boundaryIndex === -1) break;
    
    const nextBoundaryIndex = buffer.indexOf(boundaryBuffer, boundaryIndex + boundaryBuffer.length);
    if (nextBoundaryIndex === -1) break;
    
    const partBuffer = buffer.slice(boundaryIndex + boundaryBuffer.length, nextBoundaryIndex);
    const headerEndIndex = partBuffer.indexOf('\r\n\r\n');
    if (headerEndIndex !== -1) {
      const headerStr = partBuffer.slice(0, headerEndIndex).toString('utf-8');
      let data = partBuffer.slice(headerEndIndex + 4);
      // Remove trailing \r\n if present
      if (data.length >= 2 && data[data.length - 2] === 13 && data[data.length - 1] === 10) {
        data = data.slice(0, data.length - 2);
      }
      
      const filenameMatch = headerStr.match(/filename="([^"]+)"/i);
      const nameMatch = headerStr.match(/name="([^"]+)"/i);
      
      parts.push({
        name: nameMatch ? nameMatch[1] : null,
        filename: filenameMatch ? filenameMatch[1] : null,
        headers: headerStr,
        data: data
      });
    }
    
    start = nextBoundaryIndex;
  }
  return parts;
}

function serveFile(req, res, filePath) {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const fileSize = stats.size;

    // CheerpJ requires Range request support
    const range = req.headers.range;

    const baseHeaders = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, POST',
      'Access-Control-Allow-Headers': 'Range, Content-Type, X-Filename',
      'Cache-Control': 'no-cache'
    };

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
        res.writeHead(416, {
          ...baseHeaders,
          'Content-Range': `bytes */${fileSize}`
        });
        return res.end();
      }

      const chunkSize = (end - start) + 1;
      const fileStream = fs.createReadStream(filePath, { start, end });

      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Content-Length': chunkSize
      });

      fileStream.pipe(res);
    } else {
      res.writeHead(200, {
        ...baseHeaders,
        'Content-Length': fileSize
      });

      fs.createReadStream(filePath).pipe(res);
    }
  });
}

const server = http.createServer((req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS, POST',
      'Access-Control-Allow-Headers': 'Range, Content-Type, X-Filename',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  // API: check for game files
  if (pathname === '/api/game' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    return res.end(JSON.stringify(getGameFiles()));
  }

  // API: upload jar/jad file
  if (pathname === '/api/upload' && req.method === 'POST') {
    return handleUpload(req, res);
  }

  // Serve from game/ directory (checks ./game and ./web/game)
  if (pathname.startsWith('/game/')) {
    const relativePath = pathname.substring(6);
    const safePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
    let targetFile = path.join(GAME_DIR, safePath);
    if (!fs.existsSync(targetFile)) {
      targetFile = path.join(WEB_DIR, 'game', safePath);
    }
    return serveFile(req, res, targetFile);
  }

  // Default: serve from web/ directory
  let relativePath = pathname === '/' ? 'index.html' : pathname;
  // If requested without extension and exists in web, try to serve
  const safePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
  let targetFile = path.join(WEB_DIR, safePath);

  // If path is a directory, check for index.html inside
  if (fs.existsSync(targetFile) && fs.statSync(targetFile).isDirectory()) {
    targetFile = path.join(targetFile, 'index.html');
  }

  serveFile(req, res, targetFile);
});

function getNetworkAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

server.listen(PORT, () => {
  const networkIp = getNetworkAddress();
  const game = getGameFiles();
  const nodeEnv = process.env.NODE_ENV || 'development';

  console.log('\n--------------------------------------------------');
  console.log('City Bloxx Web Service');
  console.log('--------------------------------------------------');
  console.log(`Status:      Ready (PID: ${process.pid})`);
  console.log(`Environment: ${nodeEnv}`);
  console.log(`Runtime:     Node.js ${process.version} (${process.platform} ${process.arch})`);
  console.log(`Local:       http://localhost:${PORT}/`);
  if (networkIp) {
    console.log(`Network:     http://${networkIp}:${PORT}/`);
  }
  console.log(`Static Root: ./web`);
  console.log(`Game Store:  ./game`);
  if (game.found) {
    const sizeKb = (game.size / 1024).toFixed(1);
    console.log(`Game Asset:  ${game.jarName} (${sizeKb} KB) [Active]`);
  } else {
    console.log(`Game Asset:  None detected (mount .jar in ./game or upload via UI)`);
  }
  console.log('--------------------------------------------------\n');
});

process.on('SIGINT', () => {
  console.log('\n[server] Process interrupted (SIGINT). Shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  console.log('\n[server] Process terminated (SIGTERM). Shutting down...');
  server.close(() => process.exit(0));
});

