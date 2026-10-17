const fs = require('fs');
const path = require('path');
const os = require('os');

// Mappa in memoria delle sessioni attive monitorate in tempo reale
const inMemorySessions = new Map();

const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const FLAVORS = ['antigravity-ide', 'antigravity', 'antigravity-cli'];

function recordSessionStart({ conversationId, projectName, workspacePaths, modelName, source = 'IDE' }) {
  if (!conversationId) return;
  const project = projectName || (workspacePaths && workspacePaths.length ? path.basename(workspacePaths[0]) : 'Generale');
  
  const existing = inMemorySessions.get(conversationId) || {};
  inMemorySessions.set(conversationId, {
    ...existing,
    conversationId,
    projectName: project,
    workspacePath: workspacePaths && workspacePaths.length ? workspacePaths[0] : null,
    modelName: modelName || existing.modelName,
    source,
    startTime: existing.startTime || new Date(),
    lastActivity: new Date(),
    status: 'RUNNING',
    currentTool: null
  });
}

function recordSessionTool(conversationId, toolName, toolArgs) {
  if (!conversationId) return;
  const session = inMemorySessions.get(conversationId);
  if (session) {
    session.currentTool = toolName;
    session.lastActivity = new Date();
  }
}

function recordSessionStop(conversationId, { terminationReason, error } = {}) {
  if (!conversationId) return;
  const session = inMemorySessions.get(conversationId);
  if (session) {
    session.status = error ? 'ERROR' : 'COMPLETED';
    session.endTime = new Date();
    session.terminationReason = terminationReason || (error ? 'error' : 'completato');
    session.error = error || null;
    session.currentTool = null;
  }
}

function getActiveSessions() {
  const active = [];
  for (const [id, s] of inMemorySessions.entries()) {
    if (s.status === 'RUNNING') {
      active.push({ ...s });
    }
  }
  return active;
}

// Scansiona il disco per trovare tutte le sessioni recenti (IDE, CLI, App)
function scanAllSessions(limit = 10) {
  const allSessions = [];
  const seenIds = new Set();

  // 1. Aggiungi quelle attualmente attive in memoria
  for (const [id, s] of inMemorySessions.entries()) {
    seenIds.add(id);
    allSessions.push({ ...s, fromMemory: true });
  }

  // 2. Scansiona i lock file attivi per identificare sessioni in esecuzione
  const lockIds = new Set();
  for (const flavor of FLAVORS) {
    const presenceDir = path.join(GEMINI_DIR, flavor, 'presence');
    try {
      if (fs.existsSync(presenceDir)) {
        const files = fs.readdirSync(presenceDir);
        for (const file of files) {
          if (file.endsWith('.lock')) {
            lockIds.add(file.replace('.lock', ''));
          }
        }
      }
    } catch (e) {}
  }

  // 3. Scansiona le directory brain di ogni flavor
  for (const flavor of FLAVORS) {
    const brainDir = path.join(GEMINI_DIR, flavor, 'brain');
    try {
      if (!fs.existsSync(brainDir)) continue;
      const entries = fs.readdirSync(brainDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const convId = entry.name;
        if (seenIds.has(convId)) continue;

        const transcriptPath = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fs.existsSync(transcriptPath)) continue;

        try {
          const stat = fs.statSync(transcriptPath);
          const hasLock = lockIds.has(convId);
          const ageMs = Date.now() - stat.mtimeMs;
          const isRecentlyActive = hasLock || ageMs < 90 * 1000;

          let firstPrompt = '';
          let projectName = '';

          const content = fs.readFileSync(transcriptPath, 'utf8');
          const lines = content.split('\n');

          for (let i = 0; i < Math.min(lines.length, 15); i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line.trim().replace(/^\uFEFF/, ''));
              if (parsed.type === 'USER_INPUT' && !firstPrompt) {
                const match = parsed.content ? parsed.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/) : null;
                firstPrompt = match ? match[1].trim() : (parsed.content || '').slice(0, 100);
              }
              if (parsed.workspacePaths && parsed.workspacePaths.length && !projectName) {
                projectName = path.basename(parsed.workspacePaths[0]);
              }
            } catch (e) {}
          }

          seenIds.add(convId);
          allSessions.push({
            conversationId: convId,
            projectName: projectName || ('Progetto ' + flavor),
            flavor,
            firstPrompt: firstPrompt || 'Sessione interattiva',
            mtime: stat.mtime,
            status: isRecentlyActive ? 'RUNNING' : 'COMPLETED',
            hasLock
          });
        } catch (e) {}
      }
    } catch (e) {}
  }

  // Ordina per data (più recenti prima)
  allSessions.sort((a, b) => {
    const timeA = a.lastActivity || a.mtime || a.startTime || 0;
    const timeB = b.lastActivity || b.mtime || b.startTime || 0;
    return new Date(timeB) - new Date(timeA);
  });

  return allSessions.slice(0, limit);
}

module.exports = {
  recordSessionStart,
  recordSessionTool,
  recordSessionStop,
  getActiveSessions,
  scanAllSessions
};
