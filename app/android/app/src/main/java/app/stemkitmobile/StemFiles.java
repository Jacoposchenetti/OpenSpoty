package app.stemkitmobile;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Stem output: streamed 16-bit WAV, then AAC (.m4a) like the PC bridge sends. */
final class StemFiles {
    private StemFiles() {}

    /** 16-bit stereo 44.1 kHz WAV written incrementally; header patched on close. */
    static final class WavWriter implements AutoCloseable {
        private final RandomAccessFile f;
        private long dataBytes = 0;
        private final byte[] scratch = new byte[1 << 16];

        WavWriter(File file) throws IOException {
            f = new RandomAccessFile(file, "rw");
            f.setLength(0);
            f.write(new byte[44]);
        }

        void write(float[] left, float[] right, int count) throws IOException {
            int pos = 0;
            for (int i = 0; i < count; i++) {
                if (pos + 4 > scratch.length) {
                    f.write(scratch, 0, pos);
                    pos = 0;
                }
                pos = put(scratch, pos, left[i]);
                pos = put(scratch, pos, right[i]);
            }
            f.write(scratch, 0, pos);
            dataBytes += (long) count * 4;
        }

        private static int put(byte[] b, int pos, float v) {
            int x = Math.round(v * 32767f);
            x = x > 32767 ? 32767 : Math.max(x, -32768);
            b[pos] = (byte) x;
            b[pos + 1] = (byte) (x >> 8);
            return pos + 2;
        }

        @Override
        public void close() throws IOException {
            ByteBuffer h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
            h.put("RIFF".getBytes()).putInt((int) (36 + dataBytes)).put("WAVE".getBytes());
            h.put("fmt ".getBytes()).putInt(16).putShort((short) 1).putShort((short) 2)
                .putInt(44100).putInt(44100 * 4).putShort((short) 4).putShort((short) 16);
            h.put("data".getBytes()).putInt((int) dataBytes);
            f.seek(0);
            f.write(h.array());
            f.close();
        }
    }

    interface Progress {
        void update(float fraction);
    }

    /**
     * Encode a WAV written by {@link WavWriter}: FLAC (lossless, raw .flac file)
     * or AAC-LC 256 kbps in an .m4a.
     */
    static void encodeWav(File wav, File outFile, boolean flac, Progress progress) throws IOException {
        final int rate = 44100, channels = 2;
        long totalBytes = wav.length() - 44;
        String mime = flac ? MediaFormat.MIMETYPE_AUDIO_FLAC : MediaFormat.MIMETYPE_AUDIO_AAC;
        MediaFormat fmt = MediaFormat.createAudioFormat(mime, rate, channels);
        if (flac) {
            fmt.setInteger(MediaFormat.KEY_FLAC_COMPRESSION_LEVEL, 5);
        } else {
            fmt.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
            fmt.setInteger(MediaFormat.KEY_BIT_RATE, 256_000);
        }
        fmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384);
        MediaCodec enc = MediaCodec.createEncoderByType(mime);
        MediaMuxer mux = null;
        java.io.OutputStream raw = null;
        boolean flacHeader = false;
        try (InputStream in = new BufferedInputStream(new FileInputStream(wav), 1 << 16)) {
            if (in.skip(44) != 44) throw new IOException("WAV troppo corto");
            enc.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            enc.start();
            if (flac) raw = new java.io.BufferedOutputStream(new java.io.FileOutputStream(outFile), 1 << 16);
            else mux = new MediaMuxer(outFile.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            int track = -1;
            boolean muxing = false;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inputDone = false, outputDone = false;
            long readBytes = 0;
            byte[] chunk = new byte[16384];
            while (!outputDone) {
                // feed every free input buffer, then drain every ready output, without
                // sleeping on timeouts (that made a 3-minute stem take over a minute)
                while (!inputDone) {
                    int ib = enc.dequeueInputBuffer(0);
                    if (ib < 0) break;
                    ByteBuffer buf = enc.getInputBuffer(ib);
                    buf.clear();
                    int want = Math.min(buf.remaining(), chunk.length) & ~3; // whole frames
                    int n = readFully(in, chunk, want);
                    long ptsUs = readBytes / 4 * 1_000_000L / rate;
                    if (n <= 0) {
                        enc.queueInputBuffer(ib, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                        inputDone = true;
                    } else {
                        buf.put(chunk, 0, n);
                        enc.queueInputBuffer(ib, 0, n, ptsUs, 0);
                        readBytes += n;
                        if (totalBytes > 0) progress.update((float) readBytes / totalBytes);
                    }
                }
                // block briefly only when the encoder has nothing ready yet
                long wait = 2_000;
                while (!outputDone) {
                    int ob = enc.dequeueOutputBuffer(info, wait);
                    wait = 0;
                    if (ob == MediaCodec.INFO_TRY_AGAIN_LATER) break;
                    if (ob == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        if (flac) {
                            ByteBuffer csd = enc.getOutputFormat().getByteBuffer("csd-0");
                            if (csd != null && !flacHeader) {
                                writeFlacHeader(raw, csd);
                                flacHeader = true;
                            }
                            muxing = true;
                        } else {
                            track = mux.addTrack(enc.getOutputFormat());
                            mux.start();
                            muxing = true;
                        }
                    } else if (ob >= 0) {
                        ByteBuffer out = enc.getOutputBuffer(ob);
                        boolean config = (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0;
                        if (out != null && info.size > 0) {
                            out.position(info.offset).limit(info.offset + info.size);
                            if (flac) {
                                if (config) {
                                    if (!flacHeader) {
                                        writeFlacHeader(raw, out);
                                        flacHeader = true;
                                    }
                                } else {
                                    if (!flacHeader) throw new IOException("FLAC senza intestazione");
                                    byte[] b = new byte[info.size];
                                    out.get(b);
                                    raw.write(b);
                                }
                                muxing = true;
                            } else if (!config && muxing) {
                                mux.writeSampleData(track, out, info);
                            }
                        }
                        enc.releaseOutputBuffer(ob, false);
                        if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true;
                    }
                }
            }
            if (!muxing) throw new IOException("encoder non avviato");
        } finally {
            if (raw != null) raw.close();
            try {
                enc.stop();
            } catch (Exception ignored) {
            }
            enc.release();
            if (mux != null) {
                try {
                    mux.stop();
                } catch (Exception ignored) {
                }
                mux.release();
            }
        }
    }

    /**
     * Android's FLAC encoder can't go back to fill in STREAMINFO's total sample
     * count; without it seeking in the file may not work, so patch it in.
     */
    static void patchFlacTotalSamples(File flac, long frames) throws IOException {
        try (RandomAccessFile f = new RandomAccessFile(flac, "rw")) {
            byte[] head = new byte[8 + 18];
            f.readFully(head);
            if (head[0] != 'f' || head[1] != 'L' || head[2] != 'a' || head[3] != 'C' || (head[4] & 0x7F) != 0) return;
            // STREAMINFO data starts at 8; total samples = low 4 bits of byte 13 + bytes 14..17
            int b13 = (head[8 + 13] & 0xF0) | (int) ((frames >>> 32) & 0x0F);
            f.seek(8 + 13);
            f.write(new byte[] {(byte) b13, (byte) (frames >>> 24), (byte) (frames >>> 16), (byte) (frames >>> 8), (byte) frames});
        }
    }

    /** "fLaC" + metadata, whether the encoder gave the full header or just STREAMINFO. */
    private static void writeFlacHeader(java.io.OutputStream o, ByteBuffer csd) throws IOException {
        ByteBuffer b = csd.duplicate();
        byte[] data = new byte[b.remaining()];
        b.get(data);
        boolean marker = data.length >= 4 && data[0] == 'f' && data[1] == 'L' && data[2] == 'a' && data[3] == 'C';
        if (!marker) {
            o.write(new byte[] {'f', 'L', 'a', 'C'});
            if (data.length == 34) o.write(new byte[] {(byte) 0x80, 0, 0, 34}); // last block, STREAMINFO, 34 bytes
        }
        o.write(data);
    }

    private static int readFully(InputStream in, byte[] b, int len) throws IOException {
        int off = 0;
        while (off < len) {
            int n = in.read(b, off, len - off);
            if (n < 0) break;
            off += n;
        }
        return off;
    }
}
