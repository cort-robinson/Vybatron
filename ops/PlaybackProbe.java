import com.fasterxml.jackson.databind.ObjectMapper;
import com.sedmelluq.discord.lavaplayer.player.*;
import com.sedmelluq.discord.lavaplayer.player.event.AudioEventAdapter;
import com.sedmelluq.discord.lavaplayer.track.*;
import com.sedmelluq.discord.lavaplayer.track.playback.AudioFrame;
import com.sedmelluq.discord.lavaplayer.format.StandardAudioDataFormats;
import com.sedmelluq.discord.lavaplayer.tools.FriendlyException;
import dev.lavalink.youtube.*;
import dev.lavalink.youtube.clients.ClientOptions;
import dev.lavalink.youtube.plugin.ClientProviderV4;
import org.yaml.snakeyaml.Yaml;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;

/** Standalone probe: no Discord connection, player mutation, or saved audio. */
public class PlaybackProbe {
    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return value instanceof Map ? (Map<String, Object>) value : Map.of();
    }

    private static String category(Throwable error) {
        StringBuilder text = new StringBuilder();
        for (Throwable e = error; e != null; e = e.getCause()) text.append(e.getClass().getName()).append(' ').append(e.getMessage());
        String message = text.toString().toLowerCase(Locale.ROOT);
        if (message.contains("unsatisfiedlinkerror") || message.contains("noclassdeffounderror") || message.contains("nosuchmethoderror")) return "probe_environment";
        if (message.contains("invalid_grant") || message.contains("invalid refresh") || message.contains("missing oauth")) return "credentials";
        if (message.contains("unknownhost") || message.contains("connectexception") || message.contains("sockettimeout")) return "network";
        if (message.contains("timeout")) return "timeout";
        return "source";
    }

    public static void main(String[] args) throws Exception {
        var logger = (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        logger.setLevel(ch.qos.logback.classic.Level.OFF);
        List<Map<String, Object>> results = new ArrayList<>();
        boolean searchOk = false;
        DefaultAudioPlayerManager manager = new DefaultAudioPlayerManager();
        boolean full = args[1].equals("full");
        manager.getConfiguration().setOutputFormat(full ? StandardAudioDataFormats.DISCORD_OPUS : StandardAudioDataFormats.DISCORD_PCM_S16_BE);
        try {
            Map<String, Object> config = map(new Yaml().load(Files.readString(Path.of(args[0]))));
            Map<String, Object> youtube = map(map(config.get("plugins")).get("youtube"));
            List<?> configuredClients = (List<?>) youtube.get("clients");
            String[] names = configuredClients.stream().map(Object::toString).toArray(String[]::new);
            var clients = new ClientProviderV4().getClients(names, name -> {
                Map<String, Object> values = map(map(youtube.get("clientOptions")).get(name));
                ClientOptions options = new ClientOptions();
                options.setPlayback(!Boolean.FALSE.equals(values.get("playback")));
                options.setSearching(!Boolean.FALSE.equals(values.get("searching")));
                options.setVideoLoading(!Boolean.FALSE.equals(values.get("videoLoading")));
                options.setPlaylistLoading(!Boolean.FALSE.equals(values.get("playlistLoading")));
                return options;
            });
            String cipher = Objects.toString(map(youtube.get("remoteCipher")).get("url"), "");
            YoutubeSourceOptions options = new YoutubeSourceOptions();
            if (!cipher.isEmpty()) options.setRemoteCipher(cipher, null, null);
            YoutubeAudioSourceManager source = new YoutubeAudioSourceManager(options, clients);
            if (Boolean.TRUE.equals(map(youtube.get("oauth")).get("enabled"))) {
                String token = System.getenv("YOUTUBE_REFRESH_TOKEN");
                if (token == null || token.isBlank()) throw new IllegalStateException("Missing OAuth refresh token");
                source.useOauth2(token, false);
            }
            String pot = System.getenv("POT_TOKEN"), visitor = System.getenv("POT_VISITOR_DATA");
            if (pot != null && !pot.isBlank() && visitor != null && !visitor.isBlank()) YoutubeSource.setPoTokenAndVisitorData(pot, visitor);
            manager.registerSourceManager(source);
            CompletableFuture<Boolean> search = new CompletableFuture<>();
            manager.loadItem("ytsearch:loser tame impala", new AudioLoadResultHandler() {
                public void trackLoaded(AudioTrack track) { search.complete(true); }
                public void playlistLoaded(AudioPlaylist playlist) { search.complete(!playlist.getTracks().isEmpty()); }
                public void noMatches() { search.complete(false); }
                public void loadFailed(FriendlyException e) { search.complete(false); }
            });
            searchOk = search.get(30, TimeUnit.SECONDS);
            for (int index = 2; index < args.length; index++) results.add(check(manager, args[index], full));
        } catch (Throwable error) {
            // Never emit upstream exception text: it can include signed URLs or credentials.
            results.add(Map.of("ok", false, "category", category(error)));
        } finally {
            manager.shutdown();
        }
        System.out.println(new ObjectMapper().writeValueAsString(Map.of("ok", searchOk && !results.isEmpty() && results.stream().allMatch(r -> Boolean.TRUE.equals(r.get("ok"))), "searchOk", searchOk, "tracks", results)));
    }

    private static Map<String, Object> check(DefaultAudioPlayerManager manager, String url, boolean full) {
        AudioPlayer player = manager.createPlayer();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        AtomicReference<AudioTrackEndReason> ended = new AtomicReference<>();
        player.addListener(new AudioEventAdapter() {
            public void onTrackException(AudioPlayer p, AudioTrack t, FriendlyException e) { failure.set(e); }
            public void onTrackEnd(AudioPlayer p, AudioTrack t, AudioTrackEndReason reason) { ended.set(reason); }
        });
        try {
            CompletableFuture<AudioTrack> loaded = new CompletableFuture<>();
            manager.loadItem(url, new AudioLoadResultHandler() {
                public void trackLoaded(AudioTrack track) { loaded.complete(track); }
                public void playlistLoaded(AudioPlaylist playlist) { loaded.completeExceptionally(new IllegalStateException("Expected a single track")); }
                public void noMatches() { loaded.completeExceptionally(new IllegalStateException("No matching track")); }
                public void loadFailed(FriendlyException e) { loaded.completeExceptionally(e); }
            });
            AudioTrack track = loaded.get(30, TimeUnit.SECONDS);
            player.playTrack(track);
            long frames = 0, nonzero = 0, position = 0;
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(full ? 90 : 25);
            while ((full || frames < 250) && System.nanoTime() < deadline && failure.get() == null) {
                AudioFrame frame;
                try { frame = player.provide(1, TimeUnit.SECONDS); }
                catch (TimeoutException e) { if (ended.get() != null) break; else continue; }
                if (frame == null) { if (ended.get() != null) break; else continue; }
                if (frame.isTerminator()) break;
                frames++;
                for (byte value : frame.getData()) if (value != 0) nonzero++;
                position = frame.getTimecode();
            }
            if (failure.get() != null) throw failure.get();
            boolean complete = !full || (ended.get() == AudioTrackEndReason.FINISHED && position >= track.getDuration() - 2000);
            return Map.of("ok", frames >= 250 && nonzero > 0 && complete, "frames", frames, "positionMs", position,
                "durationMs", track.getDuration(), "category", complete ? "audio" : "incomplete", "ended", Objects.toString(ended.get(), "running"));
        } catch (Throwable error) {
            return Map.of("ok", false, "category", category(error));
        } finally {
            player.destroy();
        }
    }
}
