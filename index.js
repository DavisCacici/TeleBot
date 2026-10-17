require('dotenv').config();
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
  clearConversation
} = require('./projects');
const { runAgentPrompt, cancelRunningProcess } = require('./agent');
const { startHookServer, setBotInstance, resolvePendingRequest } = require('./server');
const { saveLog } = require('./db');
const { getActiveSessions, scanAllSessions } = require('./sessions');

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
  const activeText = active ? `\n📌 <b>Progetto attivo:</b> <code>${active.name}</code>` : '';

  ctx.reply(
    `👋 <b>Benvenuto nel Bot Antigravity!</b>\n` +
    `Questo bot ti permette di gestire i tuoi progetti e sessioni di sviluppo da remoto.${activeText}\n\n` +
    `<b>Comandi principali:</b>\n` +
    `• /progetti - Mostra e seleziona un progetto da <code>${PROJECTS_DIR}</code>\n` +
    `• /sessioni - Mostra tutte le sessioni attive e recenti (IDE & CLI compresi)\n` +
    `• /stato - Dettagli sul progetto attivo e la sessione\n` +
    `• /nuova - Avvia una nuova sessione (resetta la cronologia per il progetto)\n` +
    `• /stop - Annulla l'esecuzione in corso\n` +
    `• /help - Mostra l'elenco dei comandi disponibili\n\n` +
    `Una volta selezionato un progetto, <b>invia direttamente un messaggio di testo</b> per lanciare un prompt! Riceverai notifiche e potrai approvare comandi e visualizzare quando l'attività termina.`,
    { parse_mode: 'HTML' }
  );
});

// Comando /help o /aiuto
bot.command(['help', 'aiuto'], (ctx) => {
  const chatId = ctx.chat.id;
  registerChat(chatId);

  const active = getActiveProject(chatId);
  const activeText = active ? `\n📌 <b>Progetto attivo:</b> <code>${active.name}</code>\n` : '';

  ctx.reply(
    `📖 <b>Guida ai Comandi - Bot Antigravity</b>\n${activeText}\n` +
    `<b>Comandi principali:</b>\n` +
    `• /start - Messaggio di benvenuto e panoramica iniziale\n` +
    `• /progetti (o /projects) - Sfoglia e seleziona un progetto da <code>${PROJECTS_DIR}</code>\n` +
    `• /sessioni (o /sessions) - Visualizza le sessioni attive e recenti (IDE, CLI e Telegram)\n` +
    `• /stato (o /status) - Mostra informazioni sul progetto attivo e l'ID della conversazione\n` +
    `• /nuova (o /new) - Resetta la sessione corrente per iniziare una nuova conversazione\n` +
    `• /stop (o /annulla) - Interrompe l'esecuzione dell'agente attualmente in corso\n` +
    `• /help (o /aiuto) - Mostra questo elenco di comandi\n\n` +
    `💡 <b>Come inviare un prompt:</b>\n` +
    `Dopo aver selezionato un progetto con /progetti, scrivi un normale messaggio in chat per inviarlo all'agente Antigravity.`,
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

// Comando /stato
bot.command(['stato', 'status'], (ctx) => {
  const chatId = ctx.chat.id;
  registerChat(chatId);
  const active = getActiveProject(chatId);

  if (!active) {
    return ctx.reply('⚠️ Nessun progetto attualmente selezionato. Usa /progetti per sceglierne uno.');
  }

  const conversationId = getConversation(active.name);

  ctx.reply(
    `📊 <b>Stato Progetto</b>\n\n` +
    `📁 <b>Nome:</b> <code>${active.name}</code>\n` +
    `📍 <b>Percorso:</b> <code>${active.path}</code>\n` +
    `📂 <b>Esiste sul disco:</b> ${active.exists ? 'Sì 🟢' : 'No 🔴'}\n` +
    `💬 <b>ID Conversazione attiva:</b> ${conversationId ? `<code>${conversationId}</code>` : '<i>Nessuna (il prossimo prompt avvierà una nuova conversazione)</i>'}\n\n` +
    `<i>Usa /nuova per resettare la sessione o /progetti per cambiare progetto.</i>`,
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

// Helper per formattare la visualizzazione delle sessioni
function formatSessionsMessage() {
  const active = getActiveSessions();
  const all = scanAllSessions(10);

  let text = '⚡ <b>SESSIONI ANTIGRAVITY (IDE, CLI & Telegram)</b>\n\n';

  if (active.length > 0) {
    text += '🟢 <b>SESSIONI ATTIVE IN ESECUZIONE:</b>\n';
    active.forEach((s, idx) => {
      const toolInfo = s.currentTool ? `\n   🔧 <i>Tool: ${escapeHtml(s.currentTool)}</i>` : '';
      text += `${idx + 1}. <b>${escapeHtml(s.projectName)}</b> (${s.source || 'IDE'})\n   🆔 <code>${s.conversationId}</code>${toolInfo}\n\n`;
    });
  } else {
    text += '🟢 <b>SESSIONI ATTIVE:</b>\n<i>Nessuna sessione attualmente in esecuzione.</i>\n\n';
  }

  text += '📋 <b>SESSIONI RECENTI:</b>\n';
  if (all.length === 0) {
    text += '<i>Nessuna sessione trovata su disco.</i>\n';
  } else {
    all.forEach((s, idx) => {
      const statusIcon = s.status === 'RUNNING' ? '🟢' : '⚪';
      const timeStr = s.mtime ? new Date(s.mtime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const promptPreview = s.firstPrompt ? `\n   💬 <i>"${escapeHtml(s.firstPrompt)}"</i>` : '';
      text += `${statusIcon} <b>${escapeHtml(s.projectName)}</b> [${s.flavor || 'IDE'}] ${timeStr}\n   🆔 <code>${s.conversationId}</code>${promptPreview}\n\n`;
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

  const conversationId = getConversation(active.name);

  await saveLog({
    level: 'INFO',
    eventType: 'prompt_received',
    chatId,
    projectName: active.name,
    conversationId,
    message: text
  });

  const statusMsg = await ctx.reply(
    `🚀 <b>Esecuzione avviata per:</b> <code>${active.name}</code>\n` +
    `💬 <i>"${text}"</i>\n\n` +
    `⏳ <i>Agente Antigravity al lavoro...</i>`,
    { parse_mode: 'HTML' }
  );

  try {
    const result = await runAgentPrompt({
      prompt: text,
      cwd: active.path,
      conversationId,
      chatId,
      onOutput: (output) => {
        // Output streaming o logs opzionali
      }
    });

    if (result.conversation_id) {
      setConversation(active.name, result.conversation_id);
    }

    await saveLog({
      level: 'INFO',
      eventType: 'prompt_completed',
      chatId,
      projectName: active.name,
      conversationId: result.conversation_id || conversationId,
      message: result.response || result.raw || 'Attività completata senza output testuale.',
      payload: result
    });

    const durationInfo = result.duration_seconds
      ? ` <i>(${result.duration_seconds.toFixed(1)}s)</i>`
      : '';

    await ctx.reply(
      `🏁 <b>Risposta da Antigravity per <code>${active.name}</code></b>${durationInfo}:`,
      { parse_mode: 'HTML' }
    );

    await sendLongMessage(ctx, result.response || result.raw || 'Attività completata senza output testuale.');
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
    ctx.reply(`❌ <b>Errore durante l'esecuzione:</b>\n<code>${err.message}</code>`, {
      parse_mode: 'HTML'
    });
  }
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
  bot.launch({ dropPendingUpdates: true }).catch((err) => {
    console.error('❌ Errore durante l\'avvio di Telegraf:', err);
  });
  console.log('🤖 Bot Telegram avviato con successo.');
  console.log(`📂 Cartella progetti: ${PROJECTS_DIR}`);
});

// Chiusura pulita
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));