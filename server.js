const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

// Configurazione Mondo di Gioco
const MAP_SIZE = 2000; 
const players = {};
const islands = [];

// Generazione randomica delle isole (Eseguita una volta all'avvio)
function generateIslands() {
    for (let i = 0; i < 15; i++) {
        islands.push({
            id: i,
            x: Math.random() * (MAP_SIZE - 200) + 100,
            y: Math.random() * (MAP_SIZE - 200) + 100,
            radius: Math.random() * 60 + 30 // Dimensioni piccole/medie
        });
    }
}
generateIslands();

io.on('connection', (socket) => {
    console.log(`Pirata connesso: ${socket.id}`);

    // Il giocatore viene creato solo DOPO aver inserito il nome nel menu
    socket.on('joinGame', (username) => {
        players[socket.id] = {
            id: socket.id,
            name: username || "Anonimo",
            x: Math.random() * (MAP_SIZE - 100) + 50,
            y: Math.random() * (MAP_SIZE - 100) + 50,
            targetX: null,
            targetY: null,
            speed: 4,
            radius: 20, // Raggio di collisione della nave
            color: `hsl(${Math.random() * 360}, 70%, 50%)`
        };
        // Invia i dati delle isole solo al giocatore che è appena entrato
        socket.emit('initIslands', islands);
    });

    socket.on('moveCommand', (target) => {
        if (players[socket.id]) {
            players[socket.id].targetX = target.x;
            players[socket.id].targetY = target.y;
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
    });
});

// --- GAME LOOP DEL SERVER (30 Volte al secondo) ---
setInterval(() => {
    for (let id in players) {
        const p = players[id];
        if (p.targetX !== null && p.targetY !== null) {
            // Calcolo della distanza dal target
            const dx = p.targetX - p.x;
            const dy = p.targetY - p.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance > 5) { // Se è abbastanza lontano dal punto di click, si muove
                // Memorizza la posizione precedente in caso di collisione
                const prevX = p.x;
                const prevY = p.y;

                // Calcolo vettore di movimento fluido
                p.x += (dx / distance) * p.speed;
                p.y += (dy / distance) * p.speed;

                // 1. Collisione con i bordi della mappa
                if (p.x < 0 || p.x > MAP_SIZE) p.x = prevX;
                if (p.y < 0 || p.y > MAP_SIZE) p.y = prevY;

                // 2. Collisione con le Isole (Cerchio contro Cerchio)
                for (let island of islands) {
                    const idx = p.x - island.x;
                    const idy = p.y - island.y;
                    const distIsland = Math.sqrt(idx * idx + idy * idy);
                    
                    // Se la distanza è minore della somma dei due raggi -> COLLISIONE
                    if (distIsland < p.radius + island.radius) {
                        p.x = prevX;
                        p.y = prevY;
                        p.targetX = null; // Ferma la nave
                        p.targetY = null;
                        break;
                    }
                }
            } else {
                p.targetX = null;
                p.targetY = null;
            }
        }
    }
    // Invia lo stato globale aggiornato a tutti i client
    io.emit('updatePlayers', players);
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server online sulla porta ${PORT}`));