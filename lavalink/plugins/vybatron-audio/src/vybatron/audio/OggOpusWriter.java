package vybatron.audio;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ThreadLocalRandom;

/**
 * A minimal Ogg Opus muxer (RFC 3533, RFC 7845) for 48 kHz stereo 20 ms
 * packets, the frames Lavalink produces for Discord. Pages carry about one
 * second of audio so browsers can seek by bisection over byte ranges.
 */
final class OggOpusWriter {
    private static final int SAMPLES_PER_PACKET = 960;
    // The Opus encoder's look-ahead at 48 kHz.
    private static final int PRE_SKIP = 312;
    private static final int PACKETS_PER_PAGE = 50;
    private static final int[] CRC = crcTable();

    private final OutputStream out;
    private final int serial = ThreadLocalRandom.current().nextInt();
    private int sequence;
    private long granule;
    private final ByteArrayOutputStream lacing = new ByteArrayOutputStream();
    private final ByteArrayOutputStream body = new ByteArrayOutputStream();
    private int packets;

    OggOpusWriter(OutputStream out) throws IOException {
        this.out = out;
        ByteBuffer head = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN);
        head.put("OpusHead".getBytes(StandardCharsets.US_ASCII)).put((byte) 1).put((byte) 2)
            .putShort((short) PRE_SKIP).putInt(48_000).putShort((short) 0).put((byte) 0);
        single(head.array(), 0x02);
        byte[] vendor = "Vybatron".getBytes(StandardCharsets.US_ASCII);
        ByteBuffer tags = ByteBuffer.allocate(8 + 4 + vendor.length + 4).order(ByteOrder.LITTLE_ENDIAN);
        tags.put("OpusTags".getBytes(StandardCharsets.US_ASCII)).putInt(vendor.length).put(vendor).putInt(0);
        single(tags.array(), 0);
    }

    void packet(byte[] data) throws IOException {
        if (lacing.size() + data.length / 255 + 1 > 255 || packets >= PACKETS_PER_PAGE) flush(0);
        lace(lacing, data.length);
        body.write(data);
        packets++;
        granule += SAMPLES_PER_PACKET;
    }

    void finish() throws IOException {
        flush(0x04);
        out.flush();
    }

    private void single(byte[] packet, int flags) throws IOException {
        ByteArrayOutputStream segments = new ByteArrayOutputStream();
        lace(segments, packet.length);
        page(segments.toByteArray(), packet, flags, 0);
    }

    private void flush(int flags) throws IOException {
        page(lacing.toByteArray(), body.toByteArray(), flags, granule);
        lacing.reset(); body.reset(); packets = 0;
    }

    private static void lace(ByteArrayOutputStream segments, int length) {
        int left = length;
        while (left >= 255) { segments.write(255); left -= 255; }
        segments.write(left);
    }

    private void page(byte[] segments, byte[] payload, int flags, long position) throws IOException {
        ByteBuffer page = ByteBuffer.allocate(27 + segments.length + payload.length).order(ByteOrder.LITTLE_ENDIAN);
        page.put("OggS".getBytes(StandardCharsets.US_ASCII)).put((byte) 0).put((byte) flags).putLong(position)
            .putInt(serial).putInt(sequence++).putInt(0).put((byte) segments.length).put(segments).put(payload);
        byte[] bytes = page.array();
        int crc = 0;
        for (byte value : bytes) crc = (crc << 8) ^ CRC[((crc >>> 24) ^ (value & 0xff)) & 0xff];
        ByteBuffer.wrap(bytes, 22, 4).order(ByteOrder.LITTLE_ENDIAN).putInt(crc);
        out.write(bytes);
    }

    private static int[] crcTable() {
        int[] table = new int[256];
        for (int index = 0; index < 256; index++) {
            int value = index << 24;
            for (int bit = 0; bit < 8; bit++) value = (value & 0x80000000) != 0 ? (value << 1) ^ 0x04c11db7 : value << 1;
            table[index] = value;
        }
        return table;
    }
}
