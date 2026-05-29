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

io.on('connection', (socket) => {
    socket.on('joinGame', (username) => {
        players[socket.id] = {
            id: socket.id, name: username || "Capitano",
            x: Math.random() * (MAP_SIZE - 400) + 200, y: Math.random() * (MAP_SIZE - 400) + 200,
            targetX: null, targetY: null, angle: 0,
            isDead: false, gold: 0, lastShotTime: 0,
            upg: { hp_size: 0, damage: 0, cannons: 0, speed: 0 },
            hp: UPGRADES.hp_size.hp[0], maxHp: UPGRADES.hp_size.hp[0],
            radius: UPGRADES.hp_size.radius[0], speed: UPGRADES.speed.spd[0],
            cannonCount: UPGRADES.cannons.count[0], damage: UPGRADES.damage.dmg[0],
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
        if (p && !p.isDead && Date.now() - p.lastShotTime >= 2500) {
            p.lastShotTime = Date.now();
            const cps = p.cannonCount / 2;
            for(let i=0; i<cps; i++) {
                const offset = (i - (cps-1)/2) * 15; 
                const createBullet = (dirOffset) => {
                    bullets.push({
                        id: Math.random(), playerId: socket.id, dmg: p.damage,
                        x: p.x + Math.cos(p.angle) * offset, y: p.y + Math.sin(p.angle) * offset,
                        vx: Math.cos(p.angle + dirOffset) * 12, vy: Math.sin(p.angle + dirOffset) * 12, life: 40
                    });
                };
                createBullet(Math.PI / 2); createBullet(-Math.PI / 2);
            }
        }
    });

    socket.on('buyUpgrade', (type) => {
        const p = players[socket.id];
        if (p && !p.isDead && UPGRADES[type]) {
            const currentLevel = p.upg[type];
            if (currentLevel < UPGRADES[type].maxLevel) {
                const cost = UPGRADES[type].costs[currentLevel];
                if (p.gold >= cost) {
                    p.gold -= cost;
                    p.upg[type]++;
                    if(type === 'hp_size') { p.maxHp = UPGRADES.hp_size.hp[p.upg[type]]; p.hp = p.maxHp; p.radius = UPGRADES.hp_size.radius[p.upg[type]]; }
                    if(type === 'damage') p.damage = UPGRADES.damage.dmg[p.upg[type]];
                    if(type === 'cannons') p.cannonCount = UPGRADES.cannons.count[p.upg[type]];
                    if(type === 'speed') p.speed = UPGRADES.speed.spd[p.upg[type]];
                }
            }
        }
    });

    socket.on('disconnect', () => { delete players[socket.id]; });
});

setInterval(() => {
    // 1. Spawning NPC
    if (Object.keys(npcs).length < 30) {
        let isPirate = Math.random() > 0.6;
        let id = 'npc_' + npcIdCounter++;
        npcs[id] = { id, type: isPirate ? 'pirate' : 'merchant', x: Math.random()*(MAP_SIZE-600)+300, y: Math.random()*(MAP_SIZE-600)+300, angle: Math.random()*Math.PI*2, speed: isPirate ? 4 : 2.5, radius: isPirate ? 25 : 35, hp: isPirate ? 150 : 250, isDead: false, goldValue: isPirate ? 40 : 100, lastShotTime: 0, damage: 20 };
    }

    // 2. Movimento
    for (let id in npcs) {
        let n = npcs[id];
        n.x += Math.cos(n.angle) * n.speed; n.y += Math.sin(n.angle) * n.speed;
        if (n.x < 100 || n.x > MAP_SIZE - 100 || n.y < 100 || n.y > MAP_SIZE - 100) n.angle += Math.PI;
    }
    for (let id in players) {
        const p = players[id];
        if (p.isDead || p.targetX === null) continue;
        const dx = p.targetX - p.x; const dy = p.targetY - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 8) { p.angle = Math.atan2(dy, dx); p.x += (dx / dist) * p.speed; p.y += (dy / dist) * p.speed; }
        else { p.targetX = null; p.targetY = null; }
    }

    // 3. COLLISIONI UNIVERSALI (Entity vs Island + Entity vs Entity)
    const all = [...Object.values(players), ...Object.values(npcs)].filter(e => !e.isDead);

    for (let i = 0; i < all.length; i++) {
        let e = all[i];
        // vs Isole
        for (let is of islands) {
            const dx = e.x - is.x; const dy = e.y - is.y;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (dist < is.maxR + e.radius) {
                let angle = Math.atan2(dy, dx);
                let push = (is.maxR + e.radius) - dist;
                e.x += Math.cos(angle) * push; e.y += Math.sin(angle) * push;
            }
        }
        // vs Altre Entità
        for (let j = i + 1; j < all.length; j++) {
            let e2 = all[j];
            let dx = e.x - e2.x; let dy = e.y - e2.y;
            let dist = Math.sqrt(dx*dx + dy*dy);
            if (dist < e.radius + e2.radius) {
                let angle = Math.atan2(dy, dx);
                let push = (e.radius + e2.radius - dist) / 2;
                e.x += Math.cos(angle) * push; e.y += Math.sin(angle) * push;
                e2.x -= Math.cos(angle) * push; e2.y -= Math.sin(angle) * push;
            }
        }
    }

    // 4. Proiettili
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
                    p.hp -= b.dmg; hit = true;
                    if (p.hp <= 0) { p.isDead = true; if(players[b.playerId]) players[b.playerId].gold += 30; setTimeout(() => { if(players[pid]){ p.hp = p.maxHp; p.isDead = false; p.x = Math.random()*MAP_SIZE; p.y = Math.random()*MAP_SIZE; } }, 4000); }
                    break;
                }
            }
        }
        // Hit NPC
        if (!hit) {
            for (let nid in npcs) {
                let n = npcs[nid];
                if (nid !== b.playerId) {
                    let dx = b.x - n.x; let dy = b.y - n.y;
                    if (Math.sqrt(dx*dx + dy*dy) < n.radius) {
                        n.hp -= b.dmg; hit = true;
                        if (n.hp <= 0) { if (players[b.playerId]) players[b.playerId].gold += n.goldValue; delete npcs[nid]; }
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