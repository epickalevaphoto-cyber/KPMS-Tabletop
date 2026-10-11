const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Раздаем статику из папки public
app.use(express.static(path.join(__dirname, 'public')));

const roomsData = {}; // Хранилище состояния комнат в памяти

io.on('connection', (socket) => {
    socket.on('join_room', ({ room, name, role }) => {
        socket.join(room);
        socket.room = room;
        socket.userName = name;

        if (!roomsData[room]) {
            roomsData[room] = {
                mapImage: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?q=80&w=1200&auto=format&fit=crop',
                tokens: [
                    { id: 't1', name: 'Артур', x: 40, y: 50, isNpc: false },
                    { id: 't2', name: 'Эвита', x: 60, y: 50, isNpc: false }
                ],
                sheets: {},
                events: []
            };
        }

        // Отправляем текущее состояние комнаты подключившемуся
        socket.emit('state_sync', roomsData[room]);
    });

    socket.on('chat_message', ({ room, message }) => {
        if (roomsData[room]) {
            roomsData[room].events.push(message);
            io.to(room).emit('chat_message', message);
        }
    });

    socket.on('update_map', ({ room, mapImage }) => {
        if (roomsData[room]) {
            roomsData[room].mapImage = mapImage;
            io.to(room).emit('state_sync', roomsData[room]);
        }
    });

    socket.on('update_tokens', ({ room, tokens }) => {
        if (roomsData[room]) {
            roomsData[room].tokens = tokens;
            io.to(room).emit('state_sync', roomsData[room]);
        }
    });

    socket.on('update_sheet', ({ room, name, sheet }) => {
        if (roomsData[room]) {
            roomsData[room].sheets[name] = sheet;
            io.to(room).emit('sheet_updated', { name, sheet });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер КПМБ запущен на порту ${PORT}`);
});
