'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

// Google Sheets stores character sheets persistently. rooms.json remains a local
// fallback for maps, tokens, chat/events, and for offline/development use.
const DATA_FILE = path.join(__dirname, 'rooms.json');
const GOOGLE_SHEETS_URL = (process.env.GOOGLE_SHEETS_URL || '').trim();
const GOOGLE_SHEETS_SECRET = (process.env.GOOGLE_SHEETS_SECRET || '').trim();
const SHEET_SAVE_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60_000;

let roomsState = {};
const pendingSheetSaves = new Map();
const sheetSaveTimers = new Map();
const retryCounts = new Map();
const inFlightSheetSaves = new Set();

function normalizeRoomState(state) {
    const safe = state && typeof state === 'object' ? state : {};
    return {
        mapImage: typeof safe.mapImage === 'string' ? safe.mapImage : '',
        tokens: Array.isArray(safe.tokens) ? safe.tokens : [],
        sheets: safe.sheets && typeof safe.sheets === 'object' && !Array.isArray(safe.sheets) ? safe.sheets : {},
        events: Array.isArray(safe.events) ? safe.events : []
    };
}

try {
    if (fs.existsSync(DATA_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [room, state] of Object.entries(parsed)) {
                roomsState[room] = normalizeRoomState(state);
            }
        }
        console.log('Р›РѕРєР°Р»СЊРЅРѕРµ СЃРѕСЃС‚РѕСЏРЅРёРµ РєРѕРјРЅР°С‚ Р·Р°РіСЂСѓР¶РµРЅРѕ РёР· rooms.json.');
    }
} catch (error) {
    console.error('РќРµ СѓРґР°Р»РѕСЃСЊ РїСЂРѕС‡РёС‚Р°С‚СЊ rooms.json:', error.message);
}

function saveState() {
    const tempFile = `${DATA_FILE}.tmp`;
    try {
        fs.writeFileSync(tempFile, JSON.stringify(roomsState, null, 2), 'utf8');
        fs.renameSync(tempFile, DATA_FILE);
    } catch (error) {
        console.error('РћС€РёР±РєР° СЃРѕС…СЂР°РЅРµРЅРёСЏ rooms.json:', error.message);
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
    }
}

function sheetsConfigured() {
    return Boolean(GOOGLE_SHEETS_URL && GOOGLE_SHEETS_SECRET);
}

async function callGoogleSheets(payload) {
    if (!sheetsConfigured()) {
        throw new Error('РќРµ Р·Р°РґР°РЅС‹ GOOGLE_SHEETS_URL Рё/РёР»Рё GOOGLE_SHEETS_SECRET');
    }

    const response = await fetch(GOOGLE_SHEETS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...payload, secret: GOOGLE_SHEETS_SECRET }),
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000)
    });

    if (!response.ok) throw new Error(`Google Apps Script РІРµСЂРЅСѓР» HTTP ${response.status}`);

    const result = await response.json();
    if (!result || result.ok !== true) {
        throw new Error(result && result.error ? result.error : 'РќРµРёР·РІРµСЃС‚РЅР°СЏ РѕС€РёР±РєР° Google Sheets');
    }
    return result;
}

function sheetKey(room, name) {
    return `${String(room)}::${String(name)}`;
}

function scheduleSheetSave(room, name, sheet, socket) {
    const key = sheetKey(room, name);
    pendingSheetSaves.set(key, {
        room: String(room),
        name: String(name),
        sheet: JSON.parse(JSON.stringify(sheet)),
        socketId: socket ? socket.id : null
    });

    if (sheetSaveTimers.has(key)) clearTimeout(sheetSaveTimers.get(key));
    const timer = setTimeout(() => processSheetSave(key), SHEET_SAVE_DELAY_MS);
    sheetSaveTimers.set(key, timer);
}

async function processSheetSave(key) {
    sheetSaveTimers.delete(key);
    if (inFlightSheetSaves.has(key)) {
        const timer = setTimeout(() => processSheetSave(key), 150);
        sheetSaveTimers.set(key, timer);
        return;
    }
    const entry = pendingSheetSaves.get(key);
    if (!entry) return;
    inFlightSheetSaves.add(key);

    // Keep a reference to the version being sent. If a newer version arrives while
    // the request is in flight, do not delete the newer version on success.
    const versionBeingSaved = entry;
    try {
        await callGoogleSheets({
            action: 'save_sheet',
            room: versionBeingSaved.room,
            name: versionBeingSaved.name,
            sheet: versionBeingSaved.sheet
        });

        if (pendingSheetSaves.get(key) === versionBeingSaved) {
            pendingSheetSaves.delete(key);
            retryCounts.delete(key);
        } else {
            // A newer edit arrived while the previous version was being saved.
            const timer = setTimeout(() => processSheetSave(key), 100);
            sheetSaveTimers.set(key, timer);
        }

        if (versionBeingSaved.socketId) {
            io.to(versionBeingSaved.socketId).emit('sheet_save_status', {
                name: versionBeingSaved.name,
                ok: true,
                savedAt: new Date().toISOString()
            });
        }
        console.log(`Р§Р°СЂР»РёСЃС‚ В«${versionBeingSaved.name}В» СЃРѕС…СЂР°РЅС‘РЅ РІ Google Sheets.`);
    } catch (error) {
        const attempts = (retryCounts.get(key) || 0) + 1;
        retryCounts.set(key, attempts);
        console.error(`РћС€РёР±РєР° СЃРѕС…СЂР°РЅРµРЅРёСЏ В«${versionBeingSaved.name}В» (РїРѕРїС‹С‚РєР° ${attempts}):`, error.message);

        if (versionBeingSaved.socketId) {
            io.to(versionBeingSaved.socketId).emit('sheet_save_status', {
                name: versionBeingSaved.name,
                ok: false,
                message: 'РќРµ СѓРґР°Р»РѕСЃСЊ СЃРѕС…СЂР°РЅРёС‚СЊ РІ Google Sheets. РЎРµСЂРІРµСЂ РїРѕРІС‚РѕСЂРёС‚ РїРѕРїС‹С‚РєСѓ.'
            });
        }

        // Keep the newest pending version and retry with bounded exponential backoff.
        if (!pendingSheetSaves.has(key)) pendingSheetSaves.set(key, versionBeingSaved);
        const delay = Math.min(1000 * (2 ** Math.min(attempts - 1, 6)), MAX_RETRY_DELAY_MS);
        if (sheetSaveTimers.has(key)) clearTimeout(sheetSaveTimers.get(key));
        const timer = setTimeout(() => processSheetSave(key), delay);
        sheetSaveTimers.set(key, timer);
    } finally {
        inFlightSheetSaves.delete(key);
        // If a newer edit arrived while the request was in flight, ensure it is sent next.
        if (pendingSheetSaves.has(key) && !sheetSaveTimers.has(key)) {
            const timer = setTimeout(() => processSheetSave(key), 100);
            sheetSaveTimers.set(key, timer);
        }
    }
}

async function loadSheetsFromGoogle() {
    if (!sheetsConfigured()) {
        console.warn('Google Sheets РЅРµ РЅР°СЃС‚СЂРѕРµРЅС‹. Р§Р°СЂР»РёСЃС‚С‹ РїРѕРєР° Р·Р°РіСЂСѓР¶Р°СЋС‚СЃСЏ РёР· Р»РѕРєР°Р»СЊРЅРѕРіРѕ rooms.json.');
        return;
    }

    const localSheets = [];
    for (const [room, state] of Object.entries(roomsState)) {
        for (const [name, sheet] of Object.entries(state.sheets || {})) {
            localSheets.push({ room, name, sheet });
        }
    }

    try {
        const result = await callGoogleSheets({ action: 'load_all' });
        const googleKeys = new Set();
        let loaded = 0;

        for (const item of Array.isArray(result.sheets) ? result.sheets : []) {
            if (!item || !item.room || !item.name || !item.sheet || typeof item.sheet !== 'object') continue;
            const room = String(item.room);
            const name = String(item.name);
            googleKeys.add(sheetKey(room, name));
            if (!roomsState[room]) roomsState[room] = normalizeRoomState({});
            roomsState[room] = normalizeRoomState(roomsState[room]);
            roomsState[room].sheets[name] = item.sheet;
            loaded++;
        }

        let migrated = 0;
        for (const item of localSheets) {
            const key = sheetKey(item.room, item.name);
            // Google Sheets is authoritative if the same room/name already exists.
            if (googleKeys.has(key)) continue;
            try {
                await callGoogleSheets({ action: 'save_sheet', room: item.room, name: item.name, sheet: item.sheet });
                googleKeys.add(key);
                migrated++;
            } catch (error) {
                console.error(`РќРµ СѓРґР°Р»РѕСЃСЊ РїРµСЂРµРЅРµСЃС‚Рё Р»РѕРєР°Р»СЊРЅС‹Р№ С‡Р°СЂР»РёСЃС‚ В«${item.name}В»:`, error.message);
            }
        }

        saveState();
        console.log(`Google Sheets: Р·Р°РіСЂСѓР¶РµРЅРѕ ${loaded}, РїРµСЂРµРЅРµСЃРµРЅРѕ РёР· rooms.json ${migrated}.`);
    } catch (error) {
        // Do not overwrite local state with an empty result if the API is unavailable.
        console.error('РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ Google Sheets:', error.message);
        console.warn('РџСЂРѕРґРѕР»Р¶Р°РµРј СЂР°Р±РѕС‚Сѓ СЃ Р»РѕРєР°Р»СЊРЅС‹Рј rooms.json; РїСЂРѕРІРµСЂСЊС‚Рµ URL Рё СЃРµРєСЂРµС‚ Apps Script.');
    }
}

function getRoom(room) {
    if (!roomsState[room]) roomsState[room] = normalizeRoomState({});
    roomsState[room] = normalizeRoomState(roomsState[room]);
    return roomsState[room];
}

io.on('connection', (socket) => {
    socket.on('join_room', (payload = {}) => {
        const room = String(payload.room || '').trim();
        const name = String(payload.name || '').trim();
        const role = payload.role === 'master' ? 'master' : 'player';
        if (!room || !name) {
            socket.emit('app_error', { message: 'РќРµ СѓРєР°Р·Р°РЅС‹ РєРѕРјРЅР°С‚Р° РёР»Рё РёРјСЏ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ.' });
            return;
        }

        if (socket.room && socket.room !== room) socket.leave(socket.room);
        socket.join(room);
        socket.room = room;
        socket.userName = name;
        socket.userRole = role;

        const state = getRoom(room);
        if (role === 'player') {
            const hasToken = state.tokens.some(token => token && token.id === `user_${name}`);
            if (!hasToken) {
                state.tokens.push({
                    id: `user_${name}`,
                    name,
                    x: 20 + Math.floor(Math.random() * 60),
                    y: 20 + Math.floor(Math.random() * 60)
                });
                saveState();
            }
        }
        socket.emit('state_sync', state);
    });

    socket.on('chat_message', (payload = {}) => {
        const room = String(payload.room || socket.room || '');
        const message = payload.message;
        if (!room || room !== socket.room || !message || !roomsState[room]) return;
        const state = getRoom(room);
        state.events.push(message);
        if (state.events.length > 500) state.events = state.events.slice(-500);
        saveState();
        io.to(room).emit('chat_message', message);
    });

    socket.on('update_tokens', (payload = {}) => {
        const room = String(payload.room || socket.room || '');
        if (!room || room !== socket.room || !roomsState[room] || !Array.isArray(payload.tokens)) return;
        // Existing app supports master token movement; this checks room membership,
        // but a full authentication system is still needed for a public deployment.
        getRoom(room).tokens = payload.tokens;
        saveState();
        io.to(room).emit('state_sync', roomsState[room]);
    });

    socket.on('update_map', (payload = {}) => {
        const room = String(payload.room || socket.room || '');
        if (!room || room !== socket.room || !roomsState[room]) return;
        if (typeof payload.mapImage !== 'string') return;
        getRoom(room).mapImage = payload.mapImage;
        saveState();
        io.to(room).emit('state_sync', roomsState[room]);
    });

    socket.on('update_sheet', (payload = {}) => {
        const room = String(payload.room || socket.room || '').trim();
        const name = String(payload.name || '').trim();
        const sheet = payload.sheet;
        if (!room || room !== socket.room || !name || !sheet || typeof sheet !== 'object' || Array.isArray(sheet)) return;
        if (!roomsState[room]) return;

        // Players may update only their own sheet. Masters can update sheets in their room.
        if (socket.userRole !== 'master' && socket.userName !== name) {
            socket.emit('app_error', { message: 'РќРµС‚ РїСЂР°РІ РґР»СЏ РёР·РјРµРЅРµРЅРёСЏ СЌС‚РѕРіРѕ С‡Р°СЂР»РёСЃС‚Р°.' });
            return;
        }

        const state = getRoom(room);
        state.sheets[name] = sheet;
        saveState(); // local fallback
        scheduleSheetSave(room, name, sheet, socket);
        io.to(room).emit('sheet_updated', { name, sheet });
    });

    socket.on('disconnect', () => {
        // Timed saves are kept in the process queue even after the originating socket disconnects.
    });
});

const PORT = Number(process.env.PORT) || 3000;

(async () => {
    // Load durable character sheets before accepting client connections. This prevents
    // an empty client state from being sent and overwriting an existing character.
    await loadSheetsFromGoogle();
    server.listen(PORT, () => {
        console.log(`РЎРµСЂРІРµСЂ РљРџРњР‘ Р·Р°РїСѓС‰РµРЅ РЅР° РїРѕСЂС‚Сѓ ${PORT}`);
    });
})();

async function shutdown(signal) {
    console.log(`РџРѕР»СѓС‡РµРЅ ${signal}, Р·Р°РІРµСЂС€Р°РµРј СЂР°Р±РѕС‚Сѓ...`);
    for (const timer of sheetSaveTimers.values()) clearTimeout(timer);
    sheetSaveTimers.clear();

    // Best-effort flush of pending sheet writes before shutdown.
    const pending = Array.from(pendingSheetSaves.entries());
    for (const [key, entry] of pending) {
        try {
            await callGoogleSheets({ action: 'save_sheet', room: entry.room, name: entry.name, sheet: entry.sheet });
            pendingSheetSaves.delete(key);
        } catch (error) {
            console.error(`РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РІРµСЂС€РёС‚СЊ СЃРѕС…СЂР°РЅРµРЅРёРµ В«${entry.name}В»:`, error.message);
        }
    }

    saveState();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
