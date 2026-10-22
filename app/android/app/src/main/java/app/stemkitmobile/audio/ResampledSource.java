package app.stemkitmobile.audio;

import app.stemkitmobile.core.StreamResampler;

/** Presents a source at another sample rate (e.g. a 48 kHz YouTube original at 44.1 kHz). */
public final class ResampledSource implements FrameSource {
    private final FrameSource inner;
    private final int outRate;
    private final double ratio;
    private final StreamResampler rs;
    private final Object lock = new Object();
    private float[] in = new float[2 * 4096];
    private float[] out = new float[2 * 4096];
    private boolean drainedAll;

    public ResampledSource(FrameSource inner, int outRate) {
        this.inner = inner;
        this.outRate = outRate;
        this.ratio = (double) outRate / inner.rate();
        rs = new StreamResampler(inner.rate(), outRate);
        rs.reset(0);
    }

    @Override
    public int rate() {
        return outRate;
    }

    @Override
    public int read(float[] dst, int offset, int frames) {
        synchronized (lock) {
            int need = rs.inputNeeded(frames);
            while (need > 0) {
                int n = Math.min(Math.min(need, inner.buffered()), in.length / 2);
                if (n <= 0) break;
                int got = inner.read(in, 0, n);
                if (got <= 0) break;
                rs.feed(in, got);
                need -= got;
            }
            boolean eof = inner.ended();
            if (out.length < 2 * frames) out = new float[2 * frames];
            int made = rs.drain(out, frames, eof);
            System.arraycopy(out, 0, dst, 2 * offset, 2 * made);
            if (eof && made == 0) drainedAll = true;
            return made;
        }
    }

    @Override
    public void seek(long frame) {
        synchronized (lock) {
            rs.reset(frame);
            drainedAll = false;
            inner.seek(rs.inputStartFor(frame));
        }
    }

    @Override
    public int buffered() {
        return (int) Math.max(0, inner.buffered() * ratio - 64);
    }

    @Override
    public boolean ended() {
        synchronized (lock) {
            return drainedAll;
        }
    }

    @Override
    public void close() {
        inner.close();
    }
}
