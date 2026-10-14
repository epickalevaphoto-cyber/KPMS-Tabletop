const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'rooms.json');

// Загрузка сохраненных данных при старте сервера
let roomsState = {};
try {
    if (fs.existsSync(DATA_FILE)) {
        roomsState = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        console.log('Данные комнат успешно загружены с диска.');
    }
} catch (e) {
    console.error('Ошибка при чтении файла данных:', e);
}

// Функция автоматического сохранения на диск
function saveState() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(roomsState, null, 2), 'utf8');
    } catch (e) {
        console.error('Ошибка при сохранении данных на диск:', e);
    }
}

io.on('connection', (socket) => {
    socket.on('join_room', ({ room, name, role }) => {
        socket.join(room);
        socket.room = room;
        socket.userName = name;

        if (!roomsState[room]) {
            roomsState[room] = {
                mapImage: '',
                tokens: [],
                sheets: {},
                events: []
            };
            saveState();
        }

        if (role === 'player' && name) {
            const hasToken = roomsState[room].tokens.some(t => t.id === `user_${name}`);
            if (!hasToken) {
                roomsState[room].tokens.push({
                    id: `user_${name}`,
                    name: name,
                    x: 20 + Math.floor(Math.random() * 60),
                    y: 20 + Math.floor(Math.random() * 60)
                });
                saveState();
            }
        }

        socket.emit('state_sync', roomsState[room]);
    });

    socket.on('chat_message', ({ room, message }) => {
        if (roomsState[room]) {
            roomsState[room].events.push(message);
            saveState();
            io.to(room).emit('chat_message', message);
        }
    });

    socket.on('update_tokens', ({ room, tokens }) => {
        if (roomsState[room]) {
            roomsState[room].tokens = tokens;
            saveState();
            io.to(room).emit('state_sync', roomsState[room]);
        }
    });

    socket.on('update_map', ({ room, mapImage }) => {
        if (roomsState[room]) {
            roomsState[room].mapImage = mapImage;
            saveState();
            io.to(room).emit('state_sync', roomsState[room]);
        }
    });

    socket.on('update_sheet', ({ room, name, sheet }) => {
        if (roomsState[room]) {
            roomsState[room].sheets[name] = sheet;
            saveState();
            io.to(room).emit('sheet_updated', { name, sheet });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер КПМБ запущен на порту ${PORT}`);
});
