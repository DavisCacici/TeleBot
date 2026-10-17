const fs = require('fs');
const path = require('path');
const os = require('os');
const { getProjectByConversation, listProjects } = require('./projects');

// Mappa in memoria delle sessioni attive monitorate in tempo reale
const inMemorySessions = new Map();

const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const FLAVORS = ['antigravity-ide', 'antigravity', 'antigravity-cli'];

function extractProjectFromContent(content, convId) {
  if (convId) {
    try {
      const fromState = getProjectByConversation(convId);
      if (fromState) return fromState;
    } catch (e) {}
  }

  if (!content) return null;

  let knownProjects = [];
  try {
    knownProjects = listProjects().map(p => p.name);
  } catch (e) {}

  // 1. Cerca percorsi in PROJECTS_DIR o _SORGENTI (es. C:\_SORGENTI\TeleBot o /_SORGENTI/resellio)
  const sorgentiMatch = content.match(/(?:[A-Za-z]:)?[\/\\]+_?SORGENTI[\/\\]+([a-zA-Z0-9_\-\.]+)/i);
  if (sorgentiMatch && sorgentiMatch[1]) {
    const folder = sorgentiMatch[1].replace(/[\/\\]/g, '').trim();
    const known = knownProjects.find(k => k.toLowerCase() === folder.toLowerCase());
    return known || folder;
  }

  // 2. Cerca Active Document
  const docMatch = content.match(/Active Document:\s*([c-zC-Z]:[^\r\n\(\)]+)/i);
  if (docMatch) {
    const norm = docMatch[1].replace(/\\\\/g, '/').replace(/\\/g, '/');
    const parts = norm.split('/').filter(Boolean);
    const sorgIdx = parts.findIndex(p => p.toUpperCase() === '_SORGENTI');
    if (sorgIdx !== -1 && parts[sorgIdx + 1]) {
      return parts[sorgIdx + 1];
    }
  }

  // 3. Cerca Cwd in tool calls o comandi
  const cwdMatch = content.match(/"Cwd"\s*:\s*"?\\*"*([A-Za-z]:\\[^",\r\n}]+)/i);
  if (cwdMatch) {
    const cleaned = cwdMatch[1].replace(/\\\\/g, '/').replace(/\\/g, '/').replace(/^[\\"]+|[\\"]+$/g, '');
    const mSorg = cleaned.match(/_SORGENTI\/([^/\s]+)/i);
    if (mSorg) return mSorg[1];
    return path.basename(cleaned);
  }

  // 4. Cerca corrispondenze con le cartelle dei progetti noti
  for (const kp of knownProjects) {
    if (content.includes('/' + kp) || content.includes('\\' + kp) || content.includes('"' + kp + '"')) {
      return kp;
    }
  }

  return null;
}

function recordSessionStart({ conversationId, activityId, projectName, workspacePaths, modelName, source = 'IDE' }) {
  if (!conversationId) return;
  let project = projectName;
  if (!project || project === 'Antigravity Workspace' || project.startsWith('Progetto ')) {
    if (workspacePaths && workspacePaths.length) {
      project = path.basename(workspacePaths[0]);
    }
    if (!project || project === 'Antigravity Workspace') {
      try {
        project = getProjectByConversation(conversationId);
      } catch (e) {}
    }
  }
  project = project || 'Generale';
  
  const existing = inMemorySessions.get(conversationId) || {};
  inMemorySessions.set(conversationId, {
    ...existing,
    conversationId,
    activityId: activityId || existing.activityId,
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
    session.activityId = null;
  }
}

function getSession(conversationId) {
  if (!conversationId) return null;
  return inMemorySessions.get(conversationId) || null;
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
function scanAllSessions(limit = 3, reverseOrder = true) {
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
            } catch (e) {}
          }

          const detectedProj = extractProjectFromContent(content, convId);
          const projectName = detectedProj || ('Progetto ' + flavor);

          seenIds.add(convId);
          allSessions.push({
            conversationId: convId,
            projectName,
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

  const topSessions = allSessions.slice(0, limit);
  return reverseOrder ? topSessions.reverse() : topSessions;
}

module.exports = {
  recordSessionStart,
  recordSessionTool,
  recordSessionStop,
  getSession,
  getActiveSessions,
  scanAllSessions
};
