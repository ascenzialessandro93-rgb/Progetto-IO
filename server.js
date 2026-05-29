const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// Dice a Express di servire i file statici dalla cartella 'public'
app.use(express.static('public'));

// Stato globale del gioco (memorizzato in RAM sul server)
const players = {};

io.on('connection', (socket) => {
    console.log(`Un pirata si è unito alla ciurma: ${socket.id}`);

    // Configurazione iniziale del giocatore e della sua flotta
    players[socket.id] = {
        id: socket.id,
        x: Math.random() * 800,
        y: Math.random() * 600,
        color: `hsl(${Math.random() * 360}, 70%, 50%)`, // Colore casuale per la flotta
        ships: [
            { type: 'flagship', x: 0, y: 0, hp: 100 }
        ]
    };

    // Invia i dati aggiornati a tutti i giocatori
    io.emit('updatePlayers', players);

    // Riceve i comandi di movimento (click sul terreno dell'RTS)
    socket.on('moveCommand', (target) => {
        if (players[socket.id]) {
            // Aggiornamento immediato (Sostituire in futuro con fisica/accelerazione)
            players[socket.id].x = target.x;
            players[socket.id].y = target.y;
            
            // Invia le nuove posizioni a tutti
            io.emit('updatePlayers', players);
        }
    });

    // Gestione della disconnessione
    socket.on('disconnect', () => {
        console.log(`Un pirata ha abbandonato la flotta: ${socket.id}`);
        delete players[socket.id];
        io.emit('updatePlayers', players);
    });
});

// Porta dinamica richiesta dalle piattaforme di hosting
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Arrr! Il server è salpato sulla porta ${PORT}`);
});