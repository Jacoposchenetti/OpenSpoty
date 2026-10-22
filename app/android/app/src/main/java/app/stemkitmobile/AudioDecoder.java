package app.stemkitmobile;

import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.ShortBuffer;

import app.stemkitmobile.core.Resampler;

/** Decodes any audio file Android can read into interleaved 16-bit stereo at 44.1 kHz. */
final class AudioDecoder {
    static final int RATE = 44100;

    interface Progress {
        void update(float fraction);
    }

    static final class Result {
        final short[] pcm; // interleaved L R
        final int frames;

        Result(short[] pcm, int frames) {
            this.pcm = pcm;
            this.frames = frames;
        }
    }

    private AudioDecoder() {}

    static Result decode(String path, Progress progress) throws Exception {
        MediaExtractor ex = new MediaExtractor();
        MediaCodec codec = null;
        try {
            ex.setDataSource(path);
            int track = -1;
            MediaFormat fmt = null;
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat f = ex.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    track = i;
                    fmt = f;
                    break;
                }
            }
            if (track < 0) throw new IllegalArgumentException("Il file non contiene audio");
            ex.selectTrack(track);
            long durationUs = fmt.containsKey(MediaFormat.KEY_DURATION) ? fmt.getLong(MediaFormat.KEY_DURATION) : 0;
            int rate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            int channels = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            int encoding = AudioFormat.ENCODING_PCM_16BIT;

            codec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME));
            codec.configure(fmt, null, null, 0);
            codec.start();

            int cap = (int) Math.max(RATE * 10, durationUs / 1_000_000.0 * rate * 1.05 + rate);
            short[] pcm = new short[cap * 2];
            int frames = 0;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inputDone = false, outputDone = false;
            while (!outputDone) {
                if (!inputDone) {
                    int ib = codec.dequeueInputBuffer(10_000);
                    if (ib >= 0) {
                        ByteBuffer buf = codec.getInputBuffer(ib);
                        int n = ex.readSampleData(buf, 0);
                        if (n < 0) {
                            codec.queueInputBuffer(ib, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            codec.queueInputBuffer(ib, 0, n, ex.getSampleTime(), 0);
                            ex.advance();
                        }
                    }
                }
                int ob = codec.dequeueOutputBuffer(info, 10_000);
                if (ob == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat out = codec.getOutputFormat();
                    rate = out.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    channels = out.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    if (out.containsKey(MediaFormat.KEY_PCM_ENCODING)) encoding = out.getInteger(MediaFormat.KEY_PCM_ENCODING);
                } else if (ob >= 0) {
                    ByteBuffer buf = codec.getOutputBuffer(ob);
                    if (buf != null && info.size > 0) {
                        buf.position(info.offset).limit(info.offset + info.size);
                        ByteBuffer le = buf.slice().order(ByteOrder.LITTLE_ENDIAN);
                        int count;
                        if (encoding == AudioFormat.ENCODING_PCM_FLOAT) {
                            FloatBuffer fb = le.asFloatBuffer();
                            count = fb.remaining() / channels;
                            pcm = ensure(pcm, (frames + count) * 2);
                            for (int i = 0; i < count; i++) {
                                float l = fb.get(i * channels);
                                float r = channels > 1 ? fb.get(i * channels + 1) : l;
                                pcm[2 * (frames + i)] = toShort(l);
                                pcm[2 * (frames + i) + 1] = toShort(r);
                            }
                        } else {
                            ShortBuffer sb = le.asShortBuffer();
                            count = sb.remaining() / channels;
                            pcm = ensure(pcm, (frames + count) * 2);
                            for (int i = 0; i < count; i++) {
                                short l = sb.get(i * channels);
                                short r = channels > 1 ? sb.get(i * channels + 1) : l;
                                pcm[2 * (frames + i)] = l;
                                pcm[2 * (frames + i) + 1] = r;
                            }
                        }
                        frames += count;
                        if (durationUs > 0) progress.update((float) Math.min(1.0, info.presentationTimeUs / (double) durationUs));
                    }
                    codec.releaseOutputBuffer(ob, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true;
                }
            }
            if (frames == 0) throw new IllegalArgumentException("Non riesco a leggere l'audio di questo file");
            if (rate != RATE) {
                pcm = Resampler.resample(pcm, frames, rate, RATE);
                frames = pcm.length / 2;
            }
            return new Result(pcm, frames);
        } finally {
            if (codec != null) {
                try {
                    codec.stop();
                } catch (Exception ignored) {
                }
                codec.release();
            }
            ex.release();
        }
    }

    private static short[] ensure(short[] a, int needed) {
        if (needed <= a.length) return a;
        short[] b = new short[Math.max(needed, a.length + a.length / 2)];
        System.arraycopy(a, 0, b, 0, a.length);
        return b;
    }

    private static short toShort(float v) {
        int x = Math.round(v * 32767f);
        return (short) (x > 32767 ? 32767 : Math.max(x, -32768));
    }
}
