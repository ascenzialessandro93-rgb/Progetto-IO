const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

const MAP_SIZE = 8000; 
const players = {};
const islands = [];
const bullets = [];
const npcs = {};
let npcIdCounter = 0;

// Genera 60 isole (molto più grandi)
function generateIslands() {
    let attempts = 0;
    while (islands.length < 60 && attempts < 500) {
        attempts++;
        const mainRadius = Math.random() * 150 + 80; // Isole enormi
        const mainX = Math.random() * (MAP_SIZE - 600) + 300;
        const mainY = Math.random() * (MAP_SIZE - 600) + 300;

        let overlapping = false;
        for (let is of islands) {
            for (let sub of is.circles) {
                const dx = mainX - sub.x; const dy = mainY - sub.y;
                if (Math.sqrt(dx*dx + dy*dy) < mainRadius + sub.radius + 80) { overlapping = true; break; }
            }
            if (overlapping) break;
        }

        if (!overlapping) {
            const islandCircles = [{ x: mainX, y: mainY, radius: mainRadius }];
            const subCirclesCount = Math.floor(Math.random() * 4) + 2;
            for (let j = 0; j < subCirclesCount; j++) {
                const angle = Math.random() * Math.PI * 2;
                const distance = Math.random() * (mainRadius * 0.6);
                islandCircles.push({
                    x: mainX + Math.cos(angle) * distance, y: mainY + Math.sin(angle) * distance,
                    radius: mainRadius * (Math.random() * 0.5 + 0.5)
                });
            }
            islands.push({ id: islands.length, circles: islandCircles });
        }
    }
}
generateIslands();

// Costi del Negozio (Per sbloccare il Tier successivo, devi completare il precedente)
const SHOP_TIERS = {
    1: { gold: 50,  hpBonus: 50, sizeBonus: 5, cannons: 4 }, // 4 cannoni totali (2 per lato)
    2: { gold: 150, hpBonus: 80, sizeBonus: 8, cannons: 6 }, // 6 cannoni
    3: { gold: 300, hpBonus: 120, sizeBonus: 10, cannons: 8 } // 8 cannoni (Max)
};

io.on('connection', (socket) => {
    socket.on('joinGame', (username) => {
        players[socket.id] = {
            id: socket.id, name: username || "Capitano",
            x: Math.random() * (MAP_SIZE - 400) + 200, y: Math.random() * (MAP_SIZE - 400) + 200,
            targetX: null, targetY: null,
            speed: 4.5, radius: 25, angle: 0,
            maxHp: 100, hp: 100, isDead: false,
            lastShotTime: 0, cannonCount: 2, // Parte con 2 cannoni (1 per lato)
            gold: 0, tier: 0, // Tier attuale
            color: `hsl(${Math.random() * 360}, 70%, 50%)`
        };
        socket.emit('initIslands', islands);
    });

    socket.on('moveCommand', (target) => {
        if (players[socket.id] && !players[socket.id].isDead) {
            players[socket.id].targetX = target.x; players[socket.id].targetY = target.y;
        }
    });

    socket.on('shootCommand', () => {
        const p = players[socket.id];
        const now = Date.now();
        // Cooldown di 2.5 secondi (2500 millisecondi)
        if (p && !p.isDead && now - p.lastShotTime >= 2500) {
            p.lastShotTime = now;
            const cannonsPerSide = p.cannonCount / 2;
            
            // Genera i proiettili per ogni cannone
            for(let i=0; i<cannonsPerSide; i++) {
                // Sfalsa leggermente i proiettili se ci sono più cannoni
                const offset = (i - (cannonsPerSide-1)/2) * 15; 
                
                // Lato Destro
                bullets.push({
                    id: Math.random(), playerId: socket.id,
                    x: p.x + Math.cos(p.angle) * offset, y: p.y + Math.sin(p.angle) * offset,
                    vx: Math.cos(p.angle + Math.PI / 2) * 10, vy: Math.sin(p.angle + Math.PI / 2) * 10,
                    life: 40
                });
                // Lato Sinistro
                bullets.push({
                    id: Math.random(), playerId: socket.id,
                    x: p.x + Math.cos(p.angle) * offset, y: p.y + Math.sin(p.angle) * offset,
                    vx: Math.cos(p.angle - Math.PI / 2) * 10, vy: Math.sin(p.angle - Math.PI / 2) * 10,
                    life: 40
                });
            }
        }
    });

    // Logica Acquisto Negozio
    socket.on('buyUpgrade', () => {
        const p = players[socket.id];
        if (p && !p.isDead) {
            const nextTier = p.tier + 1;
            const upgrade = SHOP_TIERS[nextTier];
            
            if (upgrade && p.gold >= upgrade.gold) {
                p.gold -= upgrade.gold;
                p.tier = nextTier;
                p.maxHp += upgrade.hpBonus;
                p.hp = p.maxHp; // Cura completa all'upgrade
                p.radius += upgrade.sizeBonus;
                p.cannonCount = upgrade.cannons;
            }
        }
    });

    socket.on('disconnect', () => { delete players[socket.id]; });
});

// LOOP FISICA & IA (30 FPS)
setInterval(() => {
    const now = Date.now();

    // 1. SPAWN NPC (Fino a 30 in mappa)
    if (Object.keys(npcs).length < 30) {
        let isPirate = Math.random() > 0.6; // 40% Pirati, 60% Mercantili
        let id = 'npc_' + npcIdCounter++;
        npcs[id] = {
            id: id, type: isPirate ? 'pirate' : 'merchant',
            x: Math.random() * (MAP_SIZE - 400) + 200, y: Math.random() * (MAP_SIZE - 400) + 200,
            angle: Math.random() * Math.PI * 2,
            speed: isPirate ? 3.5 : 2, radius: isPirate ? 25 : 35,
            hp: isPirate ? 150 : 200, isDead: false,
            goldValue: isPirate ? 30 : 80, // Mercantili danno più oro
            lastShotTime: 0
        };
    }

    // 2. IA DEGLI NPC
    for (let id in npcs) {
        let npc = npcs[id];
        
        // Movimento base: vanno dritti. Se toccano i bordi, si girano.
        npc.x += Math.cos(npc.angle) * npc.speed;
        npc.y += Math.sin(npc.angle) * npc.speed;

        if (npc.x < 100 || npc.x > MAP_SIZE - 100 || npc.y < 100 || npc.y > MAP_SIZE - 100) {
            npc.angle += Math.PI; // Inversione a U
        }

        // IA Pirati: Cerca giocatore vicino e spara
        if (npc.type === 'pirate' && now - npc.lastShotTime > 3000) {
            for (let pid in players) {
                let p = players[pid];
                if (p.isDead) continue;
                let dx = p.x - npc.x; let dy = p.y - npc.y;
                if (Math.sqrt(dx*dx + dy*dy) < 300) { // Nel raggio d'azione
                    npc.angle = Math.atan2(dy, dx); // Punta il giocatore
                    npc.lastShotTime = now;
                    // Spara lateralmente
                    bullets.push({
                        id: Math.random(), playerId: npc.id, x: npc.x, y: npc.y,
                        vx: Math.cos(npc.angle + Math.PI/2) * 8, vy: Math.sin(npc.angle + Math.PI/2) * 8, life: 40
                    });
                    bullets.push({
                        id: Math.random(), playerId: npc.id, x: npc.x, y: npc.y,
                        vx: Math.cos(npc.angle - Math.PI/2) * 8, vy: Math.sin(npc.angle - Math.PI/2) * 8, life: 40
                    });
                    break;
                }
            }
        }
    }

    // 3. MOVIMENTO GIOCATORI E COLLISIONI (Semplificato per spazio)
    for (let id in players) {
        const p = players[id];
        if (p.isDead) continue;
        if (p.targetX !== null && p.targetY !== null) {
            const dx = p.targetX - p.x; const dy = p.targetY - p.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance > 8) {
                p.angle = Math.atan2(dy, dx);
                p.x += (dx / distance) * p.speed; p.y += (dy / distance) * p.speed;
            } else { p.targetX = null; p.targetY = null; }
        }
    }

    // 4. PROIETTILI E DANNI
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.vx; b.y += b.vy; b.life--;
        let hit = false;

        // Hit Giocatori
        for (let pid in players) {
            let p = players[pid];
            if (!p.isDead && pid !== b.playerId) {
                let dx = b.x - p.x; let dy = b.y - p.y;
                if (Math.sqrt(dx*dx + dy*dy) < p.radius) {
                    p.hp -= 20; hit = true;
                    if (p.hp <= 0) {
                        p.isDead = true;
                        if(players[b.playerId]) players[b.playerId].gold += 10; // Bonus uccisione giocatore
                        setTimeout(() => { 
                            if(players[pid]){
                                players[pid].hp = players[pid].maxHp; players[pid].isDead = false;
                                players[pid].x = Math.random() * (MAP_SIZE - 600) + 300;
                                players[pid].y = Math.random() * (MAP_SIZE - 600) + 300;
                            }
                        }, 4000);
                    }
                    break;
                }
            }
        }

        // Hit NPC
        if (!hit) {
            for (let nid in npcs) {
                let npc = npcs[nid];
                if (nid !== b.playerId) {
                    let dx = b.x - npc.x; let dy = b.y - npc.y;
                    if (Math.sqrt(dx*dx + dy*dy) < npc.radius) {
                        npc.hp -= 20; hit = true;
                        if (npc.hp <= 0) {
                            // Dai oro a chi lo ha ucciso (se è un giocatore)
                            if (players[b.playerId]) players[b.playerId].gold += npc.goldValue;
                            delete npcs[nid];
                        }
                        break;
                    }
                }
            }
        }

        if (hit || b.life <= 0) bullets.splice(i, 1);
    }

    io.emit('updateState', { players, npcs, bullets });
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Oceano 8000x8000 online sulla porta ${PORT}`));