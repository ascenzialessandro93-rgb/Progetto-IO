const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

const MAP_SIZE = 3000; // Mappa ingrandita per esplorare meglio
const players = {};
const islands = [];
const bullets = [];

// Generazione isole con controllo sovrapposizione e forme irregolari
function generateIslands() {
    let attempts = 0;
    while (islands.length < 18 && attempts < 100) {
        attempts++;
        const mainRadius = Math.random() * 70 + 40;
        const mainX = Math.random() * (MAP_SIZE - 300) + 150;
        const mainY = Math.random() * (MAP_SIZE - 300) + 150;

        // Controlla se si sovrappone a isole esistenti
        let overlapping = false;
        for (let is of islands) {
            // Controlla contro il centro di ogni sotto-cerchio dell'isola esistente
            for (let sub of is.circles) {
                const dx = mainX - sub.x;
                const dy = mainY - sub.y;
                if (Math.sqrt(dx*dx + dy*dy) < mainRadius + sub.radius + 40) {
                    overlapping = true;
                    break;
                }
            }
            if (overlapping) break;
        }

        if (!overlapping) {
            // Crea una forma irregolare unendo più cerchi attorno al centro
            const islandCircles = [{ x: mainX, y: mainY, radius: mainRadius }];
            const subCirclesCount = Math.floor(Math.random() * 3) + 2; // 2 o 4 cerchi extra
            
            for (let j = 0; j < subCirclesCount; j++) {
                const angle = Math.random() * Math.PI * 2;
                const distance = Math.random() * (mainRadius * 0.5);
                islandCircles.push({
                    x: mainX + Math.cos(angle) * distance,
                    y: mainY + Math.sin(angle) * distance,
                    radius: mainRadius * (Math.random() * 0.4 + 0.5) // Più piccoli del centro
                });
            }
            islands.push({ id: islands.length, circles: islandCircles });
        }
    }
}
generateIslands();

io.on('connection', (socket) => {
    socket.on('joinGame', (username) => {
        players[socket.id] = {
            id: socket.id,
            name: username || "Anonimo",
            x: Math.random() * (MAP_SIZE - 200) + 100,
            y: Math.random() * (MAP_SIZE - 200) + 100,
            targetX: null, targetY: null,
            speed: 4, radius: 22, angle: 0,
            maxHp: 100, hp: 100, isDead: false,
            color: `hsl(${Math.random() * 360}, 70%, 50%)`
        };
        socket.emit('initIslands', islands);
    });

    socket.on('moveCommand', (target) => {
        const p = players[socket.id];
        if (p && !p.isDead) {
            p.targetX = target.x;
            p.targetY = target.y;
        }
    });

    // Comando di fuoco: calcola i colpi laterali (sinistra e destra)
    socket.on('shootCommand', () => {
        const p = players[socket.id];
        if (p && !p.isDead) {
            // Cannone Destro (+90 gradi rispetto alla prua)
            bullets.push({
                id: Math.random(), playerId: socket.id,
                x: p.x, y: p.y,
                vx: Math.cos(p.angle + Math.PI / 2) * 8,
                vy: Math.sin(p.angle + Math.PI / 2) * 8,
                life: 45 // Durata del proiettile in frame
            });
            // Cannone Sinistro (-90 gradi rispetto alla prua)
            bullets.push({
                id: Math.random(), playerId: socket.id,
                x: p.x, y: p.y,
                vx: Math.cos(p.angle - Math.PI / 2) * 8,
                vy: Math.sin(p.angle - Math.PI / 2) * 8,
                life: 45
            });
        }
    });

    socket.on('disconnect', () => { delete players[socket.id]; });
});

// LOOP FISICA (30 FPS)
setInterval(() => {
    // 1. Aggiorna Movimento Giocatori
    for (let id in players) {
        const p = players[id];
        if (p.isDead) continue;

        if (p.targetX !== null && p.targetY !== null) {
            const dx = p.targetX - p.x;
            const dy = p.targetY - p.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance > 8) {
                // Calcola l'angolo di navigazione attuale verso il target
                p.angle = Math.atan2(dy, dx);

                const prevX = p.x;
                const prevY = p.y;
                p.x += (dx / distance) * p.speed;
                p.y += (dy / distance) * p.speed;

                // Collisione Bordi
                if (p.x < 0 || p.x > MAP_SIZE) p.x = prevX;
                if (p.y < 0 || p.y > MAP_SIZE) p.y = prevY;

                // Collisione Isole Irregolari
                let hitIsland = false;
                for (let island of islands) {
                    for (let circle of island.circles) {
                        const idx = p.x - circle.x;
                        const idy = p.y - circle.y;
                        if (Math.sqrt(idx*idx + idy*idy) < p.radius + circle.radius) {
                            hitIsland = true;
                            break;
                        }
                    }
                    if (hitIsland) break;
                }
                if (hitIsland) {
                    p.x = prevX; p.y = prevY;
                    p.targetX = null; p.targetY = null;
                }
            } else {
                p.targetX = null; p.targetY = null;
            }
        }
    }

    // 2. Aggiorna Proiettili e Collisioni Danni
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.vx;
        b.y += b.vy;
        b.life--;

        let bulletRemoved = false;

        // Collisione proiettili con Isole
        for (let island of islands) {
            for (let circle of island.circles) {
                const dx = b.x - circle.x;
                const dy = b.y - circle.y;
                if (Math.sqrt(dx*dx + dy*dy) < circle.radius) {
                    bullets.splice(i, 1);
                    bulletRemoved = true;
                    break;
                }
            }
            if (bulletRemoved) break;
        }
        if (bulletRemoved) continue;

        // Collisione proiettili con Navi nemiche
        for (let id in players) {
            const target = players[id];
            if (target.isDead || id === b.playerId) continue;

            const dx = b.x - target.x;
            const dy = b.y - target.y;
            if (Math.sqrt(dx*dx + dy*dy) < target.radius) {
                target.hp -= 15; // Danno del cannone
                bullets.splice(i, 1);
                bulletRemoved = true;

                if (target.hp <= 0) {
                    target.isDead = true;
                    target.targetX = null; target.targetY = null;
                    // Respawn automatico dopo 4 secondi
                    setTimeout(() => {
                        if (players[id]) {
                            players[id].hp = 100;
                            players[id].isDead = false;
                            players[id].x = Math.random() * (MAP_SIZE - 200) + 100;
                            players[id].y = Math.random() * (MAP_SIZE - 200) + 100;
                        }
                    }, 4000);
                }
                break;
            }
        }

        if (!bulletRemoved && b.life <= 0) {
            bullets.splice(i, 1);
        }
    }

    io.emit('updateState', { players, bullets });
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server veleggiante sulla porta ${PORT}`));