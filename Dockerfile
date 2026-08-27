# Partiamo da un'immagine Node ufficiale, leggera
FROM node:20-slim

# Installiamo Python (serve a yt-dlp), pip, e ffmpeg (serve per convertire l'audio in mp3)
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip ffmpeg curl && \
    rm -rf /var/lib/apt/lists/*

# Installiamo yt-dlp vero e proprio (pacchetto Python, sempre aggiornato)
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp

# Cartella di lavoro dentro il container
WORKDIR /app

# Copiamo prima solo package.json per sfruttare la cache di Docker sulle dipendenze
COPY package.json .
RUN npm install --omit=dev

# Copiamo il resto del codice
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
