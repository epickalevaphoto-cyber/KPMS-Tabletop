const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'rooms_db.json');
let roomsData = {};

if (fs.existsSync(DB_FILE)) {
    try {
        roomsData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        roomsData = {};
    }
}

function saveDb() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(roomsData, null, 2), 'utf8');
    } catch (e) {}
}

io.on('connection', (socket) => {
    socket.on('join_room', ({ room, name, role }) => {
        socket.join(room);
        socket.room = room;
        socket.userName = name;
        socket.userRole = role;

        if (!roomsData[room]) {
            roomsData[room] = {
                mapImage: '',
                tokens: [
                    { id: 't1', name: 'Артур', x: 40, y: 50, isNpc: false },
                    { id: 't2', name: 'Эвита', x: 60, y: 50, isNpc: false }
                ],
                sheets: {},
                events: []
            };
            saveDb();
        }

        socket.emit('state_sync', roomsData[room]);
    });

    socket.on('chat_message', ({ room, message }) => {
        if (roomsData[room]) {
            // Ограничиваем историю чата последними 100 сообщениями, чтобы база не разрасталась
            if (roomsData[room].events.length > 100) {
                roomsData[room].events.shift();
            }
            roomsData[room].events.push(message);
            saveDb();
            io.to(room).emit('chat_message', message);
        }
    });

    socket.on('update_map', ({ room, mapImage }) => {
        if (roomsData[room]) {
            roomsData[room].mapImage = mapImage;
            saveDb();
            io.to(room).emit('state_sync', roomsData[room]);
        }
    });

    socket.on('update_tokens', ({ room, tokens }) => {
        if (roomsData[room]) {
            roomsData[room].tokens = tokens;
            saveDb();
            io.to(room).emit('state_sync', roomsData[room]);
        }
    });

    socket.on('update_sheet', ({ room, name, sheet }) => {
        if (roomsData[room]) {
            roomsData[room].sheets[name] = sheet;
            saveDb();
            io.to(room).emit('sheet_updated', { name, sheet });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✨ Сервер КПМБ запущен на порту ${PORT}`);
});
