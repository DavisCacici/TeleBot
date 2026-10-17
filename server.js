const http = require('http');
const path = require('path');
const { getChats, PROJECTS_DIR } = require('./projects');
const { saveLog } = require('./db');
const {
  recordSessionStart,
  recordSessionTool,
  recordSessionStop
} = require('./sessions');

const PORT = parseInt(process.env.HOOK_PORT || '37482', 10);

// Mappa delle conferme in attesa: requestId -> { res, timer, projectName, toolName, sentMessages }
const pendingRequests = new Map();

// Riferimento al bot telegram passato all'avvio
let telegramBot = null;

function setBotInstance(bot) {
  telegramBot = bot;
}

function getProjectFromWorkspaces(workspacePaths) {
  if (!workspacePaths || !workspacePaths.length) return 'Antigravity Workspace';
  const firstPath = workspacePaths[0];
  const basename = path.basename(firstPath);
  return basename || firstPath;
}

function isActionTool(toolName) {
  const actionTools = [
    'run_command',
    'write_to_file',
    'replace_file_content',
    'multi_replace_file_content',
    'ask_question',
    'manage_task',
    'generate_image'
  ];
  return actionTools.includes(toolName);
}

function formatToolDetails(toolCall) {
  if (!toolCall) return 'Nessun dettaglio';
  const name = toolCall.name;
  const args = toolCall.args || {};

  switch (name) {
    case 'run_command':
      return `<b>Comando:</b> <code>${escapeHtml(args.CommandLine || '')}</code>`;
    case 'write_to_file':
      return `<b>Scrittura file:</b> <code>${escapeHtml(args.TargetFile || '')}</code>\n${args.Description ? `<i>${escapeHtml(args.Description)}</i>` : ''}`;
    case 'replace_file_content':
    case 'multi_replace_file_content':
      return `<b>Modifica file:</b> <code>${escapeHtml(args.TargetFile || '')}</code>\n${args.Description ? `<i>${escapeHtml(args.Description)}</i>` : ''}`;
    case 'ask_question':
      return `<b>Domanda:</b> ${escapeHtml(JSON.stringify(args.questions || ''))}`;
    default:
      return `<b>Argomenti:</b> <pre>${escapeHtml(JSON.stringify(args, null, 2).slice(0, 500))}</pre>`;
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Cache per deduplicare hook ravvicinati (evita notifiche doppie se un hook viene invocato due volte)
const recentHookCalls = new Map();

function isDuplicateHook(hookType, payload) {
  const convId = payload?.conversationId || '';
  const toolName = payload?.toolCall?.name || '';
  const toolArgs = payload?.toolCall?.args ? JSON.stringify(payload.toolCall.args) : '';
  const key = `${hookType}:${convId}:${toolName}:${toolArgs}`;
  const now = Date.now();
  const prev = recentHookCalls.get(key);
  if (prev && now - prev < 3000) {
    return true;
  }
  recentHookCalls.set(key, now);
  // Pulizia periodica
  if (recentHookCalls.size > 200) {
    for (const [k, ts] of recentHookCalls.entries()) {
      if (now - ts > 10000) recentHookCalls.delete(k);
    }
  }
  return false;
}

function startHookServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.writeHead(404);
      return res.end();
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let data = {};
      try {
        data = JSON.parse(body || '{}');
      } catch (err) {
        res.writeHead(400);
        return res.end('Invalid JSON');
      }

      const { hookType, fromTelegram, payload } = data;

      // Se lo stesso hook arriva due volte in meno di 3s, ignora il duplicato
      if (isDuplicateHook(hookType, payload)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (hookType === 'PreToolUse') {
          return res.end(JSON.stringify({ decision: 'allow' }));
        }
        return res.end('{}');
      }

      const workspacePaths = payload?.workspacePaths || [];
      const projectName = getProjectFromWorkspaces(workspacePaths);

      saveLog({
        level: 'INFO',
        eventType: `hook_${hookType || 'unknown'}`,
        projectName,
        conversationId: payload?.conversationId || null,
        message: `Hook chiamato: ${hookType}`,
        payload
      }).catch(() => {});

      if (hookType === 'PreInvocation') {
        handlePreInvocation(payload, res, fromTelegram);
      } else if (hookType === 'PreToolUse') {
        handlePreToolUse(payload, res);
      } else if (hookType === 'Stop') {
        handleStop(payload, res, fromTelegram);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`⚠️ Porta ${PORT} già in uso da un'altra istanza del bot! Chiudo questa istanza duplicata per evitare doppie notifiche.`);
      process.exit(1);
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Hook server in ascolto su http://127.0.0.1:${PORT}`);
  });

  return server;
}

async function handlePreInvocation(payload, res, fromTelegram = false) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{}');

  const conversationId = payload.conversationId;
  const workspacePaths = payload.workspacePaths || [];
  const projectName = getProjectFromWorkspaces(workspacePaths);
  const modelName = payload.modelName || 'auto';

  // Registra la sessione tra quelle attive
  recordSessionStart({
    conversationId,
    projectName,
    workspacePaths,
    modelName,
    source: fromTelegram ? 'Telegram' : 'Antigravity IDE / CLI'
  });

  // Se il prompt è stato lanciato direttamente da Telegram, index.js invia già "🚀 Esecuzione avviata"
  if (fromTelegram) return;

  const chats = getChats();
  if (!telegramBot || chats.length === 0) return;

  const text =
    `🚀 <b>Nuova attività avviata</b>\n` +
    `📁 <b>Progetto:</b> <code>${escapeHtml(projectName)}</code>\n` +
    `🤖 <b>Modello:</b> <code>${escapeHtml(modelName)}</code>\n` +
    `🆔 <b>Sessione:</b> <code>${escapeHtml(conversationId || 'N/A')}</code>`;

  for (const chatId of chats) {
    try {
      await telegramBot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (err) {
      console.error(`Errore invio notifica pre-invocation a ${chatId}:`, err.message);
    }
  }
}

async function handlePreToolUse(payload, res) {
  const toolCall = payload.toolCall || {};
  const toolName = toolCall.name || 'unknown';
  const workspacePaths = payload.workspacePaths || [];
  const projectName = getProjectFromWorkspaces(workspacePaths);
  const conversationId = payload.conversationId;

  // Registra il tool in esecuzione per la sessione
  recordSessionTool(conversationId, toolName, toolCall.args);

  // Se è un tool di sola lettura, auto-approva immediatamente senza disturbare
  if (!isActionTool(toolName)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ decision: 'allow' }));
  }

  const chats = getChats();
  if (!telegramBot || chats.length === 0) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ decision: 'allow' }));
  }

  const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const sentMessages = [];

  // TIMEOUT A 60 SECONDI (1 MINUTO): Se l'utente non preme nulla, accetta di DEFAULT
  const timer = setTimeout(async () => {
    if (pendingRequests.has(requestId)) {
      pendingRequests.delete(requestId);

      saveLog({
        level: 'INFO',
        eventType: 'permission_auto_approved',
        projectName,
        conversationId,
        message: `Auto-approvato per timeout (60s) il tool ${toolName}`,
        payload: { requestId, toolName, toolCall }
      }).catch(() => {});

      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // ACCETTAZIONE DI DEFAULT DOPO 1 MINUTO
        res.end(JSON.stringify({ decision: 'allow' }));
      } catch (e) {}

      // Aggiorna i messaggi su Telegram
      for (const sent of sentMessages) {
        try {
          await telegramBot.telegram.editMessageText(
            sent.chatId,
            sent.messageId,
            null,
            sent.originalText + '\n\n⏰ <b>ACCETTATO DI DEFAULT (Timeout 1 minuto)</b>',
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
          );
        } catch (e) {}
      }
    }
  }, 60000);

  pendingRequests.set(requestId, { res, timer, projectName, toolName, sentMessages });

  const messageText = 
    `⚠️ <b>Richiesta di conferma</b>\n` +
    `📁 <b>Progetto:</b> <code>${escapeHtml(projectName)}</code>\n` +
    `🔧 <b>Tool:</b> <code>${escapeHtml(toolName)}</code>\n\n` +
    `${formatToolDetails(toolCall)}\n\n` +
    `<i>Se non premi nulla entro 1 minuto, verrà accettato automaticamente di default.</i>`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Approva ora', callback_data: `perm:allow:${requestId}` },
        { text: '❌ Rifiuta', callback_data: `perm:deny:${requestId}` }
      ]
    ]
  };

  for (const chatId of chats) {
    try {
      const msg = await telegramBot.telegram.sendMessage(chatId, messageText, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
      sentMessages.push({
        chatId,
        messageId: msg.message_id,
        originalText: messageText
      });
    } catch (err) {
      console.error(`Errore invio notifica conferma a ${chatId}:`, err.message);
    }
  }
}

async function handleStop(payload, res, fromTelegram = false) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{}');

  const conversationId = payload.conversationId;
  const workspacePaths = payload.workspacePaths || [];
  const projectName = getProjectFromWorkspaces(workspacePaths);
  const terminationReason = payload.terminationReason || 'completato';
  const error = payload.error;

  // Aggiorna lo stato della sessione a completata
  recordSessionStop(conversationId, { terminationReason, error });

  // Se il prompt è stato lanciato da Telegram, index.js invia già la risposta finale (o l'errore)
  if (fromTelegram && !error) return;

  const chats = getChats();
  if (!telegramBot || chats.length === 0) return;

  let messageText = '';
  if (error) {
    messageText = 
      `❌ <b>Attività interrotta con errore</b>\n` +
      `📁 <b>Progetto:</b> <code>${escapeHtml(projectName)}</code>\n` +
      `🆔 <b>Sessione:</b> <code>${escapeHtml(conversationId || 'N/A')}</code>\n` +
      `⚠️ <b>Errore:</b> <code>${escapeHtml(error)}</code>`;
  } else {
    messageText = 
      `🏁 <b>Sessione completata!</b>\n` +
      `📁 <b>Progetto:</b> <code>${escapeHtml(projectName)}</code>\n` +
      `🆔 <b>Sessione:</b> <code>${escapeHtml(conversationId || 'N/A')}</code>\n` +
      `✨ <b>Stato:</b> L'agente ha terminato l'attività (<code>${escapeHtml(terminationReason)}</code>).`;
  }

  for (const chatId of chats) {
    try {
      await telegramBot.telegram.sendMessage(chatId, messageText, { parse_mode: 'HTML' });
    } catch (err) {
      console.error(`Errore invio notifica completamento a ${chatId}:`, err.message);
    }
  }
}

function resolvePendingRequest(requestId, decision) {
  if (!pendingRequests.has(requestId)) {
    return false;
  }
  const pending = pendingRequests.get(requestId);
  clearTimeout(pending.timer);
  pendingRequests.delete(requestId);

  try {
    pending.res.writeHead(200, { 'Content-Type': 'application/json' });
    if (decision === 'allow') {
      pending.res.end(JSON.stringify({ decision: 'allow' }));
    } else {
      pending.res.end(JSON.stringify({
        decision: 'deny',
        reason: 'Operazione rifiutata dall\'utente su Telegram'
      }));
    }
    return true;
  } catch (err) {
    console.error('Errore durante la risoluzione della richiesta:', err);
    return false;
  }
}

module.exports = {
  startHookServer,
  setBotInstance,
  resolvePendingRequest
};
