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

// Раздаем статические файлы из папки public
app.use(express.static(path.join(__dirname, 'public')));

// Файл для постоянного сохранения данных сессий
const DB_FILE = path.join(__dirname, 'rooms_db.json');
let roomsData = {};

// Загрузка базы данных из файла при старте, если он существует
if (fs.existsSync(DB_FILE)) {
    try {
        roomsData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        console.log('📦 База данных комнат успешно загружена с диска.');
    } catch (e) {
        console.error('⚠️ Ошибка при чтении файла базы данных, создаем пустую.', e);
        roomsData = {};
    }
}

// Функция сохранения базы данных на диск
function saveDb() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(roomsData, null, 2), 'utf8');
    } catch (e) {
        console.error('⚠️ Ошибка при сохранении базы данных:', e);
    }
}

io.on('connection', (socket) => {
    console.log(`🔌 Пользователь подключился: ${socket.id}`);

    // Подключение к комнате
    socket.on('join_room', ({ room, name, role }) => {
        socket.join(room);
        socket.room = room;
        socket.userName = name;
        socket.userRole = role;

        console.log(`👤 ${name} (${role}) вошел в комнату: ${room}`);

        // Инициализация комнаты, если её еще нет
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

        // Отправляем актуальное состояние комнаты вошедшему игроку/мастеру
        socket.emit('state_sync', roomsData[room]);
    });

    // Обработка сообщений общего чата (текст, картинки, броски кубиков)
    socket.on('chat_message', ({ room, message }) => {
        if (roomsData[room]) {
            // Ограничиваем историю чата последними 100 сообщениями
            if (roomsData[room].events.length > 100) {
                roomsData[room].events.shift();
            }
            roomsData[room].events.push(message);
            saveDb();
            // Рассылаем сообщение всем в комнате
            io.to(room).emit('chat_message', message);
        }
    });

    // Обновление карты (загрузка нового изображения Мастером)
    socket.on('update_map', ({ room, mapImage }) => {
        if (roomsData[room]) {
            roomsData[room].mapImage = mapImage;
            saveDb();
            io.to(room).emit('state_sync', roomsData[room]);
            console.log(`🗺 Карте в комнате ${room} обновлена.`);
        }
    });

    // Обновление позиций токенов при перетаскивании
    socket.on('update_tokens', ({ room, tokens }) => {
        if (roomsData[room]) {
            roomsData[room].tokens = tokens;
            saveDb();
            io.to(room).emit('state_sync', roomsData[room]);
        }
    });

    // Обновление официального чарлиста участника
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
