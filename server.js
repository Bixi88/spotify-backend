const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

function extractVideoId(url) {
    const m = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
}

app.post('/download', (req, res) => {
    const { videoUrl } = req.body;
    if (!videoUrl) {
        return res.status(400).json({ error: 'URL mancante' });
    }
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
        return res.status(400).json({ error: 'URL YouTube non valido' });
    }

    const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // yt-dlp: scarica il miglior audio disponibile, lo converte in mp3 con ffmpeg
    // e lo scrive direttamente sullo stdout (-o -), che noi "pipiamo" nella risposta HTTP.
    const ytdlp = spawn('yt-dlp', [
        '-f', 'bestaudio',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '0', // qualità migliore disponibile
        '--no-playlist',
        '-o', '-',
        cleanUrl,
    ]);

    let responded = false;
    let stderrBuffer = '';

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="song.mp3"');

    ytdlp.stdout.pipe(res);

    ytdlp.stderr.on('data', (chunk) => {
        // yt-dlp scrive log/avanzamento su stderr, lo teniamo solo per debug in caso di errore
        stderrBuffer += chunk.toString();
        if (stderrBuffer.length > 4000) stderrBuffer = stderrBuffer.slice(-4000);
    });

    ytdlp.on('error', (err) => {
        console.error('Errore avvio yt-dlp:', err.message);
        if (!responded && !res.headersSent) {
            responded = true;
            res.status(500).json({ error: 'yt-dlp non disponibile sul server: ' + err.message });
        }
    });

    ytdlp.on('close', (code) => {
        if (code !== 0 && !responded) {
            responded = true;
            console.error(`yt-dlp uscito con codice ${code}. Log:`, stderrBuffer);
            if (!res.headersSent) {
                res.status(500).json({ error: 'yt-dlp ha fallito', detail: stderrBuffer.slice(-500) });
            } else {
                res.end();
            }
        }
    });

    // Se il client chiude la connessione (utente annulla), fermiamo yt-dlp per non sprecare risorse
    req.on('close', () => {
        if (!res.writableEnded) {
            ytdlp.kill('SIGKILL');
        }
    });
});

// Endpoint diagnostico: verifica che yt-dlp e ffmpeg siano davvero installati e funzionanti
app.get('/debug-tools', (req, res) => {
    const checks = {};
    let pending = 2;

    function done() {
        pending -= 1;
        if (pending === 0) res.json(checks);
    }

    const ytdlpCheck = spawn('yt-dlp', ['--version']);
    let ytdlpOut = '';
    ytdlpCheck.stdout.on('data', (d) => (ytdlpOut += d.toString()));
    ytdlpCheck.on('close', (code) => {
        checks.ytdlp = { installed: code === 0, version: ytdlpOut.trim() };
        done();
    });
    ytdlpCheck.on('error', (err) => {
        checks.ytdlp = { installed: false, error: err.message };
        done();
    });

    const ffmpegCheck = spawn('ffmpeg', ['-version']);
    let ffmpegOut = '';
    ffmpegCheck.stdout.on('data', (d) => (ffmpegOut += d.toString()));
    ffmpegCheck.on('close', (code) => {
        checks.ffmpeg = { installed: code === 0, version: ffmpegOut.split('\n')[0] };
        done();
    });
    ffmpegCheck.on('error', (err) => {
        checks.ffmpeg = { installed: false, error: err.message };
        done();
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'Server funzionante! (versione yt-dlp)' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server avviato sulla porta ${PORT}`);
});
