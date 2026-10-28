package vybatron.audio;

import com.sedmelluq.discord.lavaplayer.player.AudioLoadResultHandler;
import com.sedmelluq.discord.lavaplayer.player.AudioPlayer;
import com.sedmelluq.discord.lavaplayer.player.AudioPlayerManager;
import com.sedmelluq.discord.lavaplayer.player.event.AudioEventAdapter;
import com.sedmelluq.discord.lavaplayer.tools.FriendlyException;
import com.sedmelluq.discord.lavaplayer.track.AudioPlaylist;
import com.sedmelluq.discord.lavaplayer.track.AudioTrack;
import com.sedmelluq.discord.lavaplayer.track.AudioTrackEndReason;
import com.sedmelluq.discord.lavaplayer.track.playback.AudioFrame;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.io.IOException;
import java.io.OutputStream;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;

/**
 * Audio only, as Ogg Opus, for portal listeners playing on their own device.
 * Each request decodes one YouTube video through the same pipeline Discord
 * playback uses (configured clients, OAuth, cipher, WARP egress), on a private
 * player that belongs to no Discord session. Lavalink's own authorization
 * filter guards the route; only the bot calls it.
 */
@RestController
public class AudioController {
    private static final Pattern VIDEO = Pattern.compile("[\\w-]{11}");
    private static final long MAX_DURATION_MS = TimeUnit.MINUTES.toMillis(60);
    // Decoding runs far faster than real time; a stalled source still ends.
    private static final long EXPORT_LIMIT_NANOS = TimeUnit.MINUTES.toNanos(3);
    private final AudioPlayerManager manager;
    // The bot fetches at most two songs at once; this bounds CPU the same way.
    private final Semaphore exports = new Semaphore(2);

    public AudioController(AudioPlayerManager manager) {
        this.manager = manager;
    }

    @GetMapping("/vybatron/audio/{videoId}")
    public ResponseEntity<StreamingResponseBody> audio(@PathVariable("videoId") String videoId) throws InterruptedException {
        if (!VIDEO.matcher(videoId).matches()) return ResponseEntity.badRequest().build();
        if (!exports.tryAcquire()) return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS).build();
        boolean handedOff = false;
        try {
            AudioTrack track = load("https://www.youtube.com/watch?v=" + videoId);
            if (track == null) return ResponseEntity.notFound().build();
            if (track.getInfo().isStream || track.getDuration() > MAX_DURATION_MS) return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).build();
            AudioPlayer player = manager.createPlayer();
            Export export = new Export(player, track);
            // Success is promised only once audio arrives: a song YouTube refuses
            // fails here, so the bot tries its other sources and says why.
            AudioFrame first;
            try {
                first = export.first();
            } catch (IOException failed) {
                player.destroy();
                return ResponseEntity.status(HttpStatus.BAD_GATEWAY).build();
            }
            handedOff = true;
            StreamingResponseBody body = out -> {
                try { export.write(first, out); }
                finally { player.destroy(); exports.release(); }
            };
            return ResponseEntity.ok().contentType(MediaType.parseMediaType("audio/ogg")).body(body);
        } finally {
            if (!handedOff) exports.release();
        }
    }

    private AudioTrack load(String identifier) throws InterruptedException {
        CompletableFuture<AudioTrack> result = new CompletableFuture<>();
        manager.loadItem(identifier, new AudioLoadResultHandler() {
            @Override public void trackLoaded(AudioTrack track) { result.complete(track); }
            @Override public void playlistLoaded(AudioPlaylist playlist) {
                AudioTrack selected = playlist.getSelectedTrack();
                result.complete(selected != null ? selected : playlist.getTracks().isEmpty() ? null : playlist.getTracks().get(0));
            }
            @Override public void noMatches() { result.complete(null); }
            @Override public void loadFailed(FriendlyException exception) { result.complete(null); }
        });
        try {
            return result.get(20, TimeUnit.SECONDS);
        } catch (TimeoutException | java.util.concurrent.ExecutionException failure) {
            return null;
        }
    }

    /** One song on a private player: its first frame, then the rest as Ogg Opus. */
    private static final class Export {
        private final AudioPlayer player;
        private final CountDownLatch ended = new CountDownLatch(1);
        // Set when the source fails, so a cut-off song never ends like a whole one.
        private volatile boolean failed;
        // Decoding runs far faster than real time; a stalled source still ends.
        private final long deadline = System.nanoTime() + EXPORT_LIMIT_NANOS;

        Export(AudioPlayer player, AudioTrack track) {
            this.player = player;
            player.addListener(new AudioEventAdapter() {
                @Override public void onTrackException(AudioPlayer p, AudioTrack t, FriendlyException exception) { failed = true; }
                @Override public void onTrackEnd(AudioPlayer p, AudioTrack t, AudioTrackEndReason reason) {
                    if (reason == AudioTrackEndReason.LOAD_FAILED) failed = true;
                    ended.countDown();
                }
                @Override public void onTrackStuck(AudioPlayer p, AudioTrack t, long thresholdMs) { failed = true; ended.countDown(); }
            });
            player.playTrack(track);
        }

        AudioFrame first() throws IOException {
            AudioFrame frame = next();
            if (frame == null) throw new IOException("The song produced no audio.");
            return frame;
        }

        void write(AudioFrame first, OutputStream out) throws IOException {
            OggOpusWriter ogg = new OggOpusWriter(out);
            for (AudioFrame frame = first; frame != null; frame = next()) ogg.packet(frame.getData());
            ogg.finish();
        }

        // The next Opus frame, or null once the song has ended whole.
        private AudioFrame next() throws IOException {
            try {
                while (System.nanoTime() < deadline) {
                    AudioFrame frame;
                    // No frame within the window yet; the checks below decide.
                    try { frame = player.provide(250, TimeUnit.MILLISECONDS); } catch (TimeoutException waiting) { frame = null; }
                    if (frame != null) {
                        if (frame.isTerminator()) break;
                        if (!"OPUS".equals(frame.getFormat().codecName())) throw new IOException("Lavalink is not producing Opus frames.");
                        return frame;
                    }
                    // Buffered frames are drained before the end counts.
                    if (ended.getCount() == 0 || player.getPlayingTrack() == null) break;
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("Export interrupted.", interrupted);
            }
            if (failed) throw new IOException("The song's source failed.");
            if (System.nanoTime() >= deadline) throw new IOException("The song took too long to decode.");
            return null;
        }
    }
}
