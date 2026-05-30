/**
 * Corsari.io - server_optimized.js
 * ============================================================
 * OTTIMIZZAZIONI APPLICATE:
 *  MOD 1  - Separazione tick fisica (30Hz) e tick rete (15Hz)
 *  MOD 2  - Visibility Culling lato server (socket.emit individuale)
 *  MOD 3  - DTO leggeri (solo campi necessari via wire)
 *  MOD 4  - Spatial Hash Grid (collisioni O(1) media)
 *  MOD 5  - perMessageDeflate abilitato su Socket.IO
 *  MOD 9  - Evitato Math.sqrt dove non strettamente necessario
 * ============================================================
 * NON modificato: gameplay, danni, upgrade, bilanciamento.
 * Compatibile con Socket.IO e Render.
 */

const express = require('express');
const app = express();
const http = require('http').createServer(app);

// ── MOD 5: Compressione WebSocket ────────────────────────────
const io = require('socket.io')(http, {
    perMessageDeflate: true          // abilita gzip per ogni frame
});
// ─────────────────────────────────────────────────────────────

app.use(express.static('public'));

// ── Costanti di gioco ─────────────────────────────────────────
const MAP_SIZE      = 8000;
const VIEW_DISTANCE = 1800;          // MOD 2: raggio visibilità
const VD_SQ         = VIEW_DISTANCE * VIEW_DISTANCE; // evita sqrt

// ── MOD 4: Spatial Hash Grid ──────────────────────────────────
const CELL_SIZE = 500;

/**
 * SpatialGrid - hash map 2D per query di vicinanza rapide.
 * Usata per: ship↔ship, bullet↔target, ship↔resource, ship↔isola.
 */
class SpatialGrid {
    constructor(cellSize) {
        this.cellSize = cellSize;
        this.cells    = new Map();
    }

    /** Chiave cella per coordinate mondo */
    _key(cx, cy) { return (cx << 16) ^ cy; }   // bitwise per velocità

    /** Inserisce un oggetto nella/nelle celle che tocca (bounding circle) */
    insert(obj, x, y, radius) {
        const r   = radius || 0;
        const x0  = Math.floor((x - r) / this.cellSize);
        const x1  = Math.floor((x + r) / this.cellSize);
        const y0  = Math.floor((y - r) / this.cellSize);
        const y1  = Math.floor((y + r) / this.cellSize);
        for (let cx = x0; cx <= x1; cx++) {
            for (let cy = y0; cy <= y1; cy++) {
                const k = this._key(cx, cy);
                if (!this.cells.has(k)) this.cells.set(k, []);
                this.cells.get(k).push(obj);
            }
        }
    }

    /** Restituisce tutti gli oggetti nelle celle intorno a (x,y,radius) */
    query(x, y, radius) {
        const r   = radius || 0;
        const x0  = Math.floor((x - r) / this.cellSize);
        const x1  = Math.floor((x + r) / this.cellSize);
        const y0  = Math.floor((y - r) / this.cellSize);
        const y1  = Math.floor((y + r) / this.cellSize);
        const result = new Set();
        for (let cx = x0; cx <= x1; cx++) {
            for (let cy = y0; cy <= y1; cy++) {
                const bucket = this.cells.get(this._key(cx, cy));
                if (bucket) bucket.forEach(o => result.add(o));
            }
        }
        return result;
    }

    /** Svuota la grid (da chiamare ogni tick prima di reinserire) */
    clear() { this.cells.clear(); }
}

// Grid dinamica (svuotata e ricostruita ogni physics tick)
const shipGrid     = new SpatialGrid(CELL_SIZE);
const bulletGrid   = new SpatialGrid(CELL_SIZE);
const resourceGrid = new SpatialGrid(CELL_SIZE);

// Grid statica per le isole (costruita una sola volta)
const islandGrid   = new SpatialGrid(CELL_SIZE);
// ─────────────────────────────────────────────────────────────

// ── Stato globale ─────────────────────────────────────────────
const players  = {};
const islands  = [];
const bullets  = [];
const npcs     = {};
const resources = [];

let npcIdCounter      = 0;
let resourceIdCounter = 0;
let globalTicks       = 0;
let isNight           = false;
let specialTreasure   = null;
let kraken            = null;
let krakenDeathTick   = 0;

const UPGRADES = {
    hp_size: { maxLevel: 4, costs: [50, 150, 300, 600],  hp: [100, 150, 200, 300, 500], radius: [25, 28, 32, 38, 45] },
    damage:  { maxLevel: 3, costs: [100, 250, 500],      dmg: [20, 30, 45, 70] },
    cannons: { maxLevel: 3, costs: [100, 300, 600],      count: [2, 4, 6, 8] },
    speed:   { maxLevel: 3, costs: [80, 200, 400],       spd: [4.5, 5.2, 6.0, 7.5] }
};

// ── Generazione isole ─────────────────────────────────────────
function generateIslands() {
    let attempts = 0;
    while (islands.length < 50 && attempts < 1000) {
        attempts++;
        const baseR = Math.random() * 150 + 100;
        const x = Math.random() * (MAP_SIZE - baseR * 3) + baseR * 1.5;
        const y = Math.random() * (MAP_SIZE - baseR * 3) + baseR * 1.5;
        if (Math.hypot(x - MAP_SIZE / 2, y - MAP_SIZE / 2) < 600) continue;

        let overlap = false;
        for (let is of islands) {
            const dx = x - is.x; const dy = y - is.y;
            // MOD 9: confronto quadrati per evitare sqrt
            if (dx * dx + dy * dy < (baseR + is.maxR + 150) ** 2) { overlap = true; break; }
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

// MOD 4: Inserisce le isole nella grid statica una sola volta
for (const is of islands) islandGrid.insert(is, is.x, is.y, is.maxR);

// ── Risorse iniziali ──────────────────────────────────────────
function spawnResource() {
    const res = {
        id: 'res_' + resourceIdCounter++,
        x: Math.random() * (MAP_SIZE - 400) + 200,
        y: Math.random() * (MAP_SIZE - 400) + 200,
        radius: 20, amount: 200
    };
    resources.push(res);
}
for (let i = 0; i < 40; i++) spawnResource();

// ── Collisioni isole (con grid statica) ───────────────────────
function handleIslandCollisions(entity) {
    // MOD 4: interroga solo le celle vicine invece di iterare tutte le 50 isole
    const candidates = islandGrid.query(entity.x, entity.y, entity.radius + 200);
    for (const is of candidates) {
        const dx   = entity.x - is.x;
        const dy   = entity.y - is.y;
        const distSq = dx * dx + dy * dy;
        const outerR = is.maxR + entity.radius;
        if (distSq >= outerR * outerR) continue; // MOD 9: evita sqrt

        const dist = Math.sqrt(distSq);          // sqrt solo se serve il push
        let angleToCenter = Math.atan2(dy, dx);
        if (angleToCenter < 0) angleToCenter += Math.PI * 2;

        let islandR = is.maxR;
        for (let i = 0; i < is.points.length; i++) {
            const next = (i + 1) % is.points.length;
            if (angleToCenter >= is.points[i].angle &&
                (angleToCenter <= is.points[next].angle || next === 0)) {
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

// ── MOD 3: DTO leggeri ────────────────────────────────────────
/** Serializza un player per la rete (solo campi utili al client) */
function playerDTO(p) {
    return {
        id:       p.id,
        x:        p.x,
        y:        p.y,
        angle:    p.angle,
        hp:       p.hp,
        maxHp:    p.maxHp,
        radius:   p.radius,
        name:     p.name,
        crew:     p.crew,
        shipClass:p.shipClass,
        isDead:   p.isDead
    };
}

/** Serializza un NPC per la rete */
function npcDTO(n) {
    return {
        id:    n.id,
        x:     n.x,
        y:     n.y,
        angle: n.angle,
        hp:    n.hp,
        maxHp: n.maxHp,
        radius:n.radius,
        type:  n.type
    };
}

/** Serializza un proiettile per la rete (solo posizione) */
function bulletDTO(b) {
    return { x: b.x, y: b.y };
}

/** Serializza una risorsa per la rete */
function resourceDTO(r) {
    return { id: r.id, x: r.x, y: r.y, amount: r.amount };
}

// ── Distanza² tra due entità ──────────────────────────────────
function distSq(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}

// ── MOD 2: Visibility Culling - costruisce payload per un player
function buildStateForPlayer(p) {
    const px = p.x;
    const py = p.y;

    // Players vicini
    const nearPlayers = [];
    for (const id in players) {
        const op = players[id];
        const dx = op.x - px; const dy = op.y - py;
        if (dx * dx + dy * dy <= VD_SQ) nearPlayers.push(playerDTO(op));
    }

    // NPC vicini
    const nearNpcs = [];
    for (const id in npcs) {
        const n = npcs[id];
        const dx = n.x - px; const dy = n.y - py;
        if (dx * dx + dy * dy <= VD_SQ) nearNpcs.push(npcDTO(n));
    }

    // Bullets vicini
    const nearBullets = [];
    for (const b of bullets) {
        const dx = b.x - px; const dy = b.y - py;
        if (dx * dx + dy * dy <= VD_SQ) nearBullets.push(bulletDTO(b));
    }

    // Risorse vicine
    const nearResources = [];
    for (const r of resources) {
        const dx = r.x - px; const dy = r.y - py;
        if (dx * dx + dy * dy <= VD_SQ) nearResources.push(resourceDTO(r));
    }

    // Kraken (solo se visibile)
    let nearKraken = null;
    if (kraken) {
        const dx = kraken.x - px; const dy = kraken.y - py;
        if (dx * dx + dy * dy <= VD_SQ) nearKraken = kraken;
    }

    // Tesoro speciale (solo se visibile)
    let nearTreasure = null;
    if (specialTreasure) {
        const dx = specialTreasure.x - px; const dy = specialTreasure.y - py;
        if (dx * dx + dy * dy <= VD_SQ) nearTreasure = specialTreasure;
    }

    // Leaderboard: calcolata globalmente, inclusa sempre
    const leaderboard = Object.values(players)
        .sort((a, b) => b.gold - a.gold)
        .slice(0, 5)
        .map(q => ({ name: q.name, crew: q.crew, gold: q.gold }));

    // MOD 3: dati privati del solo giocatore destinatario (non inclusi nel DTO generico)
    const myData = {
        gold:  p.gold,
        upg:   p.upg,
        skills: {
            speedBoost:  { activeUntil: p.skills.speedBoost.activeUntil,  cd: p.skills.speedBoost.cd },
            repair:      { cd: p.skills.repair.cd },
            smokeScreen: { activeUntil: p.skills.smokeScreen.activeUntil, cd: p.skills.smokeScreen.cd }
        }
    };

    return {
        players:        nearPlayers,
        npcs:           nearNpcs,
        bullets:        nearBullets,
        resources:      nearResources,
        isNight,
        specialTreasure:nearTreasure,
        kraken:         nearKraken,
        leaderboard,
        myData          // MOD 3: gold/upg/skills solo per il destinatario
    };
}

// ── MOD 2: Invia aggiornamento individuale a ogni player ──────
function sendNetworkUpdates() {
    for (const id in players) {
        const p = players[id];
        const sock = io.sockets.sockets.get(id);
        if (!sock) continue;
        // Invia i soli dati rilevanti per questo player
        sock.emit('updateState', buildStateForPlayer(p));
    }
}

// ── Socket.IO: gestione connessioni ──────────────────────────
io.on('connection', (socket) => {
    socket.on('joinGame', (data) => {
        let username = (data.username || "Capitano").trim();
        let crewTag  = (data.crew || "").trim().toUpperCase();

        io.emit('chatMessage', { sender: 'SISTEMA', text: `${username} è sceso in mare!`, type: 'system' });

        players[socket.id] = {
            id: socket.id, name: username, crew: crewTag, shipClass: null,
            x: Math.random() * (MAP_SIZE - 400) + 200,
            y: Math.random() * (MAP_SIZE - 400) + 200,
            targetX: null, targetY: null, angle: 0, isDead: false, gold: 0, lastShotTime: 0,
            upg: { hp_size: 0, damage: 0, cannons: 0, speed: 0 },
            hp: UPGRADES.hp_size.hp[0], maxHp: UPGRADES.hp_size.hp[0],
            radius: UPGRADES.hp_size.radius[0], speed: UPGRADES.speed.spd[0],
            cannonCount: UPGRADES.cannons.count[0], damage: UPGRADES.damage.dmg[0],
            skills: {
                speedBoost:  { activeUntil: 0 },
                repair:      { cd: 0 },
                smokeScreen: { activeUntil: 0 }
            }
        };
        socket.emit('initIslands', islands);
    });

    socket.on('moveCommand', (target) => {
        if (players[socket.id] && !players[socket.id].isDead) {
            players[socket.id].targetX = target.x;
            players[socket.id].targetY = target.y;
        }
    });

    socket.on('shootCommand', () => {
        const p = players[socket.id];
        if (p && !p.isDead && Date.now() - p.lastShotTime >= 2000) {
            p.lastShotTime = Date.now();
            let cps = p.cannonCount / 2;
            if (p.shipClass === 'galleon') cps += 1;

            for (let i = 0; i < cps; i++) {
                const offset = (i - (cps - 1) / 2) * 15;
                const createBullet = (dirOffset) => {
                    bullets.push({
                        id: Math.random(), playerId: socket.id, crew: p.crew, dmg: p.damage,
                        x: p.x + Math.cos(p.angle) * offset,
                        y: p.y + Math.sin(p.angle) * offset,
                        vx: Math.cos(p.angle + dirOffset) * 14,
                        vy: Math.sin(p.angle + dirOffset) * 14,
                        life: 40
                    });
                };
                if (p.shipClass === 'clipper') {
                    createBullet(Math.PI / 16 * (Math.random() - 0.5));
                } else {
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
            p.skills.speedBoost.activeUntil = now + 4000;
            p.skills.speedBoost.cd = now + 12000;
        } else if (skillType === 'repair' && (!p.skills.repair.cd || p.skills.repair.cd <= now)) {
            p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.3);
            p.skills.repair.cd = now + 15000;
        } else if (skillType === 'smoke' && (!p.skills.smokeScreen.cd || p.skills.smokeScreen.cd <= now)) {
            p.skills.smokeScreen.activeUntil = now + 3000;
            p.skills.smokeScreen.cd = now + 18000;
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
                    if (type === 'hp_size') {
                        p.maxHp  = UPGRADES.hp_size.hp[p.upg[type]];
                        p.hp     = p.maxHp;
                        p.radius = UPGRADES.hp_size.radius[p.upg[type]];
                    }
                    if (type === 'damage')  p.damage      = UPGRADES.damage.dmg[p.upg[type]];
                    if (type === 'cannons') p.cannonCount = UPGRADES.cannons.count[p.upg[type]];
                    if (type === 'speed')   p.speed       = UPGRADES.speed.spd[p.upg[type]];
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
            if (shipClass === 'galleon') { p.maxHp *= 1.5; p.hp = p.maxHp; p.speed *= 0.8;  p.radius *= 1.2; }
            if (shipClass === 'clipper') { p.speed *= 1.35; p.maxHp *= 0.8; p.radius *= 0.9; }
            if (shipClass === 'caravel') { p.speed *= 1.1;  p.maxHp *= 1.1; }
        }
    });

    socket.on('chatMessage', (msg) => {
        const p = players[socket.id];
        if (!p || p.isDead) return;
        const text = msg.trim();
        if (text.startsWith('/crew ') && p.crew) {
            io.emit('chatMessage', { sender: p.name, text: text.replace('/crew ', ''), type: 'crew', crewTag: p.crew });
        } else {
            io.emit('chatMessage', { sender: p.name, text, type: 'global', crewTag: p.crew });
        }
    });

    socket.on('disconnect', () => { delete players[socket.id]; });
});

// ── MOD 1: Tick Fisica a 30Hz ─────────────────────────────────
/**
 * updatePhysics() contiene TUTTA la logica di simulazione:
 * movimento, collisioni, raccolta risorse, danni, respawn.
 * Gira a 30 FPS esatti (stesso rate di prima, gameplay invariato).
 */
function updatePhysics() {
    globalTicks++;
    const now = Date.now();

    // ── Giorno/Notte ──────────────────────────────────────────
    if (globalTicks % 1800 === 0) isNight = !isNight;

    // ── Kraken respawn ────────────────────────────────────────
    if (!kraken && (globalTicks - krakenDeathTick) >= 12600) {
        kraken = { id: 'kraken', x: MAP_SIZE / 2, y: MAP_SIZE / 2, hp: 6000, maxHp: 6000, radius: 100, angle: 0 };
        io.emit('chatMessage', { sender: 'SISTEMA', text: '🦑 IL KRAKEN È EMERSO!', type: 'system' });
    }

    // ── Kraken AI ────────────────────────────────────────────
    if (kraken) {
        kraken.angle += 0.015;
        if (globalTicks % 60 === 0) {
            for (let i = 0; i < 8; i++) {
                bullets.push({
                    id: Math.random(), playerId: 'kraken', crew: null, dmg: 40,
                    x: kraken.x, y: kraken.y,
                    vx: Math.cos(kraken.angle + i * Math.PI / 4) * 8,
                    vy: Math.sin(kraken.angle + i * Math.PI / 4) * 8,
                    life: 80
                });
            }
        }
    }

    // ── Tesoro speciale ───────────────────────────────────────
    if (!specialTreasure && globalTicks % 3000 === 0) {
        specialTreasure = {
            x: Math.random() * (MAP_SIZE - 2000) + 1000,
            y: Math.random() * (MAP_SIZE - 2000) + 1000,
            radius: 45, goldValue: 500
        };
    }

    // ── Spawn NPC ─────────────────────────────────────────────
    if (Object.keys(npcs).length < 25) {
        const isPirate = Math.random() > 0.6;
        const id = 'npc_' + npcIdCounter++;
        npcs[id] = {
            id, type: isPirate ? 'pirate' : 'merchant',
            x: Math.random() * (MAP_SIZE - 600) + 300,
            y: Math.random() * (MAP_SIZE - 600) + 300,
            angle: Math.random() * Math.PI * 2,
            speed: isPirate ? 4 : 2.5,
            radius: isPirate ? 25 : 35,
            hp: isPirate ? 150 : 250,
            maxHp: isPirate ? 150 : 250,
            isDead: false, goldValue: isPirate ? 40 : 100, damage: 20
        };
    }

    // ── MOD 4: Costruisci la Ship Grid ────────────────────────
    // (svuotata ogni tick, inserisce players + npcs + kraken)
    shipGrid.clear();
    for (const id in players) {
        const p = players[id];
        if (!p.isDead) shipGrid.insert(p, p.x, p.y, p.radius);
    }
    for (const id in npcs) {
        const n = npcs[id];
        shipGrid.insert(n, n.x, n.y, n.radius);
    }
    if (kraken) shipGrid.insert(kraken, kraken.x, kraken.y, kraken.radius);

    // ── MOD 4: Costruisci la Resource Grid ───────────────────
    resourceGrid.clear();
    for (const r of resources) resourceGrid.insert(r, r.x, r.y, r.radius);

    // ── Movimento NPC ─────────────────────────────────────────
    for (const id in npcs) {
        const n = npcs[id];
        n.x += Math.cos(n.angle) * n.speed;
        n.y += Math.sin(n.angle) * n.speed;
        if (n.x < 100 || n.x > MAP_SIZE - 100 || n.y < 100 || n.y > MAP_SIZE - 100) n.angle += Math.PI;
        handleIslandCollisions(n);
    }

    // ── Movimento Player ──────────────────────────────────────
    for (const id in players) {
        const p = players[id];
        if (p.isDead) continue;

        let currentSpeed = p.speed;
        if (p.skills.speedBoost.activeUntil > now) currentSpeed *= 1.6;

        if (p.targetX !== null && p.targetY !== null) {
            const dx   = p.targetX - p.x;
            const dy   = p.targetY - p.y;
            const dist = Math.sqrt(dx * dx + dy * dy); // serve il valore reale per moveStep

            if (dist > 8) {
                const targetAngle = Math.atan2(dy, dx);
                let angleDiff = targetAngle - p.angle;
                while (angleDiff >  Math.PI) angleDiff -= Math.PI * 2;
                while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

                let turnRate = 0.05;
                if (p.shipClass === 'galleon') turnRate = 0.025;
                if (p.shipClass === 'caravel') turnRate = 0.04;
                if (p.shipClass === 'clipper') turnRate = 0.07;

                if      (angleDiff >  turnRate) p.angle += turnRate;
                else if (angleDiff < -turnRate) p.angle -= turnRate;
                else                            p.angle  = targetAngle;

                p.x += Math.cos(p.angle) * currentSpeed;
                p.y += Math.sin(p.angle) * currentSpeed;
            } else {
                p.targetX = null;
                p.targetY = null;
            }
        }
        handleIslandCollisions(p);

        // ── Raccolta Risorse (con resource grid) ──────────────
        // MOD 4: solo le risorse nelle celle vicine
        const nearRes = resourceGrid.query(p.x, p.y, p.radius + 20);
        for (const res of nearRes) {
            const dx = p.x - res.x; const dy = p.y - res.y;
            // MOD 9: confronto quadrati
            if (dx * dx + dy * dy < (p.radius + res.radius) ** 2) {
                if (globalTicks % 6 === 0) {
                    p.gold += 1;
                    res.amount -= 1;
                    if (res.amount <= 0) {
                        const idx = resources.indexOf(res);
                        if (idx !== -1) resources.splice(idx, 1);
                        spawnResource();
                    }
                }
            }
        }

        // ── Raccolta Tesoro ───────────────────────────────────
        if (specialTreasure) {
            const tDx = p.x - specialTreasure.x; const tDy = p.y - specialTreasure.y;
            // MOD 9: confronto quadrati
            if (tDx * tDx + tDy * tDy < (p.radius + specialTreasure.radius) ** 2) {
                p.gold += specialTreasure.goldValue;
                specialTreasure = null;
                io.emit('chatMessage', { sender: 'SISTEMA', text: `${p.name} ha trovato il Tesoro!`, type: 'system' });
            }
        }
    }

    // ── MOD 4: Collisioni Ship↔Ship via grid ──────────────────
    // Evita il doppio ciclo O(n²): per ogni nave interroga solo le celle vicine
    const allShips = [
        ...Object.values(players).filter(p => !p.isDead),
        ...Object.values(npcs)
    ];
    if (kraken) allShips.push(kraken);

    const checkedPairs = new Set();
    for (const s1 of allShips) {
        const candidates = shipGrid.query(s1.x, s1.y, s1.radius * 2);
        for (const s2 of candidates) {
            if (s1 === s2) continue;
            // Evita di controllare la stessa coppia due volte
            const pairKey = s1.id < s2.id ? `${s1.id}|${s2.id}` : `${s2.id}|${s1.id}`;
            if (checkedPairs.has(pairKey)) continue;
            checkedPairs.add(pairKey);

            const dx   = s2.x - s1.x;
            const dy   = s2.y - s1.y;
            const distSqVal = dx * dx + dy * dy;
            const minDist   = s1.radius + s2.radius;
            // MOD 9: confronto quadrati prima della sqrt
            if (distSqVal < minDist * minDist && distSqVal > 0) {
                const distance = Math.sqrt(distSqVal);
                const overlap  = minDist - distance;
                const nx = dx / distance;
                const ny = dy / distance;
                if (s1.id !== 'kraken') { s1.x -= nx * (overlap / 2); s1.y -= ny * (overlap / 2); }
                if (s2.id !== 'kraken') { s2.x += nx * (overlap / 2); s2.y += ny * (overlap / 2); }
            }
        }
    }

    // ── MOD 4: Proiettili (con bullet grid per hit detection) ─
    bulletGrid.clear();
    // Inserisce tutti i target (players + npcs + kraken) nella bullet grid
    for (const id in players) {
        const p = players[id];
        if (!p.isDead) bulletGrid.insert({ type: 'player', ref: p }, p.x, p.y, p.radius);
    }
    for (const id in npcs) {
        const n = npcs[id];
        bulletGrid.insert({ type: 'npc', ref: n }, n.x, n.y, n.radius);
    }
    if (kraken) bulletGrid.insert({ type: 'kraken', ref: kraken }, kraken.x, kraken.y, kraken.radius);

    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.x += b.vx;
        b.y += b.vy;
        b.life--;

        let hit = false;

        // MOD 4: interroga solo i target vicini al proiettile
        const targets = bulletGrid.query(b.x, b.y, 60);

        for (const target of targets) {
            if (hit) break;
            const ref = target.ref;

            if (target.type === 'player') {
                const pid = ref.id;
                if (ref.isDead || pid === b.playerId || (b.crew && b.crew === ref.crew)) continue;
                const dx = b.x - ref.x; const dy = b.y - ref.y;
                // MOD 9: confronto quadrati
                if (dx * dx + dy * dy < ref.radius * ref.radius) {
                    ref.hp -= b.dmg;
                    hit = true;
                    io.emit('effect', { type: 'hit', x: b.x, y: b.y, targetId: pid });
                    if (ref.hp <= 0) {
                        ref.isDead = true;
                        io.emit('effect', { type: 'explosion', x: ref.x, y: ref.y });
                        io.emit('chatMessage', { sender: 'SISTEMA', text: `☠️ ${ref.name} è affondato.`, type: 'system' });
                        if (players[b.playerId]) players[b.playerId].gold += 150;
                        setTimeout(() => {
                            if (players[pid]) {
                                ref.hp = ref.maxHp; ref.isDead = false;
                                ref.x = Math.random() * MAP_SIZE;
                                ref.y = Math.random() * MAP_SIZE;
                            }
                        }, 4000);
                    }
                }
            } else if (target.type === 'npc') {
                const nid = ref.id;
                if (nid === b.playerId) continue;
                const dx = b.x - ref.x; const dy = b.y - ref.y;
                if (dx * dx + dy * dy < ref.radius * ref.radius) {
                    ref.hp -= b.dmg;
                    hit = true;
                    io.emit('effect', { type: 'hit', x: b.x, y: b.y, targetId: nid });
                    if (ref.hp <= 0) {
                        if (players[b.playerId]) players[b.playerId].gold += ref.goldValue;
                        io.emit('effect', { type: 'explosion', x: ref.x, y: ref.y });
                        delete npcs[nid];
                    }
                }
            } else if (target.type === 'kraken') {
                if (b.playerId === 'kraken') continue;
                const dx = b.x - kraken.x; const dy = b.y - kraken.y;
                if (dx * dx + dy * dy < kraken.radius * kraken.radius) {
                    kraken.hp -= b.dmg;
                    hit = true;
                    io.emit('effect', { type: 'hit', x: b.x, y: b.y, color: 'purple' });
                    if (kraken.hp <= 0) {
                        if (players[b.playerId]) players[b.playerId].gold += 2500;
                        io.emit('effect', { type: 'explosion', x: kraken.x, y: kraken.y });
                        io.emit('chatMessage', { sender: 'SISTEMA', text: '🦑 IL KRAKEN È STATO SCONFITTO! Tornerà tra 7 minuti.', type: 'system' });
                        krakenDeathTick = globalTicks;
                        kraken = null;
                    }
                }
            }
        }

        if (hit || b.life <= 0) bullets.splice(i, 1);
    }
}

// ── MOD 1: Avvio dei due loop separati ───────────────────────
//
//  FISICA  → 30 Hz  (ogni ~33ms) - invariato rispetto all'originale
//  RETE    → 15 Hz  (ogni ~67ms) - dimezza i byte inviati per player
//
setInterval(updatePhysics,      1000 / 30);   // MOD 1: Physics tick
setInterval(sendNetworkUpdates, 1000 / 15);   // MOD 1: Network tick

// ── Avvio server ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Corsari.io online sulla porta ${PORT}`));