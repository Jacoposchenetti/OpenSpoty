package app.stemkitmobile.core;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Models too big for the APK, downloaded once from the GitHub release "models-1"
 * (assets uploaded by hand, see model-export/lyrics/README.md) into a folder of the app.
 */
public final class ModelStore {
    private static final String BASE = "https://github.com/Jacoposchenetti/OpenSpoty/releases/download/models-1/";

    public interface Progress {
        void at(float fraction);
    }

    private ModelStore() {}

    /** the Whisper folder, with every file (downloaded now if missing) */
    public static synchronized File whisper(File root, Progress progress) throws Exception {
        File dir = new File(root, "whisper-tiny");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IllegalStateException("cartella dei modelli non scrivibile");
        String[] files = Whisper.FILES;
        double[] weight = {19, 37, 0.1, 0.8}; // MB, for the progress
        double total = 0, done = 0;
        for (double w : weight) total += w;
        for (int i = 0; i < files.length; i++) {
            File f = new File(dir, files[i]);
            if (!f.isFile() || f.length() == 0) {
                final double base = done, w = weight[i], all = total;
                download(BASE + files[i], f, x -> progress.at((float) ((base + w * x) / all)));
            }
            done += weight[i];
            progress.at((float) (done / total));
        }
        return dir;
    }

    private static void download(String url, File to, Progress progress) throws Exception {
        File part = new File(to.getPath() + ".part");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(20_000);
        c.setReadTimeout(60_000);
        c.setRequestProperty("User-Agent", "OpenSpoty");
        try {
            if (c.getResponseCode() != 200) throw new IllegalStateException("download del modello non riuscito (" + c.getResponseCode() + ")");
            long len = c.getContentLengthLong(), got = 0;
            try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(part)) {
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    got += n;
                    if (len > 0) progress.at(got / (float) len);
                }
            }
        } finally {
            c.disconnect();
        }
        if (!part.renameTo(to)) throw new IllegalStateException("modello non salvato");
    }
}
