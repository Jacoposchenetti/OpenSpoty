import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Map;

import org.schabi.newpipe.extractor.InfoItem;
import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.ServiceList;
import org.schabi.newpipe.extractor.downloader.Downloader;
import org.schabi.newpipe.extractor.downloader.Request;
import org.schabi.newpipe.extractor.downloader.Response;
import org.schabi.newpipe.extractor.localization.ContentCountry;
import org.schabi.newpipe.extractor.localization.Localization;
import org.schabi.newpipe.extractor.search.SearchInfo;
import org.schabi.newpipe.extractor.services.youtube.linkHandler.YoutubeSearchQueryHandlerFactory;
import org.schabi.newpipe.extractor.stream.AudioStream;
import org.schabi.newpipe.extractor.stream.StreamInfo;
import org.schabi.newpipe.extractor.stream.StreamInfoItem;

/** Can NewPipe Extractor search YouTube and fetch a song's audio today? */
public class NpTest {
    static final class HttpDownloader extends Downloader {
        @Override
        public Response execute(Request req) throws java.io.IOException {
            HttpURLConnection c = (HttpURLConnection) new URL(req.url()).openConnection();
            c.setRequestMethod(req.httpMethod());
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0");
            for (Map.Entry<String, List<String>> h : req.headers().entrySet())
                for (String v : h.getValue()) c.addRequestProperty(h.getKey(), v);
            byte[] body = req.dataToSend();
            if (body != null) {
                c.setDoOutput(true);
                try (OutputStream o = c.getOutputStream()) { o.write(body); }
            }
            int code = c.getResponseCode();
            InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
            String text = in == null ? "" : new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
            return new Response(code, c.getResponseMessage(), c.getHeaderFields(), text, c.getURL().toString());
        }
    }

    public static void main(String[] args) throws Exception {
        NewPipe.init(new HttpDownloader(), new Localization("it", "IT"), new ContentCountry("IT"));
        var yt = ServiceList.YouTube;
        for (String q : new String[] {"coldplay yellow", "disperato erotico stomp"}) {
            for (String filter : new String[] {YoutubeSearchQueryHandlerFactory.VIDEOS, YoutubeSearchQueryHandlerFactory.MUSIC_SONGS}) {
                long t0 = System.currentTimeMillis();
                try {
                    SearchInfo info = SearchInfo.getInfo(yt, yt.getSearchQHFactory().fromQuery(q, List.of(filter), ""));
                    List<InfoItem> items = info.getRelatedItems();
                    System.out.printf("[%s | %s] %d risultati in %d ms%n", q, filter, items.size(), System.currentTimeMillis() - t0);
                    items.stream().filter(i -> i instanceof StreamInfoItem).limit(3).forEach(i -> {
                        StreamInfoItem s = (StreamInfoItem) i;
                        System.out.printf("   %s | %s | %ds | %s%n", s.getName(), s.getUploaderName(), s.getDuration(), s.getUrl());
                    });
                } catch (Exception e) {
                    System.out.printf("[%s | %s] ERRORE %s%n", q, filter, e);
                }
            }
        }
        String url = "https://www.youtube.com/watch?v=JXilibsBRh8";
        long t0 = System.currentTimeMillis();
        StreamInfo si = StreamInfo.getInfo(yt, url);
        System.out.printf("stream info: %s (%ds) in %d ms%n", si.getName(), si.getDuration(), System.currentTimeMillis() - t0);
        AudioStream best = null;
        for (AudioStream a : si.getAudioStreams()) {
            System.out.printf("   audio %s %d kbps %s delivery=%s%n", a.getFormat(), a.getAverageBitrate(), a.getCodec(), a.getDeliveryMethod());
            if (a.getFormat() != null && a.isUrl() && (best == null || a.getAverageBitrate() > best.getAverageBitrate())) best = a;
        }
        if (best == null) throw new IllegalStateException("nessun audio scaricabile");
        t0 = System.currentTimeMillis();
        long n = 0, total = best.getItagItem() != null ? best.getItagItem().getContentLength() : -1;
        final long CHUNK = 2L << 20; // 2 MB ranges: YouTube throttles long single requests
        int code = 0;
        try (OutputStream o = new FileOutputStream("test-audio." + best.getFormat().getSuffix())) {
            while (total < 0 || n < total) {
                HttpURLConnection c = (HttpURLConnection) new URL(best.getContent()).openConnection();
                c.setRequestProperty("User-Agent", "Mozilla/5.0");
                c.setRequestProperty("Range", "bytes=" + n + "-" + (n + CHUNK - 1));
                code = c.getResponseCode();
                if (total < 0) {
                    String cr = c.getHeaderField("Content-Range");
                    total = cr != null ? Long.parseLong(cr.substring(cr.indexOf('/') + 1)) : Long.MAX_VALUE;
                }
                long got = 0;
                try (InputStream in = c.getInputStream()) {
                    byte[] buf = new byte[1 << 16];
                    int r;
                    while ((r = in.read(buf)) > 0) { o.write(buf, 0, r); got += r; }
                }
                n += got;
                if (got == 0) break;
            }
        }
        System.out.printf("download HTTP %d: %.1f MB in %d ms -> test-audio.%s%n", code, n / 1e6, System.currentTimeMillis() - t0, best.getFormat().getSuffix());
    }
}
