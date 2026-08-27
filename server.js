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

    // Pipeline in due passaggi: yt-dlp scarica l'audio grezzo e lo scrive sul
    // suo stdout; ffmpeg lo legge dal proprio stdin e lo converte in mp3,
    // scrivendo il risultato sul SUO stdout, che mandiamo alla risposta HTTP.
    // (Chiedere direttamente a yt-dlp di fare extract+convert su stdout con
    // "-x --audio-format mp3 -o -" spesso produce un file vuoto: la
    // conversione con ffmpeg avviene su file temporaneo dopo il download
    // completo, passaggio che si perde quando l'output è un flusso.)

    const ytdlp = spawn('yt-dlp', [
        '-f', 'bestaudio',
        '--no-playlist',
        '-o', '-',
        cleanUrl,
    ]);

    const ffmpeg = spawn('ffmpeg', [
        '-i', 'pipe:0',
        '-vn',
        '-f', 'mp3',
        '-b:a', '192k',
        'pipe:1',
    ]);

    let responded = false;
    let bytesWritten = 0;
    let ytdlpStderr = '';
    let ffmpegStderr = '';

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="song.mp3"');

    ytdlp.stdout.pipe(ffmpeg.stdin);
    ffmpeg.stdout.on('data', (chunk) => {
        bytesWritten += chunk.length;
    });
    // IMPORTANTE: { end: false } impedisce a .pipe() di chiudere da solo la
    // risposta HTTP quando lo stream di ffmpeg finisce (anche con 0 byte in
    // caso di errore). Senza questo, .pipe() manda res.end() PRIMA che il
    // nostro controllo su bytesWritten possa intervenire, mascherando ogni
    // errore con una risposta 200 vuota. Chiudiamo noi la risposta a mano,
    // solo dopo aver verificato che sia arrivato qualcosa.
    ffmpeg.stdout.pipe(res, { end: false });

    ytdlp.stderr.on('data', (chunk) => {
        ytdlpStderr += chunk.toString();
        if (ytdlpStderr.length > 4000) ytdlpStderr = ytdlpStderr.slice(-4000);
    });

    ffmpeg.stderr.on('data', (chunk) => {
        ffmpegStderr += chunk.toString();
        if (ffmpegStderr.length > 4000) ffmpegStderr = ffmpegStderr.slice(-4000);
    });

    function failIfNothingSent(reason) {
        if (responded) return;
        responded = true;
        console.error('Download fallito:', reason, '\nyt-dlp:', ytdlpStderr, '\nffmpeg:', ffmpegStderr);
        if (!res.headersSent) {
            res.status(500)
                .setHeader('Content-Type', 'application/json'); // sovrascrive l'audio/mpeg impostato a inizio richiesta
            res.json({
                error: reason,
                ytdlpLog: ytdlpStderr.slice(-500),
                ffmpegLog: ffmpegStderr.slice(-500),
            });
        } else {
            res.end();
        }
    }

    ytdlp.on('error', (err) => failIfNothingSent('yt-dlp non avviabile: ' + err.message));
    ffmpeg.on('error', (err) => failIfNothingSent('ffmpeg non avviabile: ' + err.message));

    ytdlp.on('close', (code, signal) => {
        if (code !== 0 && bytesWritten === 0) {
            const detail = signal
                ? `yt-dlp terminato dal segnale di sistema ${signal} (probabile mancanza di memoria/OOM se SIGKILL, o crash se SIGSEGV)`
                : `yt-dlp uscito con codice ${code}`;
            failIfNothingSent(detail);
        }
    });

    ffmpeg.on('close', (code, signal) => {
        if (bytesWritten === 0) {
            const detail = signal
                ? `ffmpeg terminato dal segnale di sistema ${signal} (probabile mancanza di memoria/OOM se SIGKILL, o crash se SIGSEGV)`
                : `ffmpeg non ha prodotto alcun byte (codice uscita ${code})`;
            failIfNothingSent(detail);
        } else if (!responded) {
            responded = true;
            res.end(); // qui chiudiamo noi la risposta, ora che sappiamo che è andata bene
        }
    });

    // Se il client chiude la connessione (utente annulla), fermiamo entrambi i processi
    req.on('close', () => {
        if (!res.writableEnded) {
            ytdlp.kill('SIGKILL');
            ffmpeg.kill('SIGKILL');
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

// Endpoint diagnostico: prova SOLO yt-dlp (senza ffmpeg), scrive su /dev/null,
// per isolare se il crash avviene già con yt-dlp da solo o solo in
// combinazione con ffmpeg che gira in parallelo.
app.post('/debug-ytdlp-only', (req, res) => {
    const { videoUrl } = req.body;
    const videoId = extractVideoId(videoUrl || '');
    if (!videoId) return res.status(400).json({ error: 'URL non valido' });

    const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const startMem = process.memoryUsage().rss;
    const startTime = Date.now();

    const ytdlp = spawn('yt-dlp', [
        '-f', 'bestaudio',
        '--no-playlist',
        '-o', '/dev/null',
        cleanUrl,
    ]);

    let stderrBuf = '';
    let stdoutBytes = 0;

    ytdlp.stdout.on('data', (d) => { stdoutBytes += d.length; });
    ytdlp.stderr.on('data', (d) => {
        stderrBuf += d.toString();
        if (stderrBuf.length > 3000) stderrBuf = stderrBuf.slice(-3000);
    });

    ytdlp.on('error', (err) => {
        res.json({ ok: false, error: 'spawn error: ' + err.message });
    });

    ytdlp.on('close', (code, signal) => {
        res.json({
            ok: code === 0,
            code,
            signal,
            elapsedMs: Date.now() - startTime,
            stdoutBytesWrittenToDevNull: stdoutBytes,
            memAtStartMB: Math.round(startMem / 1024 / 1024),
            stderrTail: stderrBuf.slice(-1500),
        });
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'Server funzionante! (versione yt-dlp)' });
});

// Endpoint diagnostico: quanta memoria ha davvero il container in questo momento
app.get('/debug-memory', (req, res) => {
    const mem = process.memoryUsage();
    const toMB = (bytes) => Math.round(bytes / 1024 / 1024) + ' MB';
    res.json({
        rss: toMB(mem.rss), // memoria totale usata dal processo Node
        heapUsed: toMB(mem.heapUsed),
        heapTotal: toMB(mem.heapTotal),
        note: 'Se rss e\' vicino a 512 MB, il piano free di Render sta probabilmente causando OOM kill su yt-dlp/ffmpeg',
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server avviato sulla porta ${PORT}`);
});
