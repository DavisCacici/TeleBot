const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureProjectHook } = require('./projects');

let activeProcesses = new Map(); // chatId -> ChildProcess

function cleanStaleLock(conversationId) {
  if (!conversationId) return;
  try {
    const lockPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'presence', `${conversationId}.lock`);
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch (e) {}
}

function resolveAgyCommand() {
  if (process.env.AGY_PATH && fs.existsSync(process.env.AGY_PATH)) {
    return process.env.AGY_PATH;
  }

  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe'),
      path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
      'C:\\Users\\davis.cacici\\AppData\\Local\\agy\\bin\\agy.exe'
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) {
        return c;
      }
    }
    return 'agy.exe';
  }

  return process.env.AGY_PATH || 'agy';
}

const DEFAULT_MODELS = [
  { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
  { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
  { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
  { id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)' },
  { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' },
  { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
  { id: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)' },
  { id: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low)' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }
];

function getAvailableModels() {
  return DEFAULT_MODELS;
}

function getModelLabel(modelId) {
  if (!modelId || modelId === 'default') return 'Predefinito (Auto)';
  const found = DEFAULT_MODELS.find(m => m.id === modelId);
  return found ? found.label : modelId;
}

function runAgentPrompt({ prompt, cwd, conversationId, chatId, model, onOutput }) {
  return new Promise((resolve, reject) => {
    // Assicura che il progetto abbia gli hook Telegram configurati
    if (cwd) {
      ensureProjectHook(cwd);
    }

    // Pulisce lock residui da sessioni interrotte per non bloccare agy
    cleanStaleLock(conversationId);

    const agyCmd = resolveAgyCommand();

    // Rileva se il bot è avviato dentro un container Docker
    const isDocker = fs.existsSync('/.dockerenv');
    if (isDocker && !fs.existsSync(agyCmd)) {
      return reject(new Error(
        "L'eseguibile Antigravity CLI ('agy') è presente solo sul sistema host Windows (C:\\Users\\...\\agy.exe) e non dentro il container Docker Linux. Per consentire al bot di lanciare agy, eseguilo dall'host con 'node index.js' (puoi usare Docker per PostgreSQL)."
      ));
    }

    // Usiamo --dangerously-skip-permissions poiché le autorizzazioni
    // vengono gestite e approvate tramite l'hook Telegram interattivo.
    const args = ['--output-format', 'json', '--dangerously-skip-permissions'];

    if (model && model !== 'default') {
      args.push('--model', model);
    }

    if (conversationId) {
      args.push('--conversation', conversationId);
    }

    args.push(`--print=${prompt}`);

    const child = spawn(agyCmd, args, {
      cwd,
      shell: false,
      env: { ...process.env, AGY_FROM_TELEGRAM: '1' }
    });

    if (chatId) {
      activeProcesses.set(chatId, child);
    }

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => {
      const str = data.toString();
      stdout += str;
      if (onOutput) onOutput(str);
    });

    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    child.on('error', err => {
      if (chatId) activeProcesses.delete(chatId);
      cleanStaleLock(conversationId);
      reject(err);
    });

    child.on('close', code => {
      if (chatId) activeProcesses.delete(chatId);
      cleanStaleLock(conversationId);

      const cleanStdout = stdout.trim().replace(/^\uFEFF/, '');
      let parsed = null;
      try {
        parsed = JSON.parse(cleanStdout);
      } catch (err) {
        parsed = {
          response: cleanStdout || stderr || 'Nessuna risposta ricevuta dall\'agente.',
          status: code === 0 ? 'SUCCESS' : 'ERROR',
          code
        };
      }
      resolve(parsed);
    });
  });
}

function cancelRunningProcess(chatId) {
  const proc = activeProcesses.get(chatId);
  if (proc) {
    try {
      proc.kill('SIGINT');
    } catch (e) {}
    activeProcesses.delete(chatId);
    return true;
  }
  return false;
}

module.exports = {
  runAgentPrompt,
  cancelRunningProcess,
  getAvailableModels,
  getModelLabel
};
