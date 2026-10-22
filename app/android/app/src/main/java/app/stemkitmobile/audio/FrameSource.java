package app.stemkitmobile.audio;

/** Interleaved stereo float audio, read in blocks from a position that can be moved. */
public interface FrameSource extends AutoCloseable {
    int rate();

    /** Non-blocking: copies up to {@code frames} already-decoded frames; returns how many. */
    int read(float[] dst, int offset, int frames);

    /** Moves the read position (asynchronous: data from the new spot arrives shortly). */
    void seek(long frame);

    /** Frames ready to read right now. */
    int buffered();

    /** Nothing more will ever be readable (until the next seek). */
    boolean ended();

    @Override
    void close();
}
