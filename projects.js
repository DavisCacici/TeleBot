const fs = require('fs');
const path = require('path');
const { initDb, loadStateFromDb, saveStateToDb, saveLog } = require('./db');

const PROJECTS_DIR = process.env.PROJECTS_DIR || 'C:\\_SORGENTI';
const LEGACY_STATE_FILE = path.join(__dirname, 'data', 'state.json');

let state = {
  chats: [],
  activeProjectByChat: {},
  conversationsByProject: {},
  settings: {
    confirmOnlyWriteTools: true,
    notifyOnStop: true
  }
};

// Caricamento sincrono immediato da disco come fallback per garantire chats pronte
try {
  if (fs.existsSync(LEGACY_STATE_FILE)) {
    const legacyData = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, 'utf8'));
    state = { ...state, ...legacyData };
  }
} catch (e) {}

async function initState() {
  await initDb().catch(() => {});
  try {
    const dbState = await loadStateFromDb();
    if (dbState) {
      state = { ...state, ...dbState };
    } else if (fs.existsSync(LEGACY_STATE_FILE)) {
      // Migrazione automatica iniziale se esisteva data/state.json
      const legacyData = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, 'utf8'));
      state = { ...state, ...legacyData };
      await saveStateToDb(state).catch(() => {});
      await saveLog({
        level: 'INFO',
        eventType: 'state_migrated',
        message: 'Stato migrato dalla cartella data a PostgreSQL',
        payload: state
      }).catch(() => {});
    }
  } catch (err) {
    console.error('Errore durante il caricamento dello stato da DB:', err);
  }
}

function saveState(eventType = 'state_update', details = {}) {
  saveStateToDb(state);
  saveLog({
    level: 'INFO',
    eventType,
    chatId: details.chatId || null,
    projectName: details.projectName || null,
    conversationId: details.conversationId || null,
    message: details.message || 'Aggiornamento stato bot',
    payload: state
  });
}

function registerChat(chatId) {
  const numId = Number(chatId);
  const currentChats = (state.chats || []).map(Number);
  if (!currentChats.includes(numId)) {
    state.chats = [...new Set([...currentChats, numId])];
    saveState('chat_registered', {
      chatId: numId,
      message: `Nuova chat registrata: ${numId}`
    });
  } else if (state.chats.length !== new Set(currentChats).size) {
    state.chats = [...new Set(currentChats)];
    saveStateToDb(state);
  }
}

function getChats() {
  return [...new Set((state.chats || []).map(Number))];
}

function listProjects() {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) {
      return [];
    }
    const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map(entry => ({
        name: entry.name,
        path: path.join(PROJECTS_DIR, entry.name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    console.error('Errore durante la lettura dei progetti:', err);
    return [];
  }
}

function ensureGlobalTelegramHook() {
  try {
    const os = require('os');
    const globalConfigDir = path.join(os.homedir(), '.gemini', 'config');
    const globalHookFile = path.join(globalConfigDir, 'hooks.json');

    if (!fs.existsSync(globalConfigDir)) {
      fs.mkdirSync(globalConfigDir, { recursive: true });
    }

    let globalConfig = {};
    if (fs.existsSync(globalHookFile)) {
      try {
        globalConfig = JSON.parse(fs.readFileSync(globalHookFile, 'utf8').replace(/^\uFEFF/, ''));
      } catch (e) {}
    }

    globalConfig['telegram-bot'] = {
      "PreInvocation": [
        {
          "type": "command",
          "command": "node C:\\_SORGENTI\\TeleBot\\hook.js PreInvocation",
          "timeout": 15
        }
      ],
      "PreToolUse": [
        {
          "matcher": "*",
          "hooks": [
            {
              "type": "command",
              "command": "node C:\\_SORGENTI\\TeleBot\\hook.js PreToolUse",
              "timeout": 75
            }
          ]
        }
      ],
      "Stop": [
        {
          "type": "command",
          "command": "node C:\\_SORGENTI\\TeleBot\\hook.js Stop",
          "timeout": 15
        }
      ]
    };

    fs.writeFileSync(globalHookFile, JSON.stringify(globalConfig, null, 2), 'utf8');
  } catch (err) {
    console.error('Errore durante la configurazione dell\'hook globale:', err);
  }
}

function ensureProjectHook(projectPath) {
  try {
    if (!fs.existsSync(projectPath)) return;
    const agentsDir = path.join(projectPath, '.agents');
    const hookFile = path.join(agentsDir, 'hooks.json');

    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, { recursive: true });
    }

    let existing = {};
    if (fs.existsSync(hookFile)) {
      try {
        existing = JSON.parse(fs.readFileSync(hookFile, 'utf8').replace(/^\uFEFF/, ''));
      } catch (e) {}
    }

    const hookConfig = {
      ...existing,
      "telegram-bot": {
        "PreInvocation": [
          {
            "type": "command",
            "command": "node C:\\_SORGENTI\\TeleBot\\hook.js PreInvocation",
            "timeout": 15
          }
        ],
        "PreToolUse": [
          {
            "matcher": "*",
            "hooks": [
              {
                "type": "command",
                "command": "node C:\\_SORGENTI\\TeleBot\\hook.js PreToolUse",
                "timeout": 75
              }
            ]
          }
        ],
        "Stop": [
          {
            "type": "command",
            "command": "node C:\\_SORGENTI\\TeleBot\\hook.js Stop",
            "timeout": 15
          }
        ]
      }
    };
    fs.writeFileSync(hookFile, JSON.stringify(hookConfig, null, 2), 'utf8');
  } catch (err) {
    console.error('Errore durante la configurazione degli hook nel progetto:', err);
  }
}

// Configura hook sia a livello globale che nei progetti noti
try {
  ensureGlobalTelegramHook();
  for (const p of listProjects()) {
    ensureProjectHook(p.path);
  }
} catch (e) {}

function setActiveProject(chatId, projectName) {
  state.activeProjectByChat[chatId] = projectName;
  saveState('project_selected', {
    chatId,
    projectName,
    message: `Progetto attivo impostato su "${projectName}"`
  });
  const projectPath = path.join(PROJECTS_DIR, projectName);
  ensureProjectHook(projectPath);
}

function getActiveProject(chatId) {
  const projectName = state.activeProjectByChat[chatId];
  if (!projectName) return null;
  const projectPath = path.join(PROJECTS_DIR, projectName);
  return {
    name: projectName,
    path: projectPath,
    exists: fs.existsSync(projectPath)
  };
}

function getConversation(projectName) {
  return state.conversationsByProject[projectName] || null;
}

function setConversation(projectName, conversationId) {
  state.conversationsByProject[projectName] = conversationId;
  saveState('conversation_updated', {
    projectName,
    conversationId,
    message: `Conversazione aggiornata per "${projectName}"`
  });
}

function clearConversation(projectName) {
  delete state.conversationsByProject[projectName];
  saveState('conversation_cleared', {
    projectName,
    message: `Sessione resettata per "${projectName}"`
  });
}

function getProjectByConversation(conversationId) {
  if (!conversationId || !state.conversationsByProject) return null;
  for (const [projectName, convId] of Object.entries(state.conversationsByProject)) {
    if (convId === conversationId) return projectName;
  }
  return null;
}

function getSelectedModel(chatId) {
  if (state.modelByChat && state.modelByChat[chatId]) {
    return state.modelByChat[chatId];
  }
  return (state.settings && state.settings.model) || null;
}

function setSelectedModel(chatId, modelId) {
  if (!state.modelByChat) state.modelByChat = {};
  if (!state.settings) state.settings = {};

  if (!modelId || modelId === 'default') {
    delete state.modelByChat[chatId];
    delete state.settings.model;
  } else {
    state.modelByChat[chatId] = modelId;
    state.settings.model = modelId;
  }

  saveState('model_changed', {
    chatId,
    message: `Modello impostato su "${modelId || 'default'}"`
  });
}

function getVoiceSettings(chatId) {
  const globalVoice = state.settings?.voice || {};
  const chatVoice = state.voiceByChat?.[chatId] || {};
  return {
    ttsEnabled: chatVoice.ttsEnabled !== undefined ? chatVoice.ttsEnabled : (globalVoice.ttsEnabled || false),
    autoRun: chatVoice.autoRun !== undefined ? chatVoice.autoRun : (globalVoice.autoRun !== undefined ? globalVoice.autoRun : true),
    apiKey: chatVoice.apiKey || globalVoice.apiKey || process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || null,
    provider: chatVoice.provider || globalVoice.provider || 'auto'
  };
}

function setVoiceSettings(chatId, newSettings) {
  if (!state.voiceByChat) state.voiceByChat = {};
  if (!state.settings) state.settings = {};
  if (!state.settings.voice) state.settings.voice = {};

  const current = getVoiceSettings(chatId);
  const updated = { ...current, ...newSettings };

  state.voiceByChat[chatId] = updated;

  // Se viene salvata una chiave globale/per chat
  if (newSettings.apiKey) {
    state.settings.voice.apiKey = newSettings.apiKey;
  }
  if (newSettings.provider) {
    state.settings.voice.provider = newSettings.provider;
  }

  saveState('voice_settings_changed', {
    chatId,
    message: `Impostazioni vocali aggiornate per chat ${chatId}`
  });

  return updated;
}

function setRestartNotifyChat(chatId) {
  state.restartNotifyChat = chatId;
  saveState('restart_requested', {
    chatId,
    message: 'Richiesta di riavvio inviata da Telegram'
  });
}

function popRestartNotifyChat() {
  const chatId = state.restartNotifyChat;
  if (chatId) {
    delete state.restartNotifyChat;
    saveStateToDb(state);
    return chatId;
  }
  return null;
}

module.exports = {
  PROJECTS_DIR,
  initState,
  registerChat,
  getChats,
  listProjects,
  ensureProjectHook,
  setActiveProject,
  getActiveProject,
  getConversation,
  getProjectByConversation,
  setConversation,
  clearConversation,
  getSelectedModel,
  setSelectedModel,
  getVoiceSettings,
  setVoiceSettings,
  setRestartNotifyChat,
  popRestartNotifyChat
};
