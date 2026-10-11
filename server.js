const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Увеличиваем лимит размера входящих данных (для картинок в чате до 10 МБ)
const io = new Server(server, {
    maxHttpBufferSize: 10 * 1024 * 1024 
});

app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'rooms_db.json');
let roomsData = {};

if (fs.existsSync(DB_FILE)) {
    try {
        roomsData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        console.log('📦 База данных комнат успешно загружена с диска.');
    } catch (e) {
        console.error('⚠️ Ошибка при чтении файла базы данных, создаем пустую.', e);
        roomsData = {};
    }
}

function saveDb() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(roomsData, null, 2), 'utf8');
    } catch (e) {
        console.error('⚠️ Ошибка при сохранении базы данных:', e);
    }
}

io.on('connection', (socket) => {
    console.log(`🔌 Пользователь подключился: ${socket.id}`);

    socket.on('join_room', ({ room, name, role }) => {
        socket.join(room);
        socket.room = room;
        socket.userName = name;
        socket.userRole = role;

        console.log(`👤 ${name} (${role}) вошел в комнату: ${room}`);

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
            if (roomsData[room].events.length > 150) {
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

    // Обновление чарлиста (теперь поддерживает изменения как от игроков, так и от Мастера)
    socket.on('update_sheet', ({ room, name, sheet }) => {
        if (roomsData[room]) {
            roomsData[room].sheets[name] = sheet;
            saveDb();
            io.to(room).emit('sheet_updated', { name, sheet });
        }
    });

    socket.on('disconnect', () => {
        console.log(`❌ Пользователь отключился: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✨ Сервер КПМБ запущен и слушает порт ${PORT}`);
});
