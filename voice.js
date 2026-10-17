const { getVoiceSettings, setVoiceSettings } = require('./projects');

/**
 * Pulisce il testo da formattazione markdown complessa e blocchi di codice
 * per renderlo naturale per la sintesi vocale (TTS).
 */
function cleanTextForSpeech(text) {
  if (!text) return '';

  let cleaned = text;

  // Sostituisce i blocchi di codice markdown con una frase riassuntiva
  cleaned = cleaned.replace(/```[\s\S]*?```/g, ' [Ho generato il blocco di codice corrispondente] ');
  // Sostituisce i comandi inline con testo pulito
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  // Rimuove link markdown [testo](url) mantenendo solo il testo
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Rimuove intestazioni markdown (# Titolo)
  cleaned = cleaned.replace(/#{1,6}\s+/g, '');
  // Rimuove grassetto e corsivo markdown
  cleaned = cleaned.replace(/[*_~]{1,3}/g, '');
  // Rimuove emoji comuni o caratteri speciali che disturbano il TTS
  cleaned = cleaned.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');

  // Normalizza gli spazi
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Limita la lunghezza per il TTS a un massimo di circa 400 caratteri per risposte brevi e fluide
  if (cleaned.length > 500) {
    const cut = cleaned.slice(0, 480);
    const lastPunct = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
    if (lastPunct > 200) {
      cleaned = cut.slice(0, lastPunct + 1) + ' Trovi tutti i dettagli completi nel messaggio testuale.';
    } else {
      cleaned = cut + '... Trovi i dettagli completi nel messaggio testuale.';
    }
  }

  return cleaned;
}

/**
 * Sintetizza testo in audio MP3 tramite Google Translate TTS gratuito.
 * Supporta testi lunghi spezzettandoli in frasi naturali (<180 caratteri).
 */
async function textToSpeech(text, lang = 'it') {
  const speechText = cleanTextForSpeech(text);
  if (!speechText) return null;

  // Suddivide in frasi per rispettare il limite di ~200 caratteri di Google Translate TTS
  const sentenceRegex = /[^.!?\n,]+[.!?\n,]+|[^.!?\n,]+$/g;
  const rawSentences = speechText.match(sentenceRegex) || [speechText];

  const chunks = [];
  for (const raw of rawSentences) {
    const s = raw.trim();
    if (!s) continue;

    // Se una singola frase supera i 180 caratteri, spezza per parole
    const subParts = [];
    if (s.length > 180) {
      const words = s.split(' ');
      let current = '';
      for (const w of words) {
        if ((current + ' ' + w).trim().length > 180) {
          if (current) subParts.push(current.trim());
          current = w;
        } else {
          current = current ? current + ' ' + w : w;
        }
      }
      if (current) subParts.push(current.trim());
    } else {
      subParts.push(s);
    }

    for (const part of subParts) {
      try {
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(part)}`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          chunks.push(buf);
        }
      } catch (err) {
        console.error('Errore durante download chunk TTS:', err.message);
      }
    }
  }

  if (chunks.length === 0) return null;
  return Buffer.concat(chunks);
}

/**
 * Rileva il provider e la chiave API per la trascrizione audio.
 */
function resolveSTTProvider(chatId) {
  const settings = getVoiceSettings(chatId);
  const key = settings.apiKey || process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;

  if (!key) {
    return { provider: 'none', key: null };
  }

  if (settings.provider && settings.provider !== 'auto') {
    return { provider: settings.provider, key };
  }

  // Rilevamento automatico dal formato della chiave
  if (key.startsWith('gsk_') || process.env.GROQ_API_KEY === key) {
    return { provider: 'groq', key };
  }
  if (key.startsWith('AIzaSy') || process.env.GEMINI_API_KEY === key) {
    return { provider: 'gemini', key };
  }
  if (key.startsWith('sk-') || process.env.OPENAI_API_KEY === key) {
    return { provider: 'openai', key };
  }

  // Fallback default prioritario se presente in env
  if (process.env.GROQ_API_KEY) return { provider: 'groq', key: process.env.GROQ_API_KEY };
  if (process.env.GEMINI_API_KEY) return { provider: 'gemini', key: process.env.GEMINI_API_KEY };
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', key: process.env.OPENAI_API_KEY };

  return { provider: 'groq', key };
}

/**
 * Trascrive un buffer audio (formato Telegram .ogg/.oga Opus) in testo.
 */
async function transcribeAudio(audioBuffer, chatId) {
  const { provider, key } = resolveSTTProvider(chatId);

  if (!key || provider === 'none') {
    throw new Error('NO_API_KEY');
  }

  // 1. Trascrizione tramite Groq (Whisper-large-v3) - Gratuito, ultra-veloce ed estremamente accurato
  if (provider === 'groq') {
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'telegram_voice.oga');
    formData.append('model', 'whisper-large-v3');
    formData.append('temperature', '0');
    formData.append('response_format', 'json');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`
      },
      body: formData
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Errore API Groq Whisper (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return data.text ? data.text.trim() : '';
  }

  // 2. Trascrizione tramite Google Gemini (gemini-2.5-flash / gemini-1.5-flash) - Gratuito da Google AI Studio
  if (provider === 'gemini') {
    const base64Audio = audioBuffer.toString('base64');
    const models = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-2.0-flash'];
    let lastErr = null;

    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: 'Trascrivi fedelmente e integralmente il testo parlato in questo messaggio vocale in italiano. Restituisci ESCLUSIVAMENTE la trascrizione testuale, senza aggiungere commenti, scuse, prefissi o virgolette.'
                  },
                  {
                    inlineData: {
                      mimeType: 'audio/ogg',
                      data: base64Audio
                    }
                  }
                ]
              }
            ]
          })
        });

        if (!res.ok) {
          const errText = await res.text();
          lastErr = new Error(`Errore API Google Gemini ${model} (${res.status}): ${errText}`);
          continue;
        }

        const data = await res.json();
        const candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        return candidateText ? candidateText.trim() : '';
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error('Errore durante la trascrizione con Google Gemini.');
  }

  // 3. Trascrizione tramite OpenAI (whisper-1)
  if (provider === 'openai') {
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'telegram_voice.oga');
    formData.append('model', 'whisper-1');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`
      },
      body: formData
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Errore API OpenAI Whisper (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return data.text ? data.text.trim() : '';
  }

  throw new Error(`Provider vocale "${provider}" non riconosciuto.`);
}

/**
 * Restituisce una rappresentazione formattata dello stato del pannello vocale.
 */
function getVoiceStatusDetails(chatId) {
  const settings = getVoiceSettings(chatId);
  const { provider, key } = resolveSTTProvider(chatId);

  let providerLabel = '🔴 Non configurato';
  let hasKey = Boolean(key);

  if (hasKey) {
    if (provider === 'groq') providerLabel = '🟢 Groq (Whisper-large-v3)';
    else if (provider === 'gemini') providerLabel = '🟢 Google Gemini Audio';
    else if (provider === 'openai') providerLabel = '🟢 OpenAI (Whisper-1)';
    else providerLabel = `🟢 ${provider}`;
  }

  const autoRunLabel = settings.autoRun
    ? '⚡ Esecuzione immediata (al riceversi del vocale)'
    : '✋ Chiedi conferma (mostra prima il testo)';

  const ttsLabel = settings.ttsEnabled
    ? '🔊 Attiva (invierà testo + nota vocale di risposta)'
    : '🔇 Disattivata (solo risposta testuale)';

  return {
    settings,
    provider,
    providerLabel,
    hasKey,
    autoRunLabel,
    ttsLabel
  };
}

/**
 * Genera la tastiera inline per il comando /voice.
 */
function getVoiceInlineKeyboard(chatId) {
  const settings = getVoiceSettings(chatId);

  return [
    [
      {
        text: settings.autoRun ? '⚡ Modalità: Immediata' : '✋ Modalità: Chiedi Conferma',
        callback_data: 'voice_toggle_mode'
      }
    ],
    [
      {
        text: settings.ttsEnabled ? '🔊 Risposta Vocale: ATTIVA' : '🔇 Risposta Vocale: DISATTIVA',
        callback_data: 'voice_toggle_tts'
      }
    ],
    [
      {
        text: '🔑 Come configurare la chiave API',
        callback_data: 'voice_help_keys'
      },
      {
        text: '🔄 Aggiorna',
        callback_data: 'voice_refresh'
      }
    ]
  ];
}

/**
 * Scarica un file audio direttamente dai server di Telegram in un Buffer.
 */
async function downloadTelegramAudio(ctx, fileId) {
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const url = fileLink.href || fileLink.toString();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Impossibile scaricare l'audio da Telegram (status ${res.status})`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = {
  cleanTextForSpeech,
  textToSpeech,
  resolveSTTProvider,
  transcribeAudio,
  getVoiceStatusDetails,
  getVoiceInlineKeyboard,
  downloadTelegramAudio
};

