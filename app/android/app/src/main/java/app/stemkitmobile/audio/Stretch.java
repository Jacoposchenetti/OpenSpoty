package app.stemkitmobile.audio;

/**
 * Speed and key changes of the engine's output (cpp/stretch_jni.cpp:
 * Signalsmith Stretch, MIT). Keeps the formants in place when the key
 * moves, unlike AudioTrack's PlaybackParams, which shift voices into
 * "chipmunks". Used only from the render thread.
 */
final class Stretch implements AutoCloseable {
    static {
        System.loadLibrary("stemkit_stretch");
    }

    private long handle;

    Stretch(int sampleRate) {
        handle = create(sampleRate);
    }

    void setKey(float semitones, boolean keepFormants) {
        setKey(handle, semitones, keepFormants);
    }

    /** a discontinuity (seek, new song): forget what was buffered */
    void reset() {
        reset(handle);
    }

    /** input frames between going in and coming out */
    int latency() {
        return latency(handle);
    }

    /** interleaved stereo: inFrames in, outFrames out (inFrames / outFrames = speed) */
    void process(float[] in, int inFrames, float[] out, int outFrames) {
        process(handle, in, inFrames, out, outFrames);
    }

    @Override
    public void close() {
        if (handle != 0) destroy(handle);
        handle = 0;
    }

    private static native long create(int sampleRate);

    private static native void destroy(long h);

    private static native void setKey(long h, float semitones, boolean keepFormants);

    private static native void reset(long h);

    private static native int latency(long h);

    private static native void process(long h, float[] in, int inFrames, float[] out, int outFrames);
}
