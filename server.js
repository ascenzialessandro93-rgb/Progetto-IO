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
const resources = [];
let npcIdCounter = 0;
let resourceIdCounter = 0;

let globalTicks = 0;
let isNight = false;
let specialTreasure = null;
let kraken = null; // Il Boss PvE

const UPGRADES = {
    hp_size: { maxLevel: 4, costs: [50, 150, 300, 600],  hp: [100, 150, 200, 300, 500], radius: [25, 28, 32, 38, 45] },
    damage:  { maxLevel: 3, costs: [100, 250, 500],      dmg: [20, 30, 45, 70] },
    cannons: { maxLevel: 3, costs: [100, 300, 600],      count: [2, 4, 6, 8] },
    speed:   { maxLevel: 3, costs: [80, 200, 400],       spd: [4.5, 5.2, 6.0, 7.5] }
};

function generateIslands() {
    let attempts = 0;
    while (islands.length < 50 && attempts < 1000) {
        attempts++;
        const baseR = Math.random() * 150 + 100;
        const x = Math.random() * (MAP_SIZE - baseR * 3) + baseR * 1.5;
        const y = Math.random() * (MAP_SIZE - baseR * 3) + baseR * 1.5;
        // Evitiamo isole al centro esatto per fare spazio al Kraken
        if (Math.hypot(x - MAP_SIZE/2, y - MAP_SIZE/2) < 600) continue; 

        let overlap = false;
        for (let is of islands) {
            const dx = x - is.x; const dy = y - is.y;
            if (Math.sqrt(dx*dx + dy*dy) < baseR + is.maxR + 150) { overlap = true; break; }
        }

        if (!overlap) {
            const numPoints = 16;
            const points = [];
            let maxR = 0;
            for (let i = 0; i < numPoints; i++) {
                const angle = (i / numPoints) * Math.PI * 2;
                const r = baseR + (Math.random() * 80 - 40);
                if (r > maxR) maxR = r;
                points.push({ angle, r });
            }
            islands.push({ id: islands.length, x, y, maxR, points });
        }
    }
}
generateIslands();

function spawnResource() {
    resources.push({
        id: 'res_' + resourceIdCounter++,
        x: Math.random() * (MAP_SIZE - 400) + 200, 
        y: Math.random() * (MAP_SIZE - 400) + 200, 
        radius: 20, amount: 200
    });
}
for(let i = 0; i < 40; i++) spawnResource();

function handleIslandCollisions(entity) {
    for (let is of islands) {
        const dx = entity.x - is.x; const dy = entity.y - is.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < is.maxR + entity.radius) {
            let angleToCenter = Math.atan2(dy, dx);
            if (angleToCenter < 0) angleToCenter += Math.PI * 2;
            let islandR = is.maxR;
            for (let i = 0; i < is.points.length; i++) {
                let next = (i + 1) % is.points.length;
                if (angleToCenter >= is.points[i].angle && (angleToCenter <= is.points[next].angle || next === 0)) {
                    islandR = Math.max(is.points[i].r, is.points[next].r);
                    break;
                }
            }
            if (dist < islandR + entity.radius) {
                const pushDist = (islandR + entity.radius) - dist;
                entity.x += Math.cos(angleToCenter) * pushDist;
                entity.y += Math.sin(angleToCenter) * pushDist;
                if (entity.id && entity.id.toString().startsWith('npc_')) entity.angle += Math.PI / 4;
            }
        }
    }
}

io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        let username = (data.username || "Capitano").trim();
        let crewTag = (data.crew || "").trim().toUpperCase();
        
        // Notifica globale nuovo giocatore
        io.emit('chatMessage', { sender: 'SISTEMA', text: `${username} è sceso in mare!`, type: 'system' });

        players[socket.id] = {
            id: socket.id, name: username, crew: crewTag, shipClass: null,
            x: Math.random() * (MAP_SIZE - 400) + 200, y: Math.random() * (MAP_SIZE - 400) + 200,
            targetX: null, targetY: null, angle: 0, isDead: false, gold: 0, lastShotTime: 0,
            upg: { hp_size: 0, damage: 0, cannons: 0, speed: 0 },
            hp: UPGRADES.hp_size.hp[0], maxHp: UPGRADES.hp_size.hp[0],
            radius: UPGRADES.hp_size.radius[0], speed: UPGRADES.speed.spd[0],
            cannonCount: UPGRADES.cannons.count[0], damage: UPGRADES.damage.dmg[0],
            skills: { speedBoost: { activeUntil: 0 }, repair: { cd: 0 }, smokeScreen: { activeUntil: 0 } }
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
        if (p && !p.isDead && Date.now() - p.lastShotTime >= 2000) {
            p.lastShotTime = Date.now();
            let cps = p.cannonCount / 2;
            
            // Logica specifica per la classe
            if (p.shipClass === 'galleon') cps += 1; 

            for(let i=0; i<cps; i++) {
                const offset = (i - (cps-1)/2) * 15; 
                const createBullet = (dirOffset) => {
                    bullets.push({
                        id: Math.random(), playerId: socket.id, crew: p.crew, dmg: p.damage,
                        x: p.x + Math.cos(p.angle) * offset, y: p.y + Math.sin(p.angle) * offset,
                        vx: Math.cos(p.angle + dirOffset) * 14, vy: Math.sin(p.angle + dirOffset) * 14, life: 40
                    });
                };
                
                if (p.shipClass === 'clipper') {
                    // Clipper spara prevalentemente in avanti
                    createBullet(Math.PI/16 * (Math.random()-0.5)); 
                } else {
                    // Sparo laterale classico
                    createBullet(Math.PI / 2);  
                    createBullet(-Math.PI / 2); 
                }
            }
        }
    });

    socket.on('useSkill', (skillType) => {
        const p = players[socket.id];
        if (!p || p.isDead) return;
        const now = Date.now();

        if (skillType === 'speed' && (!p.skills.speedBoost.cd || p.skills.speedBoost.cd <= now)) {
            p.skills.speedBoost.activeUntil = now + 4000; p.skills.speedBoost.cd = now + 12000;        
        } else if (skillType === 'repair' && (!p.skills.repair.cd || p.skills.repair.cd <= now)) {
            p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.3); p.skills.repair.cd = now + 15000;              
        } else if (skillType === 'smoke' && (!p.skills.smokeScreen.cd || p.skills.smokeScreen.cd <= now)) {
            p.skills.smokeScreen.activeUntil = now + 3000; p.skills.smokeScreen.cd = now + 18000;         
        }
    });

    socket.on('buyUpgrade', (type) => {
        const p = players[socket.id];
        if (p && !p.isDead && UPGRADES[type]) {
            const currentLevel = p.upg[type];
            if (currentLevel < UPGRADES[type].maxLevel) {
                const cost = UPGRADES[type].costs[currentLevel];
                if (p.gold >= cost) {
                    p.gold -= cost; p.upg[type]++;
                    if(type === 'hp_size') { p.maxHp = UPGRADES.hp_size.hp[p.upg[type]]; p.hp = p.maxHp; p.radius = UPGRADES.hp_size.radius[p.upg[type]]; }
                    if(type === 'damage') p.damage = UPGRADES.damage.dmg[p.upg[type]];
                    if(type === 'cannons') p.cannonCount = UPGRADES.cannons.count[p.upg[type]];
                    if(type === 'speed') p.speed = UPGRADES.speed.spd[p.upg[type]];
                    
                    // Trigger Evoluzione Classe al Livello Scafo 2
                    if (type === 'hp_size' && p.upg.hp_size === 2 && !p.shipClass) {
                        socket.emit('triggerClassSelection');
                    }
                }
            }
        }
    });

    socket.on('selectClass', (shipClass) => {
        const p = players[socket.id];
        if (p && p.upg.hp_size >= 2 && !p.shipClass) {
            p.shipClass = shipClass;
            if (shipClass === 'galleon') { p.maxHp *= 1.5; p.hp = p.maxHp; p.speed *= 0.8; p.radius *= 1.2; }
            if (shipClass === 'clipper') { p.speed *= 1.35; p.maxHp *= 0.8; p.radius *= 0.9; }
            if (shipClass === 'caravel') { p.speed *= 1.1; p.maxHp *= 1.1; /* Raggio visivo extra gestito sul client */ }
        }
    });

    socket.on('chatMessage', (msg) => {
        const p = players[socket.id];
        if (!p || p.isDead) return;
        const text = msg.trim();
        if (text.startsWith('/crew ') && p.crew) {
            io.emit('chatMessage', { sender: p.name, text: text.replace('/crew ', ''), type: 'crew', crewTag: p.crew });
        } else {
            io.emit('chatMessage', { sender: p.name, text: text, type: 'global', crewTag: p.crew });
        }
    });

    socket.on('disconnect', () => { delete players[socket.id]; });
});

setInterval(() => {
    globalTicks++;
    const now = Date.now();

    // Ciclo Giorno/Notte
    if (globalTicks % 1800 === 0) isNight = !isNight;

    // Boss PvE: Il Kraken
    if (globalTicks % 4000 === 0 && !kraken) {
        kraken = { id: 'kraken', x: MAP_SIZE/2, y: MAP_SIZE/2, hp: 6000, maxHp: 6000, radius: 100, angle: 0 };
        io.emit('chatMessage', { sender: 'SISTEMA', text: '🦑 IL KRAKEN È EMERSO AL CENTRO DELLA MAPPA!', type: 'system' });
    }

    if (kraken) {
        kraken.angle += 0.015;
        // Il kraken spara in 8 direzioni a ondate
        if (globalTicks % 60 === 0) {
            for(let i=0; i<8; i++) {
                bullets.push({
                    id: Math.random(), playerId: 'kraken', crew: null, dmg: 40,
                    x: kraken.x, y: kraken.y, vx: Math.cos(kraken.angle + i*Math.PI/4)*8, vy: Math.sin(kraken.angle + i*Math.PI/4)*8, life: 80
                });
            }
        }
    }

    if (!specialTreasure && globalTicks % 3000 === 0) {
        specialTreasure = { x: Math.random() * (MAP_SIZE - 2000) + 1000, y: Math.random() * (MAP_SIZE - 2000) + 1000, radius: 45, goldValue: 500 };
    }

    // IA NPCs
    if (Object.keys(npcs).length < 25) {
        let isPirate = Math.random() > 0.6;
        let id = 'npc_' + npcIdCounter++;
        npcs[id] = {
            id, type: isPirate ? 'pirate' : 'merchant',
            x: Math.random() * (MAP_SIZE-600) + 300, y: Math.random() * (MAP_SIZE-600) + 300, angle: Math.random() * Math.PI*2,
            speed: isPirate ? 4 : 2.5, radius: isPirate ? 25 : 35,
            hp: isPirate ? 150 : 250, maxHp: isPirate ? 150 : 250, isDead: false, goldValue: isPirate ? 40 : 100, damage: 20
        };
    }

    for (let id in npcs) {
        let n = npcs[id];
        n.x += Math.cos(n.angle) * n.speed; n.y += Math.sin(n.angle) * n.speed;
        if (n.x < 100 || n.x > MAP_SIZE - 100 || n.y < 100 || n.y > MAP_SIZE - 100) n.angle += Math.PI;
        handleIslandCollisions(n);
    }

    // Giocatori & Risorse
    for (let id in players) {
        const p = players[id];
        if (p.isDead) continue;
        
        let currentSpeed = p.speed;
        if (p.skills.speedBoost.activeUntil > now) currentSpeed *= 1.6;

        if (p.targetX !== null && p.targetY !== null) {
            const dx = p.targetX - p.x; const dy = p.targetY - p.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 8) {
                p.angle = Math.atan2(dy, dx);
                p.x += (dx / dist) * currentSpeed;
                p.y += (dy / dist) * currentSpeed;
            } else {
                p.targetX = null; p.targetY = null;
            }
        }

        handleIslandCollisions(p);

        // Raccolta Risorse (RALLENTATA)
        for (let i = resources.length - 1; i >= 0; i--) {
            const res = resources[i];
            const dx = p.x - res.x; const dy = p.y - res.y;
            if (Math.sqrt(dx*dx + dy*dy) < p.radius + res.radius) {
                // ESTRAZIONE LENTA: 1 unità d'oro ogni 6 tick (circa 5 oro al secondo)
                if (globalTicks % 6 === 0) {
                    p.gold += 1; 
                    res.amount -= 1;
                    if (res.amount <= 0) { resources.splice(i, 1); spawnResource(); }
                }
            }
        }

        if (specialTreasure) {
            const tDx = p.x - specialTreasure.x; const tDy = p.y - specialTreasure.y;
            if (Math.sqrt(tDx*tDx + tDy*tDy) < p.radius + specialTreasure.radius) {
                p.gold += specialTreasure.goldValue; specialTreasure = null;
                io.emit('chatMessage', { sender: 'SISTEMA', text: `${p.name} ha trovato il Tesoro!`, type: 'system' });
            }
        }
    }

    const allShips = [...Object.values(players).filter(p => !p.isDead), ...Object.values(npcs)];
    if (kraken) allShips.push(kraken);

    for (let i = 0; i < allShips.length; i++) {
        for (let j = i + 1; j < allShips.length; j++) {
            const s1 = allShips[i]; const s2 = allShips[j];
            const dx = s2.x - s1.x; const dy = s2.y - s1.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const minDistance = s1.radius + s2.radius;

            if (distance < minDistance && distance > 0) {
                const overlap = minDistance - distance;
                const nx = dx / distance; const ny = dy / distance;
                if(s1.id !== 'kraken') { s1.x -= nx * (overlap / 2); s1.y -= ny * (overlap / 2); }
                if(s2.id !== 'kraken') { s2.x += nx * (overlap / 2); s2.y += ny * (overlap / 2); }
            }
        }
    }

    // Proiettili e logica Danni (Invio eventi particellari ai client colpiti)
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.vx; b.y += b.vy; b.life--;
        let hit = false;

        // Hit Players
        for (let pid in players) {
            let p = players[pid];
            if (!p.isDead && pid !== b.playerId && !(b.crew && b.crew === p.crew)) {
                let dx = b.x - p.x; let dy = b.y - p.y;
                if (Math.sqrt(dx*dx + dy*dy) < p.radius) {
                    p.hp -= b.dmg; hit = true;
                    io.emit('effect', { type: 'hit', x: b.x, y: b.y, targetId: pid });
                    if (p.hp <= 0) {
                        p.isDead = true;
                        io.emit('effect', { type: 'explosion', x: p.x, y: p.y });
                        io.emit('chatMessage', { sender: 'SISTEMA', text: `☠️ ${p.name} è affondato.`, type: 'system' });
                        if(players[b.playerId]) players[b.playerId].gold += 150; 
                        setTimeout(() => { if(players[pid]){ p.hp = p.maxHp; p.isDead = false; p.x = Math.random()*MAP_SIZE; p.y = Math.random()*MAP_SIZE; } }, 4000);
                    }
                    break;
                }
            }
        }

        // Hit NPCs / Kraken
        if (!hit) {
            for (let nid in npcs) {
                let n = npcs[nid];
                if (nid !== b.playerId) {
                    let dx = b.x - n.x; let dy = b.y - n.y;
                    if (Math.sqrt(dx*dx + dy*dy) < n.radius) {
                        n.hp -= b.dmg; hit = true;
                        io.emit('effect', { type: 'hit', x: b.x, y: b.y, targetId: nid });
                        if (n.hp <= 0) {
                            if (players[b.playerId]) players[b.playerId].gold += n.goldValue;
                            io.emit('effect', { type: 'explosion', x: n.x, y: n.y });
                            delete npcs[nid];
                        }
                        break;
                    }
                }
            }
            if(!hit && kraken && b.playerId !== 'kraken') {
                let dx = b.x - kraken.x; let dy = b.y - kraken.y;
                if (Math.sqrt(dx*dx + dy*dy) < kraken.radius) {
                    kraken.hp -= b.dmg; hit = true;
                    io.emit('effect', { type: 'hit', x: b.x, y: b.y, color: 'purple' });
                    if (kraken.hp <= 0) {
                        if (players[b.playerId]) players[b.playerId].gold += 2500;
                        io.emit('effect', { type: 'explosion', x: kraken.x, y: kraken.y });
                        io.emit('chatMessage', { sender: 'SISTEMA', text: '🦑 IL KRAKEN È STATO SCONFITTO!', type: 'system' });
                        kraken = null;
                    }
                }
            }
        }
        if (hit || b.life <= 0) bullets.splice(i, 1);
    }

    const leaderboard = Object.values(players)
        .sort((a, b) => b.gold - a.gold)
        .slice(0, 5)
        .map(p => ({ name: p.name, crew: p.crew, gold: p.gold }));

    io.emit('updateState', { players, npcs, bullets, resources, isNight, specialTreasure, kraken, leaderboard });
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Corsari.io online sulla porta ${PORT}`));