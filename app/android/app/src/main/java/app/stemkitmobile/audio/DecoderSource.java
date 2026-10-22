package app.stemkitmobile.audio;

import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.util.Log;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.ShortBuffer;

/**
 * Streams a compressed audio file: a background thread decodes ahead into a
 * ring buffer of a few seconds, so playback starts at once instead of after
 * decoding the whole song. Seeks are sample-accurate: the decoder restarts a
 * little before the target and the frames before it are dropped.
 *
 * Frame numbers follow the decoder's output from the start of the file (the
 * same timeline AudioDecoder used when the stems were made).
 */
public final class DecoderSource implements FrameSource {
    private static final String TAG = "StemKitDecoder";

    private final String path;
    private final MediaExtractor ex = new MediaExtractor();
    private MediaCodec codec;
    private final Thread thread;
    private final Object lock = new Object();
    private final float[] ring;
    private final int capFrames;
    private int rFrame, wFrame, count; // ring indices (frames)
    private volatile int rate;
    private int channels;
    private int encoding = AudioFormat.ENCODING_PCM_16BIT;
    private volatile boolean formatKnown;
    private final long durationUs;

    private volatile boolean closed;
    private long pendingSeek = -1; // guarded by lock
    private int gen; // bumped by every seek: stale decoder output is dropped
    private boolean decoderDone; // output EOS reached for the current generation
    private long firstPtsUs = Long.MIN_VALUE;

    public DecoderSource(String path, double bufferSeconds) throws Exception {
        this.path = path;
        ex.setDataSource(path);
        MediaFormat fmt = null;
        for (int i = 0; i < ex.getTrackCount(); i++) {
            MediaFormat f = ex.getTrackFormat(i);
            String mime = f.getString(MediaFormat.KEY_MIME);
            if (mime != null && mime.startsWith("audio/")) {
                ex.selectTrack(i);
                fmt = f;
                break;
            }
        }
        if (fmt == null) {
            ex.release();
            throw new IllegalArgumentException("nessun audio in " + path);
        }
        rate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE);
        channels = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
        durationUs = fmt.containsKey(MediaFormat.KEY_DURATION) ? fmt.getLong(MediaFormat.KEY_DURATION) : -1;
        codec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME));
        codec.configure(fmt, null, null, 0);
        codec.start();
        capFrames = (int) Math.max(8192, Math.round(bufferSeconds * Math.max(rate, 44100)));
        ring = new float[capFrames * 2];
        thread = new Thread(this::run, "stemkit-decode");
        thread.setPriority(Thread.MAX_PRIORITY - 1);
        thread.start();
    }

    /** Blocks until the decoder reported its real output format (sample rate). */
    public boolean awaitFormat(long timeoutMs) throws InterruptedException {
        long end = System.currentTimeMillis() + timeoutMs;
        synchronized (lock) {
            while (!formatKnown && !closed && System.currentTimeMillis() < end) lock.wait(20);
        }
        return formatKnown;
    }

    public long durationUs() {
        return durationUs;
    }

    @Override
    public int rate() {
        return rate;
    }

    @Override
    public int read(float[] dst, int offset, int frames) {
        synchronized (lock) {
            if (pendingSeek >= 0) return 0;
            int n = Math.min(frames, count);
            for (int i = 0; i < n; i++) {
                int k = 2 * ((rFrame + i) % capFrames);
                dst[2 * (offset + i)] = ring[k];
                dst[2 * (offset + i) + 1] = ring[k + 1];
            }
            rFrame = (rFrame + n) % capFrames;
            count -= n;
            if (n > 0) lock.notifyAll();
            return n;
        }
    }

    @Override
    public void seek(long frame) {
        synchronized (lock) {
            pendingSeek = Math.max(0, frame);
            gen++;
            rFrame = wFrame = count = 0;
            decoderDone = false;
            lock.notifyAll();
        }
    }

    @Override
    public int buffered() {
        synchronized (lock) {
            return pendingSeek >= 0 ? 0 : count;
        }
    }

    @Override
    public boolean ended() {
        synchronized (lock) {
            return pendingSeek < 0 && decoderDone && count == 0;
        }
    }

    @Override
    public void close() {
        closed = true;
        synchronized (lock) {
            lock.notifyAll();
        }
        try {
            thread.join(1500);
        } catch (InterruptedException ignored) {
        }
    }

    // ------------------------------------------------------------ decoder thread

    private void run() {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        boolean inputDone = false;
        long nextFrame = 0; // frame number of the next decoded frame
        boolean resync = true; // derive nextFrame from the PTS of the next buffer
        long discardBefore = 0;
        int myGen = 0;
        try {
            while (!closed) {
                long seekTo = -1;
                synchronized (lock) {
                    if (pendingSeek >= 0 && firstPtsUs != Long.MIN_VALUE) {
                        seekTo = pendingSeek;
                        pendingSeek = -1;
                        myGen = gen;
                    } else if (pendingSeek < 0 && myGen != gen) {
                        myGen = gen;
                    }
                }
                if (seekTo >= 0) {
                    long us = firstPtsUs + seekTo * 1_000_000L / rate;
                    // restart a bit early: the decoder needs a few frames to settle
                    ex.seekTo(Math.max(0, us - 150_000), MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
                    codec.flush();
                    inputDone = false;
                    resync = true;
                    discardBefore = seekTo;
                    synchronized (lock) {
                        decoderDone = false;
                    }
                }
                synchronized (lock) {
                    // full, finished, or waiting for the first PTS before seeking: sleep
                    boolean waitingFirst = pendingSeek >= 0 && firstPtsUs == Long.MIN_VALUE;
                    if (!waitingFirst && (capFrames - count < 8192 || decoderDone) && pendingSeek < 0) {
                        lock.wait(decoderDone ? 200 : 10);
                        continue;
                    }
                }
                if (!inputDone) {
                    int ib = codec.dequeueInputBuffer(2_000);
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
                int ob = codec.dequeueOutputBuffer(info, 3_000);
                if (ob == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat out = codec.getOutputFormat();
                    rate = out.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    channels = out.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    if (out.containsKey(MediaFormat.KEY_PCM_ENCODING)) encoding = out.getInteger(MediaFormat.KEY_PCM_ENCODING);
                } else if (ob >= 0) {
                    ByteBuffer buf = codec.getOutputBuffer(ob);
                    boolean eos = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                    if (buf != null && info.size > 0) {
                        if (firstPtsUs == Long.MIN_VALUE) firstPtsUs = info.presentationTimeUs;
                        if (resync) {
                            nextFrame = Math.round((info.presentationTimeUs - firstPtsUs) * (double) rate / 1_000_000L);
                            resync = false;
                        }
                        buf.position(info.offset).limit(info.offset + info.size);
                        nextFrame = deliver(buf.slice().order(ByteOrder.LITTLE_ENDIAN), nextFrame, discardBefore, myGen);
                    }
                    codec.releaseOutputBuffer(ob, false);
                    if (!formatKnown) {
                        synchronized (lock) {
                            formatKnown = true;
                            lock.notifyAll();
                        }
                    }
                    if (eos) {
                        synchronized (lock) {
                            if (myGen == gen) decoderDone = true;
                        }
                    }
                }
            }
        } catch (Exception e) {
            if (!closed) Log.w(TAG, "decoding " + path, e);
            synchronized (lock) {
                decoderDone = true;
                formatKnown = true;
                lock.notifyAll();
            }
        } finally {
            try {
                codec.stop();
            } catch (Exception ignored) {
            }
            codec.release();
            ex.release();
        }
    }

    /** Converts one output buffer to stereo floats and appends what is past {@code discardBefore}. */
    private long deliver(ByteBuffer le, long frame, long discardBefore, int myGen) throws InterruptedException {
        int ch = Math.max(1, channels);
        FloatBuffer fb = encoding == AudioFormat.ENCODING_PCM_FLOAT ? le.asFloatBuffer() : null;
        ShortBuffer sb = fb == null ? le.asShortBuffer() : null;
        int frames = (fb != null ? fb.remaining() : sb.remaining()) / ch;
        int i = 0;
        if (frame < discardBefore) i = (int) Math.min(frames, discardBefore - frame);
        while (i < frames) {
            synchronized (lock) {
                if (myGen != gen || closed) return frame + frames; // a newer seek: drop this
                int free = capFrames - count;
                if (free == 0) {
                    lock.wait(10);
                    continue;
                }
                int n = Math.min(free, frames - i);
                for (int k = 0; k < n; k++, i++) {
                    float l, r;
                    if (fb != null) {
                        l = fb.get(i * ch);
                        r = ch > 1 ? fb.get(i * ch + 1) : l;
                    } else {
                        l = sb.get(i * ch) / 32768f;
                        r = ch > 1 ? sb.get(i * ch + 1) / 32768f : l;
                    }
                    int w = 2 * wFrame;
                    ring[w] = l;
                    ring[w + 1] = r;
                    wFrame = (wFrame + 1) % capFrames;
                }
                count += n;
            }
        }
        return frame + frames;
    }
}
