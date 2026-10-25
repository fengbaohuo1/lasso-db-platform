#!/usr/bin/env node
/**
 * DB Platform BFF（Node 内置模块，零 npm 依赖）。
 *
 * 职责：
 *  1. 静态托管 public/；
 *  2. 把 /api/* 反向代理到 db-service（默认 http://127.0.0.1:18090），可选注入 X-API-Key；
 *  3. /healthz 返回 BFF 自身与 db-service 连通状态。
 *
 * 用法：
 *   node server.mjs --service http://127.0.0.1:18090 --port 18091 [--api-key <key>]
 *   环境变量：DB_SERVICE_URL / DB_SERVICE_API_KEY / PORT
 */
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const MAX_BODY_BYTES = 1024 * 1024;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = 'true';
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`DB Platform BFF

用法: node server.mjs [选项]
  --port <端口>        静态站点与 BFF 端口（默认 18091，或 env PORT）
  --service <地址>     db-service 地址（默认 http://127.0.0.1:18090，或 env DB_SERVICE_URL）
  --api-key <密钥>     注入 X-API-Key（或 env DB_SERVICE_API_KEY；服务端未配置时可省略）
`);
  process.exit(0);
}

const PORT = Number(args.port || process.env.PORT || 18091);
const SERVICE = String(args.service || process.env.DB_SERVICE_URL || 'http://127.0.0.1:18090')
  .replace(/\/+$/, '');
const API_KEY = String(args['api-key'] || process.env.DB_SERVICE_API_KEY || '');
const STARTED_AT = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  if (res.writableEnded) return;
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length });
  res.end(body);
}

function envelope(code, info) {
  return { code, info, data: null };
}

function upstreamHeaders(req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
      'proxy-authorization', 'authorization', 'cookie', 'accept-encoding',
      'content-length'].includes(lower)) {
      continue;
    }
    headers[lower] = value;
  }
  if (API_KEY) headers['x-api-key'] = API_KEY;
  return headers;
}

const SERVICE_URL = new URL(SERVICE);

function proxyApi(req, res, url) {
  const targetPath = url.pathname + url.search;
  const headers = upstreamHeaders(req);
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
  const upstream = http.request({
    hostname: SERVICE_URL.hostname,
    port: SERVICE_URL.port || 80,
    path: targetPath,
    method: req.method,
    headers,
  }, (upstreamRes) => {
    const responseHeaders = {};
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding'].includes(key)) {
        continue;
      }
      responseHeaders[key] = value;
    }
    responseHeaders['Cache-Control'] = 'no-store';
    res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
    upstreamRes.pipe(res);
  });
  upstream.on('error', (error) => {
    sendJson(res, 502, envelope('BFF_PROXY_ERROR',
      `无法连接 db-service（${SERVICE}）：${error.message}。请先启动 db-service（默认端口 18090）。`));
  });
  if (req.method === 'GET' || req.method === 'HEAD') {
    upstream.end();
  } else {
    req.pipe(upstream);
  }
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? '/index.html' : pathname;
  const filePath = resolve(PUBLIC_DIR, `.${relative}`);
  if (!filePath.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) {
    sendText(res, 403, '禁止访问 public 目录以外的文件');
    return;
  }
  let info;
  try {
    info = await stat(filePath);
  } catch {
    sendText(res, 404,
      `404 未找到 ${pathname}\n\n` +
      '请确认已用 node server.mjs 启动 db-platform，并检查 public/ 下的文件。\n' +
      '健康检查：GET /healthz', 'text/plain; charset=utf-8');
    return;
  }
  if (!info.isFile()) {
    sendText(res, 404, `404 未找到 ${pathname}`);
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch {
    sendText(res, 400, '非法请求 URL');
    return;
  }
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === '/healthz') {
    sendJson(res, 200, {
      ok: true,
      service: 'db-platform-bff',
      dbService: SERVICE,
      apiKeyConfigured: Boolean(API_KEY),
      port: PORT,
      uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    });
    return;
  }
  if (pathname.startsWith('/api/')) {
    proxyApi(req, res, url);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, '静态资源只支持 GET/HEAD');
    return;
  }
  await serveStatic(req, res, pathname);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[BFF] 端口 ${PORT} 已被占用：请换 --port，或先停止占用进程。`);
  } else {
    console.error(`[BFF] 启动失败：${error.message}`);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[BFF] DB Platform 已启动: http://127.0.0.1:${PORT}`);
  console.log(`[BFF] 静态目录: ${PUBLIC_DIR}`);
  console.log(`[BFF] db-service: ${SERVICE}${API_KEY ? '（已配置 X-API-Key 注入）' : '（未配置 API Key）'}`);
});
