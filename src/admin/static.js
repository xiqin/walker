/**
 * 静态文件服务模块
 * 处理管理端 HTML/CSS/JS 等静态资源的响应
 * 包含 MIME 类型映射、路径穿越防护、SPA fallback 和 404 处理
 */

const fs = require('fs');
const path = require('path');

/**
 * MIME 类型映射表：根据文件扩展名返回对应的 Content-Type
 */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

/**
 * 根据文件扩展名获取 MIME 类型
 * @param {string} filePath - 文件路径
 * @returns {string} MIME 类型，默认为 application/octet-stream
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * 判断请求路径是否存在路径穿越风险（包含 .. 段）
 * @param {string} urlPath - URL 请求路径
 * @returns {boolean} 存在穿越风险时返回 true
 */
function hasTraversal(urlPath) {
  const segments = urlPath.split('/');
  return segments.some((seg) => seg === '..');
}

/**
 * 将 URL 路径安全映射到文件系统路径，防止穿越
 * @param {string} urlPath - URL 路径，如 /css/app.css
 * @param {string} publicDir - 静态文件根目录
 * @returns {string|null} 安全的文件系统路径，穿越时返回 null
 */
function resolveFilePath(urlPath, publicDir) {
  if (hasTraversal(urlPath)) return null;

  const normalized = path.normalize(urlPath);
  const fullPath = path.join(publicDir, normalized);

  const rel = path.relative(publicDir, fullPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  return fullPath;
}

/**
 * 判断路径是否为可能需要 SPA fallback 的浏览器路径
 * 排除 API 路径和已知静态文件扩展名
 * @param {string} pathname - URL 路径
 * @returns {boolean}
 */
function isSpaFallbackCandidate(pathname) {
  if (pathname.startsWith('/api/admin/')) return false;
  const ext = path.extname(pathname).toLowerCase();
  if (ext && MIME_TYPES[ext]) return false;
  return true;
}

/**
 * 读取并返回静态文件内容
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {string} filePath - 文件系统路径
 * @param {Object} response - response 模块（用于 404 错误）
 */
function serveFile(res, filePath, response) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      response.send(res, response.error('NOT_FOUND', '文件未找到'), 404);
      return;
    }
    const mime = getMimeType(filePath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(data);
  });
}

/**
 * 处理静态文件请求：路径穿越检查 -> 文件查找 -> SPA fallback -> 404
 * @param {import('http').IncomingMessage} req - HTTP 请求
 * @param {import('http').ServerResponse} res - HTTP 响应
 * @param {string} publicDir - 静态文件根目录
 * @param {Object} response - response 模块
 */
function handleStatic(req, res, publicDir, response) {
  const urlPath = req.urlPath || '/';

  if (hasTraversal(urlPath)) {
    response.send(res, response.error('BAD_REQUEST', '路径不允许包含 ..'), 400);
    return;
  }

  const filePath = resolveFilePath(urlPath, publicDir);

  if (!filePath) {
    response.send(res, response.error('BAD_REQUEST', '非法路径'), 400);
    return;
  }

  if (urlPath === '/' || urlPath === '') {
    const indexPath = path.join(publicDir, 'index.html');
    serveFile(res, indexPath, response);
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isFile()) {
      serveFile(res, filePath, response);
      return;
    }

    if (isSpaFallbackCandidate(urlPath)) {
      const indexPath = path.join(publicDir, 'index.html');
      fs.stat(indexPath, (indexErr, indexStats) => {
        if (!indexErr && indexStats.isFile()) {
          serveFile(res, indexPath, response);
        } else {
          response.send(res, response.error('NOT_FOUND', '页面未找到'), 404);
        }
      });
      return;
    }

    response.send(res, response.error('NOT_FOUND', '文件未找到'), 404);
  });
}

module.exports = {
  MIME_TYPES,
  getMimeType,
  hasTraversal,
  resolveFilePath,
  isSpaFallbackCandidate,
  serveFile,
  handleStatic,
};
