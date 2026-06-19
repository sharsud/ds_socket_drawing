/**
 * =========================================================================
 * DRAWBOT v19.0 — Pure Multi-Stage Socket Engine (Lobby -> Room Bypass)
 * =========================================================================
 */

'use strict';

const WebSocket = require('ws');

const CONFIG = {
    ROOM_NAME: 'The Tiger Room', 
    USERNAME: 'PsudoGhost',
    VERSION_HASH: '52a35d2755939386a8de91b399fc0ff770deb697',
    BASE_WS_URL: 'wss://server.drawasaurus.org'
};

const COMMON_HEADERS = {
    'Origin': 'https://www.drawasaurus.org',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9'
};

function authenticateAndJoin() {
    // Stage 1: Connect to the Global Lobby Socket
    const lobbyUrl = `${CONFIG.BASE_WS_URL}/room/lobby?version=${CONFIG.VERSION_HASH}`;
    console.log(`\n[STAGE 1] Connecting to Global Lobby: ${lobbyUrl}`);

    const lobbyWs = new WebSocket(lobbyUrl, { headers: COMMON_HEADERS });
    let clusterSessionId = null;

    lobbyWs.on('message', (rawData) => {
        const rawString = rawData.toString();
        console.log(`[LOBBY SERVER] -> ${rawString}`);

        try {
            const parsed = JSON.parse(rawString);
            if (!parsed || !Array.isArray(parsed.a)) return;
            const [eventName, ...args] = parsed.a;

            switch (eventName) {
                case 'setSession':
                    clusterSessionId = args[0];
                    console.log(`[LOBBY SESSION] Captured Token: ${clusterSessionId}`);
                    break;

                case 'requestUsername':
                    console.log(`[LOBBY HANDSHAKE] Submitting global identity registration...`);
                    // Exactly matches the outbound frame discovered in image_3c0662.png
                    const identityPayload = JSON.stringify({
                        a: ['submitUsername', CONFIG.USERNAME]
                    });
                    lobbyWs.send(identityPayload);
                    console.log(`[LOBBY CLIENT] <- ${identityPayload}`);
                    break;

                case 'setUsername':
                    console.log(`[LOBBY SUCCESS] Identity bound globally. Migrating to room socket...`);
                    // Cleanly disconnect from lobby state once authenticated
                    lobbyWs.close();
                    
                    // Proceed immediately to Stage 2
                    connectToGameRoom(clusterSessionId);
                    break;
            }
        } catch (e) {
            // Drop structural frame anomalies
        }
    });

    lobbyWs.on('error', (err) => console.error('[LOBBY ERROR]', err.message));
}

function connectToGameRoom(lobbySessionId) {
    const encodedRoom = encodeURIComponent(CONFIG.ROOM_NAME).replace(/%20/g, '+');
    const roomUrl = `${CONFIG.BASE_WS_URL}/room/${encodedRoom}?version=${CONFIG.VERSION_HASH}`;
    
    console.log(`\n[STAGE 2] Connecting to Game Room: ${roomUrl}`);

    const roomWs = new WebSocket(roomUrl, { headers: COMMON_HEADERS });
    
    // Maintain a local session state for this room socket connection
    let activeSessionId = lobbySessionId || "";
    let joinAttemptCount = 0;

    // Helper function to send a cleanly structured join payload
    function sendJoinRoomPayload() {
        joinAttemptCount++;
        const joinPayload = JSON.stringify({
            a: [
                'joinRoom',
                CONFIG.USERNAME,
                CONFIG.ROOM_NAME,
                activeSessionId // Inject the token dynamically
            ]
        });
        roomWs.send(joinPayload);
        console.log(`[ROOM CLIENT] (Attempt ${joinAttemptCount}) <- ${joinPayload}`);
    }

    roomWs.on('message', (rawData) => {
        const rawString = rawData.toString();
        console.log(`[ROOM SERVER] -> ${rawString}`);

        try {
            const parsed = JSON.parse(rawString);
            if (!parsed || !Array.isArray(parsed.a)) return;
            const [eventName, ...args] = parsed.a;

            switch (eventName) {
                // 1. The server gave us a fresh session ID for this room context!
                case 'setSession':
                    activeSessionId = args[0];
                    console.log(`[ROOM STATE] Captured fresh room session token: ${activeSessionId}`);
                    
                    // CRITICAL: Since our first attempt had a blank session, re-fire 
                    // the payload now that we have the server's official tracking ID!
                    if (joinAttemptCount < 2) {
                        console.log('[ROOM STATE] Re-dispatching join sequence with verified token...');
                        sendJoinRoomPayload();
                    }
                    break;

                // 2. Initial entry challenge request
                case 'requestUsername':
                    console.log(`[ROOM HANDSHAKE] Room challenge detected. Presenting credentials...`);
                    sendJoinRoomPayload();
                    break;

                // 3. Success state reached!
                case 'joinedRoom':
                    console.log(`\n[🎉 SUCCESS] Pure Socket Ghost has successfully materialized in the game room!`);
                    console.log(`[STATE] Active room: "${args[0]}"`);
                    console.log('──────────────────────────────────────────────────────────────────────────────');
                    
                    // Verify transmission channel stability by executing a room verification chat message
                    roomWs.send(JSON.stringify({ a: ['chat', 'Ghost socket client fully synchronized.'] }));
                    break;

                case 'roomError':
                    // If it fails on the very first try before we got 'setSession', don't panic or crash yet
                    if (joinAttemptCount === 1) {
                        console.log(`[ROOM WARN] Initial pass gave error: "${args[0]}". Waiting a moment for token synchronization...`);
                    } else {
                        console.error(`\n[❌ SERVER REJECTION] Allocation failed permanently: "${args[0]}"`);
                        roomWs.close();
                    }
                    break;

                case 'chatUser':
                    const [, sender, text] = args;
                    console.log(`[CHAT] ${sender}: ${text}`);
                    break;

                case 'ping':
                    roomWs.send(JSON.stringify({ a: ['ping'] }));
                    break;
            }
        } catch (e) {
            // Drop raw buffer serialization heartbeats cleanly
        }
    });

    roomWs.on('close', (code, reason) => {
        console.warn(`\n[CLOSED] Room connection severed. Code: ${code} | Reason: ${reason.toString() || 'None'}`);
    });

    roomWs.on('error', (err) => console.error('[ROOM ERROR]', err.message));
}

// Fire sequence
authenticateAndJoin();