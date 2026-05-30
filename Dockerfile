# Usa una versione stabile di Node.js
FROM node:18

# Crea la cartella di lavoro dentro il server di Hugging Face
WORKDIR /app

# Copia i file delle dipendenze
COPY package*.json ./

# Installa le librerie (Socket.IO, Express, ecc.)
RUN npm install

# Copia tutto il resto del codice del tuo gioco
COPY . .

# Hugging Face richiede obbligatoriamente la porta 7860
EXPOSE 7860

# Comando per far partire il tuo server
CMD ["node", "server.js"]