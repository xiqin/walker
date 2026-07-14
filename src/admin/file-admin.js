'use strict';

const fs = require('fs');
const path = require('path');

const MAX_LOG_LINES = 500;

/**
 * 安全解析路径并验证其在指定根目录内，防止路径穿越
 * @param {string} rootDir - 允许的根目录绝对路径
 * @param {string} relativePath - 待解析的相对路径
 * @returns {string|null} 解析后的安全绝对路径，穿越时返回 null
 */
function safeResolve(rootDir, relativePath) {
  const normalizedRoot = rootDir.endsWith(path.sep) ? rootDir.slice(0, -1) : rootDir;
  const resolved = path.resolve(rootDir, relativePath);
  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    return null;
  }
  return resolved;
}

/**
 * 读取日志文件，支持 stdout/stderr 切换、最近行数限制、关键词和级别过滤
 * 文件不存在时返回空结果
 * @param {Object} options - 读取选项
 * @param {string} options.dataDir - 数据目录绝对路径
 * @param {string} [options.stream] - 日志流类型，'out' 或 'err'，默认 'out'
 * @param {number} [options.lines] - 返回最近行数上限，默认 500
 * @param {string} [options.keyword] - 关键词过滤，匹配 message 字段
 * @param {string} [options.level] - 级别过滤，匹配 level 字段
 * @returns {{ lines: Object[], total: number, filtered: number }}
 */
function readLogs(options) {
  const opts = options || {};
  const dataDir = opts.dataDir || '';
  const stream = opts.stream || 'out';
  const maxLines = opts.lines || MAX_LOG_LINES;

  const logFileName = stream === 'err' ? 'walker-err.log' : 'walker-out.log';
  const logPath = path.join(dataDir, 'logs', logFileName);

  if (!fs.existsSync(logPath)) {
    return { lines: [], total: 0, filtered: 0 };
  }

  try {
    const stat = fs.statSync(logPath);
    const fileSize = stat.size;
    const readSize = Math.min(fileSize, maxLines * 2048);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(logPath, 'r');
    const startPos = Math.max(0, fileSize - readSize);
    fs.readSync(fd, buffer, 0, readSize, startPos);
    fs.closeSync(fd);
    const raw = buffer.toString('utf8');
    let allLines = raw.split('\n').filter((line) => line.trim());
    if (startPos > 0 && allLines.length > 0) {
      allLines = allLines.slice(1);
    }
    const total = allLines.length;
    const recent = allLines.slice(-maxLines);

    let parsed = [];
    for (const line of recent) {
      try {
        parsed.push(JSON.parse(line));
      } catch (_e) {
        parsed.push({ raw: line, level: 'unknown', message: line });
      }
    }

    let filtered = parsed;
    if (opts.level) {
      filtered = filtered.filter((entry) => entry.level === opts.level);
    }
    if (opts.keyword) {
      const kw = opts.keyword.toLowerCase();
      filtered = filtered.filter((entry) =>
        (entry.message || '').toLowerCase().includes(kw)
      );
    }

    return {
      lines: filtered,
      total,
      filtered: filtered.length,
    };
  } catch (_e) {
    return { lines: [], total: 0, filtered: 0 };
  }
}

/**
 * 列出附件目录下的所有附件文件，按 session 分组
 * @param {string} dataDir - 数据目录绝对路径
 * @returns {{ groups: Object[], totalFiles: number }}
 */
function listAttachments(dataDir) {
  const attachDir = path.join(dataDir, 'attachments');
  if (!fs.existsSync(attachDir)) {
    return { groups: [], totalFiles: 0 };
  }

  const groups = [];
  let totalFiles = 0;

  try {
    const sessionDirs = fs.readdirSync(attachDir);
    for (const sessionId of sessionDirs) {
      const sessionPath = path.join(attachDir, sessionId);
      if (!fs.statSync(sessionPath).isDirectory()) continue;

      const files = [];
      try {
        const names = fs.readdirSync(sessionPath);
        for (const name of names) {
          const filePath = path.join(sessionPath, name);
          try {
            const stat = fs.statSync(filePath);
            files.push({
              name,
              sessionId,
              size: stat.size,
              modifiedAt: stat.mtime.toISOString(),
            });
            totalFiles += 1;
          } catch (_e) {
            continue;
          }
        }
      } catch (_e) {
        continue;
      }

      if (files.length > 0) {
        groups.push({ sessionId, files });
      }
    }
  } catch (_e) {
    return { groups: [], totalFiles: 0 };
  }

  return { groups, totalFiles };
}

/**
 * 获取附件文件内容，严格验证路径位于附件根目录内
 * @param {string} dataDir - 数据目录绝对路径
 * @param {string} sessionId - 会话 ID
 * @param {string} filename - 文件名
 * @returns {{ ok: boolean, data?: Buffer, error?: string }}
 */
function getAttachment(dataDir, sessionId, filename) {
  const attachDir = path.join(dataDir, 'attachments');
  const relativePath = path.join(sessionId, filename);
  const resolved = safeResolve(attachDir, relativePath);

  if (!resolved) {
    return { ok: false, error: '路径穿越：附件路径必须在附件根目录内' };
  }

  if (!fs.existsSync(resolved)) {
    return { ok: false, error: '附件文件不存在' };
  }

  try {
    const buffer = fs.readFileSync(resolved);
    return { ok: true, data: buffer };
  } catch (_e) {
    return { ok: false, error: '读取附件失败' };
  }
}

/**
 * 删除附件文件，严格验证路径位于附件根目录内
 * @param {string} dataDir - 数据目录绝对路径
 * @param {string} sessionId - 会话 ID
 * @param {string} filename - 文件名
 * @returns {{ ok: boolean, error?: string }}
 */
function deleteAttachment(dataDir, sessionId, filename) {
  const attachDir = path.join(dataDir, 'attachments');
  const relativePath = path.join(sessionId, filename);
  const resolved = safeResolve(attachDir, relativePath);

  if (!resolved) {
    return { ok: false, error: '路径穿越：附件路径必须在附件根目录内' };
  }

  if (!fs.existsSync(resolved)) {
    return { ok: false, error: '附件文件不存在' };
  }

  try {
    fs.unlinkSync(resolved);
    return { ok: true };
  } catch (_e) {
    return { ok: false, error: '删除附件失败' };
  }
}

/**
 * 查找孤立附件：附件目录中有文件但对应 session 不存在或已删除
 * @param {string} dataDir - 数据目录绝对路径
 * @param {Object} sessionsData - 当前 session 数据映射
 * @returns {Object[]} 孤立附件列表
 */
function findOrphanAttachments(dataDir, sessionsData) {
  const attachDir = path.join(dataDir, 'attachments');
  if (!fs.existsSync(attachDir)) return [];

  const orphans = [];
  try {
    const sessionDirs = fs.readdirSync(attachDir);
    for (const sessionId of sessionDirs) {
      const sessionPath = path.join(attachDir, sessionId);
      try {
        if (!fs.statSync(sessionPath).isDirectory()) continue;
      } catch (_e) {
        continue;
      }

      const session = sessionsData[sessionId];
      if (!session || session.status === 'deleted') {
        try {
          const files = fs.readdirSync(sessionPath);
          for (const name of files) {
            orphans.push({ sessionId, name, reason: !session ? 'session not found' : 'session deleted' });
          }
        } catch (_e) {
          continue;
        }
      }
    }
  } catch (_e) {
    return [];
  }

  return orphans;
}

/**
 * 清理孤立附件目录，删除对不存在或已删除 session 的附件
 * @param {string} dataDir - 数据目录绝对路径
 * @param {Object} sessionsData - 当前 session 数据映射
 * @param {boolean} confirm - 是否确认清理
 * @returns {{ ok: boolean, cleaned?: string[], error?: string }}
 */
function cleanupOrphanAttachments(dataDir, sessionsData, confirm) {
  if (!confirm) {
    return { ok: false, error: '清理需要 confirm=true 确认' };
  }

  const orphans = findOrphanAttachments(dataDir, sessionsData);
  const cleaned = [];

  for (const orphan of orphans) {
    const filePath = path.join(dataDir, 'attachments', orphan.sessionId, orphan.name);
    try {
      fs.unlinkSync(filePath);
      cleaned.push(orphan.sessionId + '/' + orphan.name);
    } catch (_e) {
      continue;
    }
  }

  return { ok: true, cleaned };
}

module.exports = {
  safeResolve,
  readLogs,
  listAttachments,
  getAttachment,
  deleteAttachment,
  findOrphanAttachments,
  cleanupOrphanAttachments,
};
