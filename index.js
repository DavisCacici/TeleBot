require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Telegraf } = require('telegraf');
const {
  PROJECTS_DIR,
  initState,
  registerChat,
  listProjects,
  setActiveProject,
  getActiveProject,
  getConversation,
  setConversation,
  clearConversation,
  getSelectedModel,
  setSelectedModel,
  getVoiceSettings,
  setVoiceSettings,
  setRestartNotifyChat,
  popRestartNotifyChat
} = require('./projects');
const {
  runAgentPrompt,
  cancelRunningProcess,
  getAvailableModels,
  getModelLabel
} = require('./agent');
const { startHookServer, setBotInstance, resolvePendingRequest } = require('./server');
const { saveLog } = require('./db');
const { getActiveSessions, scanAllSessions } = require('./sessions');
const {
  textToSpeech,
  transcribeAudio,
  getVoiceStatusDetails,
  getVoiceInlineKeyboard,
  resolveSTTProvider
} = require('./voice');

const bot = new Telegraf(process.env.BOT_TOKEN || 'IL_TUO_TOKEN_QUI');

// Middleware per evitare l'elaborazione doppia dello stesso update o messaggio
const processedUpdates = new Set();
bot.use((ctx, next) => {
  const updateId = ctx.update?.update_id;
  if (updateId) {
    if (processedUpdates.has(updateId)) {
      return;
    }
    processedUpdates.add(updateId);
    if (processedUpdates.size > 500) {
      const first = processedUpdates.values().next().value;
      processedUpdates.delete(first);
    }
  }
  return next();
});

// Collega il server hook al bot
setBotInstance(bot);
startHookServer();

const PAGE_SIZE = 6;

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Helper per generare la tastiera dei modelli disponibili
function getModelsKeyboard(currentModel = null) {
  const models = getAvailableModels();
  const inline_keyboard = [];

  const isDefault = !currentModel || currentModel === 'default';
  inline_keyboard.push([
    {
      text: `${isDefault ? '✅ ' : '⚙️ '}Predefinito (Auto)`,
      callback_data: 'sel_model:default'
    }
  ]);

  for (let i = 0; i < models.length; i += 2) {
    const row = [];
    const m1 = models[i];
    const isSel1 = currentModel === m1.id;
    row.push({
      text: `${isSel1 ? '✅ ' : '🤖 '}${m1.label}`,
      callback_data: `sel_model:${m1.id}`
    });

    if (i + 1 < models.length) {
      const m2 = models[i + 1];
      const isSel2 = currentModel === m2.id;
      row.push({
        text: `${isSel2 ? '✅ ' : '🤖 '}${m2.label}`,
        callback_data: `sel_model:${m2.id}`
      });
    }
    inline_keyboard.push(row);
  }

  return inline_keyboard;
}

// Helper per generare la tastiera dei progetti con paginazione
function getProjectsKeyboard(page = 0, currentProject = null) {
  const projects = listProjects();
  const totalPages = Math.ceil(projects.length / PAGE_SIZE) || 1;
  const safePage = Math.max(0, Math.min(page, totalPages - 1));

  const start = safePage * PAGE_SIZE;
  const pageProjects = projects.slice(start, start + PAGE_SIZE);

  const inline_keyboard = [];

  // Pulsanti progetti (2 per riga)
  for (let i = 0; i < pageProjects.length; i += 2) {
    const row = [];
    const p1 = pageProjects[i];
    const isCurrent1 = currentProject && currentProject.name === p1.name;
    row.push({
      text: `${isCurrent1 ? '📌 ' : '📁 '}${p1.name}`,
      callback_data: `sel_proj:${p1.name}`
    });

    if (i + 1 < pageProjects.length) {
      const p2 = pageProjects[i + 1];
      const isCurrent2 = currentProject && currentProject.name === p2.name;
      row.push({
        text: `${isCurrent2 ? '📌 ' : '📁 '}${p2.name}`,
        callback_data: `sel_proj:${p2.name}`
      });
    }
    inline_keyboard.push(row);
  }

  // Riga di paginazione se ci sono più pagine
  const navRow = [];
  if (safePage > 0) {
    navRow.push({ text: '⬅️ Indietro', callback_data: `proj_page:${safePage - 1}` });
  }
  navRow.push({ text: `📄 ${safePage + 1}/${totalPages}`, callback_data: 'noop' });
  if (safePage < totalPages - 1) {
    navRow.push({ text: 'Avanti ➡️', callback_data: `proj_page:${safePage + 1}` });
  }
  inline_keyboard.push(navRow);

  return inline_keyboard;
}

// Invia messaggi lunghi suddivisi in blocchi max 4000 caratteri
async function sendLongMessage(ctx, text) {
  if (!text) {
    return ctx.reply('*(Nessun output)*', { parse_mode: 'Markdown' });
  }

  const MAX_LEN = 3900;
  if (text.length <= MAX_LEN) {
    try {
      return await ctx.reply(text, { parse_mode: 'Markdown' });
    } catch (e) {
      return await ctx.reply(text);
    }
  }

  // Suddivide il testo preservando i paragrafi
  let remaining = text;
  while (remaining.length > 0) {
    let chunk = remaining.slice(0, MAX_LEN);
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline > MAX_LEN * 0.7 && remaining.length > MAX_LEN) {
      chunk = remaining.slice(0, lastNewline);
      remaining = remaining.slice(lastNewline + 1);
    } else {
      remaining = remaining.slice(chunk.length);
    }

    try {
      await ctx.reply(chunk, { parse_mode: 'Markdown' });
    } catch (e) {
      await ctx.reply(chunk);
    }
  }
}

// Comando /start
bot.start((ctx) => {
  const chatId = ctx.chat.id;
  registerChat(chatId);

  const active = getActiveProject(chatId);
  const currentModel = getSelectedModel(chatId);
  const activeText = active ? `\n📌 <b>Progetto attivo:</b> <code>${active.name}</code>` : '';
  const modelText = `\n🤖 <b>Modello attivo:</b> <code>${escapeHtml(getModelLabel(currentModel))}</code>`;

  ctx.reply(
    `👋 <b>Benvenuto nel Bot Antigravity!</b>\n` +
    `Questo bot ti permette di gestire i tuoi progetti e sessioni di sviluppo da remoto.${activeText}${modelText}\n\n` +
    `<b>Comandi principali:</b>\n` +
    `• /progetti - Mostra e seleziona un progetto da <code>${PROJECTS_DIR}</code>\n` +
    `• /voice - Gestisci il riconoscimento vocale e le risposte audio\n` +
    `• /model - Cambia il modello AI usato dall'agente\n` +
    `• /sessioni - Mostra le sessioni attive e le ultime 3 recenti (IDE & CLI compresi)\n` +
    `• /stato - Dettagli sul progetto attivo, modello e sessione\n` +
    `• /nuova - Avvia una nuova sessione (resetta la cronologia per il progetto)\n` +
    `• /logs - Visualizza gli ultimi log di esecuzione (make bg-logs)\n` +
    `• /restart - Riavvia il bot e i servizi da remoto (make bg-restart)\n` +
    `• /stop - Annulla l'esecuzione in corso\n` +
    `• /help - Mostra l'elenco dei comandi disponibili\n\n` +
    `Una volta selezionato un progetto, <b>invia un messaggio di testo o una nota vocale 🎙️</b> per lanciare un prompt! Riceverai notifiche e potrai approvare comandi e visualizzare quando l'attività termina.`,
    { parse_mode: 'HTML' }
  );
});

// Comando /help o /aiuto
bot.command(['help', 'aiuto'], (ctx) => {
  const chatId = ctx.chat.id;
  registerChat(chatId);

  const active = getActiveProject(chatId);
  const currentModel = getSelectedModel(chatId);
  const activeText = active ? `\n📌 <b>Progetto attivo:</b> <code>${active.name}</code>` : '';
  const modelText = `\n🤖 <b>Modello attivo:</b> <code>${escapeHtml(getModelLabel(currentModel))}</code>\n`;

  ctx.reply(
    `📖 <b>Guida ai Comandi - Bot Antigravity</b>${activeText}${modelText}\n` +
    `<b>Comandi principali:</b>\n` +
    `• /start - Messaggio di benvenuto e panoramica iniziale\n` +
    `• /progetti (o /projects) - Sfoglia e seleziona un progetto da <code>${PROJECTS_DIR}</code>\n` +
    `• /voice (o /voce) - Gestione comandi vocali, trascrizione e risposte audio\n` +
    `• /model (o /modello) - Scegli il modello AI (es. Gemini 4 Argon, Gemini 3.8 Flash, Claude 5.5)\n` +
    `• /sessioni (o /sessions) - Visualizza le sessioni attive e le ultime 3 recenti (IDE, CLI e Telegram)\n` +
    `• /stato (o /status) - Mostra informazioni sul progetto attivo, modello e conversazione\n` +
    `• /nuova (o /new) - Resetta la sessione corrente per iniziare una nuova conversazione\n` +
    `• /logs (o /log) - Mostra gli ultimi log di esecuzione del bot (make bg-logs)\n` +
    `• /restart (o /riavvia) - Ricarica e riavvia il bot da remoto (make bg-restart)\n` +
    `• /stop (o /annulla) - Interrompe l'esecuzione dell'agente attualmente in corso\n` +
    `• /help (o /aiuto) - Mostra questo elenco di comandi\n\n` +
    `💡 <b>Come inviare un prompt:</b>\n` +
    `Dopo aver selezionato un progetto con /progetti:\n` +
    `• Scrivi un normale messaggio di testo in chat\n` +
    `• Oppure <b>invia direttamente un messaggio vocale 🎙️</b> di Telegram per dettare il prompt all'agente!`,
    { parse_mode: 'HTML' }
  );
});

// Comando /progetti o /projects
bot.command(['progetti', 'projects'], (ctx) => {
  const chatId = ctx.chat.id;
  registerChat(chatId);
  const active = getActiveProject(chatId);

  const projects = listProjects();
  if (projects.length === 0) {
    return ctx.reply(`⚠️ Nessun progetto trovato nella cartella:\n<code>${PROJECTS_DIR}</code>`, {
      parse_mode: 'HTML'
    });
  }

  const keyboard = getProjectsKeyboard(0, active);
  const activeInfo = active ? `📌 <b>Progetto attivo:</b> <code>${active.name}</code>\n\n` : '';

  ctx.reply(
    `${activeInfo}📂 <b>Seleziona un progetto:</b>\nScegli il progetto su cui vuoi lavorare per inviare i prompt:`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
});

// Paginazione progetti
bot.action(/^proj_page:(\d+)$/, (ctx) => {
  const page = parseInt(ctx.match[1], 10);
  const chatId = ctx.chat.id;
  const active = getActiveProject(chatId);
  const keyboard = getProjectsKeyboard(page, active);

  ctx.editMessageReplyMarkup({ inline_keyboard: keyboard }).catch(() => {});
  ctx.answerCbQuery().catch(() => {});
});

// Selezione progetto
bot.action(/^sel_proj:(.+)$/, (ctx) => {
  const projectName = ctx.match[1];
  const chatId = ctx.chat.id;
  setActiveProject(chatId, projectName);

  const active = getActiveProject(chatId);
  const conversationId = getConversation(projectName);

  ctx.answerCbQuery(`Progetto "${projectName}" selezionato!`).catch(() => {});

  ctx.reply(
    `✅ <b>Progetto impostato:</b> <code>${projectName}</code>\n` +
    `📁 <b>Percorso:</b> <code>${active.path}</code>\n` +
    `💬 <b>Sessione:</b> ${conversationId ? `<code>${conversationId}</code> (attiva)` : '<i>Nuova (verrà avviata al primo prompt)</i>'}\n\n` +
    `✍️ <b>Scrivi pure il tuo messaggio/prompt</b> qui sotto per iniziare!`,
    { parse_mode: 'HTML' }
  );
});

// Callback conferma autorizzazione permessi (Approva / Rifiuta)
bot.action(/^perm:(allow|deny):(.+)$/, async (ctx) => {
  const decision = ctx.match[1];
  const reqId = ctx.match[2];

  const ok = resolvePendingRequest(reqId, decision);
  if (ok) {
    const isAllow = decision === 'allow';
    ctx.answerCbQuery(isAllow ? 'Approvato!' : 'Rifiutato!').catch(() => {});
    
    // Aggiorna il messaggio originale
    const originalText = ctx.callbackQuery.message.text || '';
    const statusLine = isAllow ? '\n\n✅ <b>APPROVATO DALL\'UTENTE</b>' : '\n\n❌ <b>RIFIUTATO DALL\'UTENTE</b>';
    
    ctx.editMessageText(originalText + statusLine, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] }
    }).catch(() => {});
  } else {
    ctx.answerCbQuery('Richiesta scaduta o già elaborata.').catch(() => {});
    ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  }
});

// Nessuna azione per pulsanti informativi
bot.action('noop', (ctx) => {
  ctx.answerCbQuery().catch(() => {});
});

// Comando /model o /modello o /models
bot.command(['model', 'modello', 'models'], (ctx) => {
  const chatId = ctx.chat.id;
  registerChat(chatId);

  const parts = (ctx.message.text || '').trim().split(/\s+/);
  const argModel = parts[1] ? parts[1].trim() : null;

  if (argModel) {
    setSelectedModel(chatId, argModel);
    const label = getModelLabel(argModel);
    return ctx.reply(
      `✅ <b>Modello aggiornato:</b> <code>${escapeHtml(label)}</code> (<code>${escapeHtml(argModel)}</code>)`,
      { parse_mode: 'HTML' }
    );
  }

  const currentModel = getSelectedModel(chatId);
  const keyboard = getModelsKeyboard(currentModel);

  ctx.reply(
    `🤖 <b>Seleziona il modello AI per Antigravity:</b>\n\n` +
    `Modello attuale: <b>${escapeHtml(getModelLabel(currentModel))}</b>${currentModel ? ` (<code>${escapeHtml(currentModel)}</code>)` : ''}\n\n` +
    `Scegli un modello dai pulsanti qui sotto (oppure usa <code>/model nome-modello</code>):`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
});

// Callback selezione modello dalla tastiera inline
bot.action(/^sel_model:(.+)$/, (ctx) => {
  const modelId = ctx.match[1];
  const chatId = ctx.chat.id;

  setSelectedModel(chatId, modelId);
  const currentModel = getSelectedModel(chatId);
  const label = getModelLabel(currentModel);
  const keyboard = getModelsKeyboard(currentModel);

  ctx.answerCbQuery(`Modello impostato: ${label}`).catch(() => {});

  ctx.editMessageText(
    `🤖 <b>Seleziona il modello AI per Antigravity:</b>\n\n` +
    `✅ Modello selezionato: <b>${escapeHtml(label)}</b>${currentModel ? ` (<code>${escapeHtml(currentModel)}</code>)` : ''}\n\n` +
    `Scegli un modello dai pulsanti qui sotto (oppure usa <code>/model nome-modello</code>):`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }
  ).catch(() => {});
});

// Comando /stato
bot.command(['stato', 'status'], (ctx) => {
  const chatId = ctx.chat.id;
  registerChat(chatId);
  const active = getActiveProject(chatId);
  const currentModel = getSelectedModel(chatId);
  const voiceStatus = getVoiceStatusDetails(chatId);

  if (!active) {
    return ctx.reply(
      `⚠️ Nessun progetto attualmente selezionato. Usa /progetti per sceglierne uno.\n` +
      `🤖 <b>Modello attivo:</b> <code>${escapeHtml(getModelLabel(currentModel))}</code>\n` +
      `🎙️ <b>Voce:</b> ${voiceStatus.providerLabel}`,
      { parse_mode: 'HTML' }
    );
  }

  const conversationId = getConversation(active.name);

  ctx.reply(
    `📊 <b>Stato Progetto</b>\n\n` +
    `📁 <b>Nome:</b> <code>${active.name}</code>\n` +
    `📍 <b>Percorso:</b> <code>${active.path}</code>\n` +
    `📂 <b>Esiste sul disco:</b> ${active.exists ? 'Sì 🟢' : 'No 🔴'}\n` +
    `🤖 <b>Modello AI:</b> <code>${escapeHtml(getModelLabel(currentModel))}</code>\n` +
    `🎙️ <b>Riconoscimento Vocale:</b> ${voiceStatus.providerLabel}\n` +
    `🔊 <b>Risposte Vocali (TTS):</b> ${voiceStatus.settings.ttsEnabled ? 'Attive 🟢' : 'Disattive ⚪'}\n` +
    `💬 <b>ID Conversazione attiva:</b> ${conversationId ? `<code>${conversationId}</code>` : '<i>Nessuna (il prossimo prompt avvierà una nuova conversazione)</i>'}\n\n` +
    `<i>Usa /model per cambiare modello, /voice per le impostazioni vocali, /nuova per resettare la sessione o /progetti per cambiare progetto.</i>`,
    { parse_mode: 'HTML' }
  );
});

// Comando /nuova
bot.command(['nuova', 'new'], (ctx) => {
  const chatId = ctx.chat.id;
  registerChat(chatId);
  const active = getActiveProject(chatId);

  if (!active) {
    return ctx.reply('⚠️ Nessun progetto selezionato. Usa /progetti prima di iniziare una nuova sessione.');
  }

  clearConversation(active.name);
  ctx.reply(
    `🔄 <b>Sessione resettata per:</b> <code>${active.name}</code>\n` +
    `Il prossimo prompt creerà una nuova sessione pulita da zero.`,
    { parse_mode: 'HTML' }
  );
});

// Comando /stop
bot.command(['stop', 'annulla'], (ctx) => {
  const chatId = ctx.chat.id;
  const stopped = cancelRunningProcess(chatId);
  if (stopped) {
    ctx.reply('🛑 Esecuzione in corso interrotta.');
  } else {
    ctx.reply('ℹ️ Nessuna esecuzione attiva in questo momento.');
  }
});

// Map per i prompt vocali in attesa di conferma: promptId -> { text, chatId, projectName, timestamp }
const pendingVoicePrompts = new Map();

function formatVoiceDashboardText(chatId) {
  const status = getVoiceStatusDetails(chatId);
  return (
    `🎙️ <b>Pannello Vocale Antigravity (/voice)</b>\n\n` +
    `Questa funzionalità ti permette di inviare <b>note vocali su Telegram</b> per pilotare i tuoi agenti Antigravity e ricevere risposte vocali sintetizzate (TTS).\n\n` +
    `📊 <b>Stato Attuale:</b>\n` +
    `• <b>Trascrizione Vocale (STT):</b> ${status.providerLabel}\n` +
    `• <b>Modalità Invio:</b> ${status.autoRunLabel}\n` +
    `• <b>Risposte Vocali (TTS):</b> ${status.ttsLabel}\n\n` +
    `💡 <i>Tocca i pulsanti qui sotto per modificare le impostazioni, oppure invia direttamente un messaggio vocale!</i>`
  );
}

// Comando /voice o /voce
bot.command(['voice', 'voce'], async (ctx) => {
  const chatId = ctx.chat.id;
  registerChat(chatId);

  const text = (ctx.message.text || '').trim();
  const parts = text.split(/\s+/);
  const subCmd = parts[1] ? parts[1].toLowerCase() : null;
  const param = parts.slice(2).join(' ').trim();

  // /voice on (attiva risposte audio TTS)
  if (subCmd === 'on') {
    setVoiceSettings(chatId, { ttsEnabled: true });
    return ctx.reply('🔊 <b>Risposte Vocali (TTS) attivate!</b>\nIl bot invierà sia la risposta testuale sia la sintesi vocale.', { parse_mode: 'HTML' });
  }

  // /voice off (disattiva risposte audio TTS)
  if (subCmd === 'off') {
    setVoiceSettings(chatId, { ttsEnabled: false });
    return ctx.reply('🔇 <b>Risposte Vocali (TTS) disattivate.</b>\nIl bot invierà solo risposte testuali.', { parse_mode: 'HTML' });
  }

  // /voice auto (esegui subito il prompt dopo la trascrizione)
  if (subCmd === 'auto') {
    setVoiceSettings(chatId, { autoRun: true });
    return ctx.reply('⚡ <b>Modalità Esecuzione Automatica attivata!</b>\nI messaggi vocali verranno trascritti ed eseguiti immediatamente come prompt.', { parse_mode: 'HTML' });
  }

  // /voice confirm (chiedi conferma prima di eseguire)
  if (subCmd === 'confirm' || subCmd === 'conferma') {
    setVoiceSettings(chatId, { autoRun: false });
    return ctx.reply('✋ <b>Modalità Chiedi Conferma attivata!</b>\nDopo aver trascritto il vocale, il bot mostrerà il testo e ti chiederà conferma con un pulsante prima di avviarlo.', { parse_mode: 'HTML' });
  }

  // /voice key <api_key> (salva la chiave per la trascrizione vocale)
  if (subCmd === 'key') {
    if (!param) {
      return ctx.reply(
        '⚠️ <b>Specifica la chiave API!</b>\nEsempio: <code>/voice key gsk_...</code> oppure <code>/voice key AIzaSy...</code>\n\n' +
        'Puoi ottenere una chiave gratuita su:\n' +
        '• <b>Groq (Consigliato, velocissimo):</b> https://console.groq.com\n' +
        '• <b>Google AI Studio:</b> https://aistudio.google.com',
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
    }
    const key = param;
    let provider = 'groq';
    if (key.startsWith('AIzaSy')) provider = 'gemini';
    else if (key.startsWith('sk-')) provider = 'openai';

    setVoiceSettings(chatId, { apiKey: key, provider });
    return ctx.reply(
      `✅ <b>Chiave API salvata con successo!</b>\n` +
      `🔑 <b>Provider rilevato:</b> <code>${provider.toUpperCase()}</code>\n` +
      `Ora puoi inviare direttamente note vocali su Telegram per interagire con l'agente Antigravity!`,
      { parse_mode: 'HTML' }
    );
  }

  // Schermata principale /voice
  const dashboardText = formatVoiceDashboardText(chatId);
  const keyboard = getVoiceInlineKeyboard(chatId);

  ctx.reply(dashboardText, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
});

// Callback per i pulsanti inline del pannello /voice
bot.action('voice_toggle_mode', (ctx) => {
  const chatId = ctx.chat.id;
  const current = getVoiceSettings(chatId);
  setVoiceSettings(chatId, { autoRun: !current.autoRun });

  const text = formatVoiceDashboardText(chatId);
  const keyboard = getVoiceInlineKeyboard(chatId);
  ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  }).catch(() => {});
  ctx.answerCbQuery('Modalità aggiornata!').catch(() => {});
});

bot.action('voice_toggle_tts', (ctx) => {
  const chatId = ctx.chat.id;
  const current = getVoiceSettings(chatId);
  setVoiceSettings(chatId, { ttsEnabled: !current.ttsEnabled });

  const text = formatVoiceDashboardText(chatId);
  const keyboard = getVoiceInlineKeyboard(chatId);
  ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  }).catch(() => {});
  ctx.answerCbQuery(current.ttsEnabled ? 'Risposta vocale disattivata' : 'Risposta vocale attivata').catch(() => {});
});

bot.action('voice_refresh', (ctx) => {
  const chatId = ctx.chat.id;
  const text = formatVoiceDashboardText(chatId);
  const keyboard = getVoiceInlineKeyboard(chatId);
  ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  }).catch(() => {});
  ctx.answerCbQuery('Stato aggiornato!').catch(() => {});
});

bot.action('voice_help_keys', (ctx) => {
  ctx.reply(
    `🔑 <b>Guida Configurazione Chiave Vocale (STT)</b>\n\n` +
    `Per trascrivere le note vocali in comandi testuali, il bot supporta:\n\n` +
    `1. <b>Groq (Consigliato - Gratuito & Istantaneo)</b>\n` +
    `   • Registrati gratuitamente su: <a href="https://console.groq.com">console.groq.com</a>\n` +
    `   • Crea una API Key (inizia con <code>gsk_...</code>)\n` +
    `   • Inviala qui in chat con: <code>/voice key gsk_...</code>\n\n` +
    `2. <b>Google Gemini (Gratuito con account Google)</b>\n` +
    `   • Ottieni la chiave da Google AI Studio: <a href="https://aistudio.google.com">aistudio.google.com</a>\n` +
    `   • Inviala qui in chat con: <code>/voice key AIzaSy...</code>\n\n` +
    `3. <b>OpenAI (Whisper)</b>\n` +
    `   • Ottieni la chiave da: <a href="https://platform.openai.com">platform.openai.com</a>\n` +
    `   • Inviala qui in chat con: <code>/voice key sk-...</code>\n\n` +
    `<i>Puoi anche configurare <code>GROQ_API_KEY</code>, <code>GEMINI_API_KEY</code> o <code>OPENAI_API_KEY</code> direttamente nel file <code>.env</code> sul server.</i>`,
    { parse_mode: 'HTML', disable_web_page_preview: true }
  );
  ctx.answerCbQuery().catch(() => {});
});

// Callback esecuzione prompt confermato da messaggio vocale
bot.action(/^voice_run:(.+)$/, async (ctx) => {
  const promptId = ctx.match[1];
  const pending = pendingVoicePrompts.get(promptId);
  if (!pending) {
    ctx.answerCbQuery('Prompt vocale scaduto o già elaborato.').catch(() => {});
    return ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  }

  pendingVoicePrompts.delete(promptId);
  ctx.answerCbQuery('Prompt avviato!').catch(() => {});

  const chatId = ctx.chat.id;
  const active = getActiveProject(chatId);
  if (!active || active.name !== pending.projectName) {
    return ctx.reply(`⚠️ Il progetto selezionato è cambiato rispetto a quando è stato inviato il vocale.`);
  }

  ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await executeAgentPrompt(ctx, pending.text, active, chatId, true);
});

// Callback annullamento prompt vocale
bot.action(/^voice_cancel:(.+)$/, (ctx) => {
  const promptId = ctx.match[1];
  pendingVoicePrompts.delete(promptId);
  ctx.answerCbQuery('Annullato').catch(() => {});
  ctx.editMessageText(
    (ctx.callbackQuery.message.text || '') + '\n\n❌ <i>Esecuzione annullata dall\'utente.</i>',
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
  ).catch(() => {});
});

// Helper per formattare la visualizzazione delle sessioni
function formatSessionsMessage() {
  const active = getActiveSessions();
  if (active.length > 1) {
    active.reverse();
  }
  const all = scanAllSessions(3, true);

  let text = '⚡ <b>SESSIONI ANTIGRAVITY (IDE, CLI & Telegram)</b>\n\n';

  if (active.length > 0) {
    text += '🟢 <b>SESSIONI ATTIVE IN ESECUZIONE:</b>\n';
    active.forEach((s, idx) => {
      const toolInfo = s.currentTool ? `\n   🔧 <i>Tool: ${escapeHtml(s.currentTool)}</i>` : '';
      text += `${idx + 1}. 📁 <b>Progetto:</b> <code>${escapeHtml(s.projectName)}</code> (${s.source || 'IDE'})\n   🆔 <code>${s.conversationId}</code>${toolInfo}\n\n`;
    });
  } else {
    text += '🟢 <b>SESSIONI ATTIVE:</b>\n<i>Nessuna sessione attualmente in esecuzione.</i>\n\n';
  }

  text += '📋 <b>ULTIME 3 SESSIONI:</b>\n';
  if (all.length === 0) {
    text += '<i>Nessuna sessione trovata su disco.</i>\n';
  } else {
    all.forEach((s, idx) => {
      const statusIcon = s.status === 'RUNNING' ? '🟢' : '⚪';
      const timeStr = s.mtime ? new Date(s.mtime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const promptPreview = s.firstPrompt ? `\n   💬 <i>"${escapeHtml(s.firstPrompt)}"</i>` : '';
      text += `${statusIcon} 📁 <b>Progetto:</b> <code>${escapeHtml(s.projectName)}</code> [${s.flavor || 'IDE'}] ${timeStr}\n   🆔 <code>${s.conversationId}</code>${promptPreview}\n\n`;
    });
  }

  return text;
}

// Comando /sessioni o /sessions
bot.command(['sessioni', 'sessions'], (ctx) => {
  const chatId = ctx.chat.id;
  registerChat(chatId);
  const text = formatSessionsMessage();

  ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔄 Aggiorna sessioni', callback_data: 'refresh_sessions' },
          { text: '📁 Elenco Progetti', callback_data: 'open_projects' }
        ]
      ]
    }
  });
});

// Callback aggiornamento lista sessioni
bot.action('refresh_sessions', (ctx) => {
  const text = formatSessionsMessage();
  ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔄 Aggiorna sessioni', callback_data: 'refresh_sessions' },
          { text: '📁 Elenco Progetti', callback_data: 'open_projects' }
        ]
      ]
    }
  }).catch(() => {});
  ctx.answerCbQuery('Lista sessioni aggiornata!').catch(() => {});
});

// Callback apertura progetti dalla lista sessioni
bot.action('open_projects', (ctx) => {
  const chatId = ctx.chat.id;
  const active = getActiveProject(chatId);
  const keyboard = getProjectsKeyboard(0, active);
  const activeInfo = active ? `📌 <b>Progetto attivo:</b> <code>${active.name}</code>\n\n` : '';

  ctx.editMessageText(
    `${activeInfo}📂 <b>Seleziona un progetto:</b>\nScegli il progetto su cui vuoi lavorare per inviare i prompt:`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }
  ).catch(() => {});
  ctx.answerCbQuery().catch(() => {});
});

// Helper per formattare i log del bot per Telegram
function formatBotLogsMessage(maxLines = 30) {
  const logPath = path.join(__dirname, 'bot.log');
  if (!fs.existsSync(logPath)) {
    return '📋 <b>LOG DEL BOT (make bg-logs):</b>\n<i>Nessun file bot.log trovato su disco.</i>';
  }

  try {
    const rawContent = fs.readFileSync(logPath, 'utf8');
    if (!rawContent || !rawContent.trim()) {
      return '📋 <b>LOG DEL BOT (make bg-logs):</b>\n<i>Il file bot.log è attualmente vuoto.</i>';
    }

    // Rimuove sequenze di escape ANSI color e caratteri di controllo speciali
    const cleanContent = rawContent.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
    const allLines = cleanContent.split('\n').filter(l => l.trim().length > 0);
    const tailLines = allLines.slice(-maxLines);

    let joined = tailLines.join('\n');
    // Telegram ha un limite massimo di 4096 caratteri per messaggio
    if (joined.length > 3500) {
      joined = joined.slice(-3500);
      const firstNl = joined.indexOf('\n');
      if (firstNl !== -1) {
        joined = '...' + joined.slice(firstNl);
      }
    }

    return (
      `📋 <b>ULTIMI LOG DEL BOT (make bg-logs):</b>\n\n` +
      `<pre>${escapeHtml(joined)}</pre>`
    );
  } catch (err) {
    return `⚠️ <b>Errore nella lettura dei log:</b>\n<code>${escapeHtml(err.message)}</code>`;
  }
}

function getLogsKeyboard() {
  return [
    [
      { text: '🔄 Aggiorna Log', callback_data: 'refresh_logs' },
      { text: '⚡ Riavvia Bot', callback_data: 'bot_restart_cmd' }
    ]
  ];
}

function triggerBotRestart(chatId = null) {
  if (chatId) {
    setRestartNotifyChat(chatId);
  }
  const vbsPath = path.join(__dirname, 'start-bot-bg.vbs');
  try {
    const child = spawn('wscript.exe', [vbsPath], {
      detached: true,
      stdio: 'ignore',
      cwd: __dirname
    });
    child.unref();
  } catch (err) {
    console.error('Errore durante lo spawn del riavvio:', err);
  }

  setTimeout(() => {
    process.exit(0);
  }, 800);
}

// Comando /logs o /log
bot.command(['logs', 'log', 'bglogs'], (ctx) => {
  const chatId = ctx.chat.id;
  registerChat(chatId);
  const text = formatBotLogsMessage(30);

  ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: getLogsKeyboard()
    }
  });
});

// Callback aggiornamento log
bot.action('refresh_logs', (ctx) => {
  const text = formatBotLogsMessage(30);
  ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: getLogsKeyboard()
    }
  }).catch(() => {});
  ctx.answerCbQuery('Log aggiornati!').catch(() => {});
});

// Comando /restart o /riavvia
bot.command(['restart', 'riavvia', 'bgrestart'], async (ctx) => {
  const chatId = ctx.chat.id;
  registerChat(chatId);

  await ctx.reply(
    `🔄 <b>Riavvio del bot in corso (make bg-restart)...</b>\n\n` +
    `<i>Il processo verrà riavviato in background. Riceverai una notifica non appena il bot tornerà online!</i>`,
    { parse_mode: 'HTML' }
  );

  triggerBotRestart(chatId);
});

// Callback da pulsante per riavviare il bot
bot.action('bot_restart_cmd', async (ctx) => {
  const chatId = ctx.chat.id;
  ctx.answerCbQuery('Riavvio avviato...').catch(() => {});
  await ctx.reply(
    `🔄 <b>Riavvio del bot in corso (make bg-restart)...</b>\n\n` +
    `<i>Il processo verrà riavviato in background. Riceverai una notifica non appena il bot tornerà online!</i>`,
    { parse_mode: 'HTML' }
  );

  triggerBotRestart(chatId);
});

// Helper unificato per l'esecuzione del prompt dell'agente (da testo o da voce)
async function executeAgentPrompt(ctx, text, active, chatId, isVoiceInput = false) {
  const conversationId = getConversation(active.name);
  const selectedModel = getSelectedModel(chatId);
  const modelLabel = getModelLabel(selectedModel);

  await saveLog({
    level: 'INFO',
    eventType: isVoiceInput ? 'voice_prompt_received' : 'prompt_received',
    chatId,
    projectName: active.name,
    conversationId,
    message: text,
    payload: { model: selectedModel || 'default', isVoiceInput }
  });

  const promptIcon = isVoiceInput ? '🎙️' : '💬';
  await ctx.reply(
    `🚀 <b>Esecuzione avviata per:</b> <code>${active.name}</code>\n` +
    `🤖 <b>Modello:</b> <code>${escapeHtml(modelLabel)}</code>\n` +
    `${promptIcon} <i>"${escapeHtml(text)}"</i>\n\n` +
    `⏳ <i>Agente Antigravity al lavoro...</i>`,
    { parse_mode: 'HTML' }
  );

  try {
    const result = await runAgentPrompt({
      prompt: text,
      cwd: active.path,
      conversationId,
      chatId,
      model: selectedModel,
      onOutput: (output) => {
        // Output streaming o logs opzionali
      }
    });

    if (result.conversation_id) {
      setConversation(active.name, result.conversation_id);
    }

    const responseText = result.response || result.raw || 'Attività completata senza output testuale.';

    await saveLog({
      level: 'INFO',
      eventType: isVoiceInput ? 'voice_prompt_completed' : 'prompt_completed',
      chatId,
      projectName: active.name,
      conversationId: result.conversation_id || conversationId,
      message: responseText,
      payload: result
    });

    const durationInfo = result.duration_seconds
      ? ` <i>(${result.duration_seconds.toFixed(1)}s)</i>`
      : '';

    await ctx.reply(
      `🏁 <b>Risposta da Antigravity per <code>${active.name}</code></b>${durationInfo}:`,
      { parse_mode: 'HTML' }
    );

    await sendLongMessage(ctx, responseText);

    // Se le risposte vocali (TTS) sono attive, genera l'audio vocale di sintesi
    const voiceSettings = getVoiceSettings(chatId);
    if (voiceSettings.ttsEnabled) {
      try {
        ctx.sendChatAction('record_voice').catch(() => {});
        const ttsAudio = await textToSpeech(responseText);
        if (ttsAudio) {
          await ctx.replyWithVoice(
            { source: ttsAudio },
            { caption: `🔊 Sintesi vocale (${active.name})` }
          );
        }
      } catch (ttsErr) {
        console.error('Errore durante la generazione della sintesi vocale:', ttsErr.message);
      }
    }
  } catch (err) {
    console.error('Errore durante l\'esecuzione dell\'agente:', err);
    await saveLog({
      level: 'ERROR',
      eventType: 'agent_error',
      chatId,
      projectName: active.name,
      conversationId,
      message: err.message
    });
    ctx.reply(`❌ <b>Errore durante l'esecuzione:</b>\n<code>${escapeHtml(err.message)}</code>`, {
      parse_mode: 'HTML'
    });
  }
}

// Gestione dei messaggi di testo (Prompt per l'agente)
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return; // ignora altri comandi

  const chatId = ctx.chat.id;
  registerChat(chatId);
  const active = getActiveProject(chatId);

  if (!active) {
    return ctx.reply(
      `⚠️ <b>Nessun progetto selezionato!</b>\n` +
      `Usa il comando /progetti per scegliere su quale cartella/progetto vuoi lavorare.`,
      { parse_mode: 'HTML' }
    );
  }

  await executeAgentPrompt(ctx, text, active, chatId, false);
});

// Gestione dei messaggi vocali e audio (Trascrizione STT e prompt)
bot.on(['voice', 'audio'], async (ctx) => {
  const chatId = ctx.chat.id;
  registerChat(chatId);
  const active = getActiveProject(chatId);

  if (!active) {
    return ctx.reply(
      `⚠️ <b>Nessun progetto selezionato!</b>\n` +
      `Usa il comando /progetti per scegliere su quale cartella/progetto vuoi lavorare prima di inviare un prompt vocale.`,
      { parse_mode: 'HTML' }
    );
  }

  const voiceObj = ctx.message.voice || ctx.message.audio;
  const fileId = voiceObj?.file_id;
  const duration = voiceObj?.duration || 0;

  if (!fileId) {
    return ctx.reply('⚠️ Impossibile recuperare il file audio.');
  }

  ctx.sendChatAction('typing').catch(() => {});

  const statusMsg = await ctx.reply(
    `🎙️ <i>Elaborazione nota vocale (${duration}s)...</i>`,
    { parse_mode: 'HTML' }
  );

  let audioBuffer;
  try {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const fileRes = await fetch(fileLink.href || fileLink.toString());
    if (!fileRes.ok) {
      throw new Error(`Impossibile scaricare l'audio da Telegram (status: ${fileRes.status})`);
    }
    audioBuffer = Buffer.from(await fileRes.arrayBuffer());
  } catch (err) {
    console.error('Errore download vocale:', err);
    return ctx.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      null,
      `❌ <b>Errore nel download del file audio:</b>\n<code>${escapeHtml(err.message)}</code>`,
      { parse_mode: 'HTML' }
    );
  }

  // Trascrizione audio
  let transcribedText = '';
  try {
    transcribedText = await transcribeAudio(audioBuffer, chatId);
  } catch (err) {
    if (err.message === 'NO_API_KEY') {
      return ctx.telegram.editMessageText(
        chatId,
        statusMsg.message_id,
        null,
        `🎙️ <b>Messaggio vocale ricevuto (${duration}s)!</b>\n\n` +
        `⚠️ <b>Nessuna chiave API per la trascrizione vocale configurata.</b>\n\n` +
        `Per trascrivere i vocali e inviarli ad Antigravity, imposta una chiave API (anche gratuita):\n` +
        `• <b>Groq (Consigliata, gratuita e velocissima):</b> su <a href="https://console.groq.com">console.groq.com</a>\n` +
        `• <b>Google Gemini (Gratuita):</b> su <a href="https://aistudio.google.com">aistudio.google.com</a>\n\n` +
        `Puoi impostarla subito inviando in chat:\n` +
        `<code>/voice key gsk_latuachiave</code>\n\n` +
        `Usa il comando /voice per vedere tutte le opzioni.`,
        {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [{ text: '⚙️ Apri Impostazioni /voice', callback_data: 'voice_refresh' }],
              [{ text: '🔑 Guida Chiavi API', callback_data: 'voice_help_keys' }]
            ]
          }
        }
      );
    }

    console.error('Errore trascrizione vocale:', err);
    return ctx.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      null,
      `❌ <b>Errore durante la trascrizione vocale:</b>\n<code>${escapeHtml(err.message)}</code>\n\n<i>Controlla le impostazioni con /voice.</i>`,
      { parse_mode: 'HTML' }
    );
  }

  if (!transcribedText || transcribedText.trim().length === 0) {
    return ctx.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      null,
      `⚠️ <i>Non è stato rilevato alcun testo comprensibile nel messaggio vocale. Prova a parlare più vicino al microfono.</i>`,
      { parse_mode: 'HTML' }
    );
  }

  // Rimuove il messaggio temporaneo di stato
  ctx.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

  const settings = getVoiceSettings(chatId);

  // Se autoRun è attivo, esegue direttamente il prompt
  if (settings.autoRun) {
    await ctx.reply(
      `🎙️ <b>Messaggio vocale riconosciuto:</b>\n` +
      `<i>"${escapeHtml(transcribedText)}"</i>`,
      { parse_mode: 'HTML' }
    );
    return executeAgentPrompt(ctx, transcribedText, active, chatId, true);
  }

  // Modalità Chiedi Conferma prima dell'esecuzione
  const promptId = 'vp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  pendingVoicePrompts.set(promptId, {
    text: transcribedText,
    chatId,
    projectName: active.name,
    timestamp: Date.now()
  });

  setTimeout(() => pendingVoicePrompts.delete(promptId), 10 * 60 * 1000);

  const model = getSelectedModel(chatId);
  const modelLabel = getModelLabel(model);

  await ctx.reply(
    `🎙️ <b>Messaggio vocale trascritto:</b>\n\n` +
    `<i>"${escapeHtml(transcribedText)}"</i>\n\n` +
    `📌 <b>Progetto:</b> <code>${active.name}</code>\n` +
    `🤖 <b>Modello:</b> <code>${escapeHtml(modelLabel)}</code>\n\n` +
    `Vuoi eseguire questo prompt con l'agente Antigravity?`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '▶️ Invia all\'Agente', callback_data: `voice_run:${promptId}` },
            { text: '❌ Annulla', callback_data: `voice_cancel:${promptId}` }
          ]
        ]
      }
    }
  );
});

// Gestione globale errori Telegraf
bot.catch((err, ctx) => {
  console.error(`⚠️ Errore gestito dal bot per update [${ctx?.updateType}]:`, err.message);
  saveLog({
    level: 'ERROR',
    eventType: 'bot_error',
    chatId: ctx?.chat?.id || null,
    message: err.message
  });
});

// Inizializzazione DB e avvio del bot
initState().then(() => {
  bot.launch({ dropPendingUpdates: true }).then(() => {
    console.log('🤖 Bot Telegram avviato con successo.');
    console.log(`📂 Cartella progetti: ${PROJECTS_DIR}`);

    // Se il riavvio è stato richiesto da Telegram, notifica la chat
    const notifyChat = popRestartNotifyChat();
    if (notifyChat) {
      bot.telegram.sendMessage(
        notifyChat,
        `✅ <b>Bot riavviato con successo!</b> (make bg-restart)\n` +
        `<i>Tutti i servizi (DB PostgreSQL, Hook server e Bot) sono nuovamente attivi e pronti.</i>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  }).catch((err) => {
    console.error('❌ Errore durante l\'avvio di Telegraf:', err);
  });
});

// Chiusura pulita
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));