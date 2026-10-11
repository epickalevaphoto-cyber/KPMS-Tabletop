const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Состояние комнат на сервере
const roomsState = {};

io.on('connection', (socket) => {
    socket.on('join_room', ({ room, name, role }) => {
        socket.join(room);
        socket.room = room;
        socket.userName = name;

        // Если комната создается впервые — создаем ЕЁ С ЧИСТОЙ КАРТОЙ (без начальных токенов)
        if (!roomsState[room]) {
            roomsState[room] = {
                mapImage: '',
                tokens: [], // ← ТЕПЕРЬ ТУТ ПУСТО! Никаких Артура и Эвиты по умолчанию
                sheets: {},
                events: []
            };
        }

        // Автоматически создаем токен для подключившегося игрока (если он не Мастер)
        if (role === 'player' && name) {
            const hasToken = roomsState[room].tokens.some(t => t.id === `user_${name}`);
            if (!hasToken) {
                roomsState[room].tokens.push({
                    id: `user_${name}`,
                    name: name,
                    x: 20 + Math.floor(Math.random() * 60),
                    y: 20 + Math.floor(Math.random() * 60)
                });
            }
        }

        // Отправляем текущее состояние подключившемуся клиенту
        socket.emit('state_sync', roomsState[room]);
    });

    socket.on('chat_message', ({ room, message }) => {
        if (roomsState[room]) {
            roomsState[room].events.push(message);
            io.to(room).emit('chat_message', message);
        }
    });

    socket.on('update_tokens', ({ room, tokens }) => {
        if (roomsState[room]) {
            roomsState[room].tokens = tokens;
            io.to(room).emit('state_sync', roomsState[room]);
        }
    });

    socket.on('update_map', ({ room, mapImage }) => {
        if (roomsState[room]) {
            roomsState[room].mapImage = mapImage;
            io.to(room).emit('state_sync', roomsState[room]);
        }
    });

    socket.on('update_sheet', ({ room, name, sheet }) => {
        if (roomsState[room]) {
            roomsState[room].sheets[name] = sheet;
            io.to(room).emit('sheet_updated', { name, sheet });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер КПМБ запущен на порту ${PORT}`);
});
