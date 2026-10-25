package app.stemkitmobile;

import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/** Certificate pinning for the self-signed TLS certificate used by the PC bridge. */
final class BridgeTlsPin {
    private BridgeTlsPin() {}

    static String fingerprint(X509Certificate certificate) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte b : digest) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
        return hex.toString();
    }

    static boolean matches(X509Certificate certificate, String expected) {
        try {
            String actual = fingerprint(certificate);
            return MessageDigest.isEqual(actual.getBytes(java.nio.charset.StandardCharsets.US_ASCII),
                expected.toLowerCase(java.util.Locale.ROOT).getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        } catch (Exception e) {
            return false;
        }
    }

    static SSLContext context(String expected) throws Exception {
        if (expected == null || !expected.matches("(?i)[0-9a-f]{64}")) {
            throw new CertificateException("Impronta certificato mancante o non valida");
        }
        X509TrustManager pinned = new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("Certificati client non supportati");
            }
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain == null || chain.length == 0 || !matches(chain[0], expected)) {
                    throw new CertificateException("L'impronta del PC non corrisponde");
                }
            }
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[] {pinned}, new java.security.SecureRandom());
        return context;
    }
}
