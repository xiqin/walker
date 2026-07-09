const fs = require('fs');
const path = require('path');

function matchTomlString(raw, key) {
  const re = new RegExp('^\\s*' + key + '\\s*=\\s*"([^"]+)"', 'm');
  const m = raw.match(re);
  return m ? m[1] : '';
}

function loadEnvConfig(options) {
  const env = options.env || process.env;
  const ccConnectConfigPath = options.ccConnectConfigPath ||
    path.join(process.env.USERPROFILE || process.env.HOME || '.', '.cc-connect', 'config.toml');

  let feishuAppId = env.FEISHU_APP_ID || '';
  let feishuAppSecret = env.FEISHU_APP_SECRET || '';
  let feishuConfigSource = 'missing';

  if (!feishuAppId || !feishuAppSecret) {
    if (fs.existsSync(ccConnectConfigPath)) {
      try {
        const raw = fs.readFileSync(ccConnectConfigPath, 'utf8');
        const fromTomlAppId = matchTomlString(raw, 'app_id');
        const fromTomlAppSecret = matchTomlString(raw, 'app_secret');
        if (!feishuAppId && fromTomlAppId) { feishuAppId = fromTomlAppId; }
        if (!feishuAppSecret && fromTomlAppSecret) { feishuAppSecret = fromTomlAppSecret; }
        if (feishuAppId && feishuAppSecret) { feishuConfigSource = 'cc-connect'; }
      } catch (_) {}
    }
  } else {
    feishuConfigSource = 'env';
  }

  function parseBool(val, defaultVal) {
    if (val === undefined || val === '') return defaultVal;
    const s = String(val).toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }

  return {
    feishuAppId,
    feishuAppSecret,
    feishuConfigSource,
    feishuRouteMode: env.FEISHU_ROUTE_MODE || 'thread',
    walkerDataDir: env.WALKER_DATA_DIR || '',
    walkerDefaultAgent: env.WALKER_DEFAULT_AGENT || 'opencode',
    walkerDefaultRuntime: env.WALKER_DEFAULT_RUNTIME || 'windows',
    walkerDefaultCwd: env.WALKER_DEFAULT_CWD || '',
    walkerWslDistro: env.WALKER_WSL_DISTRO || 'Ubuntu-24.04',
    opencodeServerUrl: env.OPENCODE_SERVER_URL || '',
    opencodeServerAutostart: parseBool(env.OPENCODE_SERVER_AUTOSTART, true),
    opencodeCmd: env.OPENCODE_CMD || 'opencode',
    opencodeModel: env.OPENCODE_MODEL || '',
    opencodeAgent: env.OPENCODE_AGENT || '',
    feishuProgressStyle: env.FEISHU_PROGRESS_STYLE || 'card',
    feishuReactionEmoji: env.FEISHU_REACTION_EMOJI || 'OnIt',
    feishuDoneEmoji: env.FEISHU_DONE_EMOJI || 'none',
  };
}

module.exports = { loadEnvConfig, matchTomlString };
