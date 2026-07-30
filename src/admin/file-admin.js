'use strict';

const fs = require('fs');
const path = require('path');

const MAX_LOG_LINES = 500;
const MAX_LOG_LINES_CAP = 5000;
const LOG_FILE_OUT = 'walker.out.log';
const LOG_FILE_ERR = 'walker.err.log';
const LOG_FILE_MAIN = 'walker.log';
const LEGACY_LOG_FILE_OUT = 'walker-out.log';
const LEGACY_LOG_FILE_ERR = 'walker-err.log';
const CLEARABLE_LOG_FILES = [
  LOG_FILE_OUT,
  LOG_FILE_ERR,
  LOG_FILE_MAIN,
  LEGACY_LOG_FILE_OUT,
  LEGACY_LOG_FILE_ERR,
];

const crypto = require('crypto');

/**
 * 安全解析路径并验证其在指定根目录内，防止路径穿越
 * @param {string} rootDir - 允许的根目录绝对路径
 * @param {string} relativePath - 待解析的相对路径
 * @returns {string|null} 解析后的安全绝对路径，穿越时返回 null
 */
function safeResolve(rootDir, relativePath) {
  const normalizedRoot = rootDir.endsWith(path.sep) ? rootDir.slice(0, -1) : rootDir;
  const resolved = path.resolve(rootDir, relativePath);
  let realRoot;
  try {
    realRoot = fs.realpathSync(normalizedRoot);
  } catch (_) {
    realRoot = normalizedRoot;
  }
  let realResolved;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch (_) {
    realResolved = resolved;
  }
  if (process.platform === 'win32') {
    realRoot = realRoot.toLowerCase();
    realResolved = realResolved.toLowerCase();
  }
  if (!realResolved.startsWith(realRoot + path.sep) && realResolved !== realRoot) {
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
  const cwd = opts.cwd || process.cwd();
  const maxLines = Math.min(Math.max(opts.lines || MAX_LOG_LINES, 1), MAX_LOG_LINES_CAP);

  const logFileNames = stream === 'err'
    ? [LOG_FILE_ERR, LEGACY_LOG_FILE_ERR]
    : [LOG_FILE_OUT, LOG_FILE_MAIN, LEGACY_LOG_FILE_OUT];
  const logRoots = dataDir
    ? [dataDir, ...(opts.fallbackToCwd && dataDir !== cwd ? [cwd] : [])]
    : [cwd];
  const logPath = logRoots
    .flatMap((root) => logFileNames.map((name) => path.join(root, 'logs', name)))
    .find((candidate) => fs.existsSync(candidate));

  if (!logPath) {
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
        (entry.message || '').toLowerCase().includes(kw),
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

function isClearableLogArchive(name) {
  const index = name.lastIndexOf('.');
  if (index < 0 || !/^\d+$/.test(name.slice(index + 1))) return false;
  return CLEARABLE_LOG_FILES.includes(name.slice(0, index));
}

/**
 * 清空允许列表日志文件：当前日志截断，数字归档删除。
 * @param {Object} options - 清空选项
 * @param {string} options.dataDir - 数据目录绝对路径
 * @param {string} [options.cwd] - 工作目录绝对路径，默认 process.cwd()
 * @param {boolean} [options.fallbackToCwd] - 是否额外清理 cwd/logs
 * @returns {{ ok: boolean, truncated: string[], deleted: string[], failures: Object[] }}
 */
function clearLogs(options) {
  const opts = options || {};
  const fsModule = opts.fs || fs;
  const dataDir = opts.dataDir || '';
  const cwd = opts.cwd || process.cwd();
  const logRoots = dataDir
    ? [dataDir, ...(opts.fallbackToCwd && dataDir !== cwd ? [cwd] : [])]
    : [];
  const truncated = [];
  const deleted = [];
  const failures = [];

  if (!dataDir) {
    return {
      ok: false,
      truncated,
      deleted,
      failures: [{ file: 'logs', action: 'validate', error: '数据目录未提供' }],
    };
  }

  for (const root of logRoots) {
    const logsDir = path.join(root, 'logs');
    if (!fsModule.existsSync(logsDir)) continue;

    for (const name of CLEARABLE_LOG_FILES) {
      const filePath = path.join(logsDir, name);
      if (!fsModule.existsSync(filePath)) continue;
      try {
        fsModule.truncateSync(filePath, 0);
        truncated.push(name);
      } catch (err) {
        failures.push({ file: name, action: 'truncate', error: err.message });
      }
    }

    let names = [];
    try {
      names = fsModule.readdirSync(logsDir);
    } catch (err) {
      failures.push({ file: 'logs', action: 'list', error: err.message });
    }

    for (const name of names) {
      if (!isClearableLogArchive(name)) continue;
      try {
        fsModule.unlinkSync(path.join(logsDir, name));
        deleted.push(name);
      } catch (err) {
        failures.push({ file: name, action: 'delete', error: err.message });
      }
    }
  }

  return { ok: failures.length === 0, truncated, deleted, failures };
}

/**
 * 列出附件目录下的所有附件文件，按 session 分组
 * @param {string} dataDir - 数据目录绝对路径
 * @param {Object} [options] - 分页选项
 * @param {number} [options.limit] - 每页数量，默认 50
 * @param {number} [options.offset] - 偏移量，默认 0
 * @returns {{ groups: Object[], totalFiles: number, totalGroups: number, hasMore: boolean }}
 */
function listAttachments(dataDir, options) {
  const opts = options || {};
  const limit = Math.min(Math.max(opts.limit || 50, 1), 500);
  const offset = Math.max(opts.offset || 0, 0);
  const attachDir = path.join(dataDir, 'attachments');
  if (!fs.existsSync(attachDir)) {
    return { groups: [], totalFiles: 0, totalGroups: 0, hasMore: false };
  }

  const groups = [];
  let totalFiles = 0;
  let totalGroups = 0;

  try {
    const sessionDirs = fs.readdirSync(attachDir);
    totalGroups = sessionDirs.length;

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
    return { groups: [], totalFiles: 0, totalGroups: 0, hasMore: false };
  }

  const paginatedGroups = groups.slice(offset, offset + limit);
  const hasMore = offset + limit < groups.length;

  return { groups: paginatedGroups, totalFiles, totalGroups, hasMore };
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

/**
 * 验证文件完整性：计算文件的 SHA256 校验和
 * @param {string} filePath - 文件绝对路径
 * @returns {{ ok: boolean, sha256?: string, size?: number, error?: string }}
 */
function verifyFileIntegrity(filePath) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: '文件不存在' };
  }

  try {
    const stat = fs.statSync(filePath);
    const buffer = fs.readFileSync(filePath);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    return { ok: true, sha256, size: stat.size };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 日志轮转：当日志文件超过指定大小时，将其重命名为带时间戳的备份文件
 * @param {string} dataDir - 数据目录绝对路径
 * @param {Object} [options] - 轮转选项
 * @param {number} [options.maxSizeMB] - 最大大小（MB），默认 10
 * @param {number} [options.maxBackups] - 最大备份数，默认 5
 * @returns {{ ok: boolean, rotated?: string[], error?: string }}
 */
function rotateLogs(dataDir, options) {
  const opts = options || {};
  const maxSizeBytes = (opts.maxSizeMB || 10) * 1024 * 1024;
  const maxBackups = opts.maxBackups || 5;
  const logsDir = path.join(dataDir, 'logs');

  if (!fs.existsSync(logsDir)) {
    return { ok: true, rotated: [] };
  }

  const rotated = [];
  const logFiles = [LOG_FILE_OUT, LOG_FILE_ERR];

  for (const logFile of logFiles) {
    const logPath = path.join(logsDir, logFile);
    if (!fs.existsSync(logPath)) continue;

    try {
      const stat = fs.statSync(logPath);
      if (stat.size > maxSizeBytes) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = `${logFile}.${timestamp}`;
        const backupPath = path.join(logsDir, backupName);
        fs.renameSync(logPath, backupPath);
        rotated.push(backupName);

        const backups = fs.readdirSync(logsDir)
          .filter((f) => f.startsWith(logFile + '.'))
          .sort()
          .reverse();

        while (backups.length > maxBackups) {
          const oldBackup = backups.pop();
          try {
            fs.unlinkSync(path.join(logsDir, oldBackup));
          } catch (_e) {
            continue;
          }
        }
      }
    } catch (_e) {
      continue;
    }
  }

  return { ok: true, rotated };
}

/**
 * 清理指定 session 的附件
 * @param {string} dataDir - 数据目录绝对路径
 * @param {string} sessionId - 要清理的 session ID
 * @param {boolean} confirm - 是否确认清理
 * @returns {{ ok: boolean, cleaned?: string[], error?: string }}
 */
function cleanupSessionAttachments(dataDir, sessionId, confirm) {
  if (!confirm) {
    return { ok: false, error: '清理需要 confirm=true 确认' };
  }

  const attachDir = path.join(dataDir, 'attachments');
  const sessionPath = path.join(attachDir, sessionId);

  if (!fs.existsSync(sessionPath)) {
    return { ok: true, cleaned: [] };
  }

  const cleaned = [];
  try {
    const files = fs.readdirSync(sessionPath);
    for (const name of files) {
      const filePath = path.join(sessionPath, name);
      try {
        fs.unlinkSync(filePath);
        cleaned.push(name);
      } catch (_e) {
        continue;
      }
    }

    if (cleaned.length === files.length) {
      try {
        fs.rmdirSync(sessionPath);
      } catch (_e) {
        // 忽略删除目录失败
      }
    }
  } catch (_e) {
    return { ok: false, error: _e.message };
  }

  return { ok: true, cleaned };
}

module.exports = {
  safeResolve,
  readLogs,
  clearLogs,
  listAttachments,
  getAttachment,
  deleteAttachment,
  findOrphanAttachments,
  cleanupOrphanAttachments,
  verifyFileIntegrity,
  rotateLogs,
  cleanupSessionAttachments,
};
