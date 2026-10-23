// OpenSpoty.exe: the app for a Windows PC, from the unpacked zip.
// Starts the bridge (bundled Python, hidden) unless it is already running,
// opens the app in its own Edge window, and stops the bridge when that window
// closes. "/background" = only the bridge. Built by tools/pc/package.sh.
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

static class Launcher
{
    static string port = Environment.GetEnvironmentVariable("OPENSPOTY_PORT") ?? "8777";

    static bool Up()
    {
        try
        {
            var r = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/ping");
            r.Timeout = 1000;
            using (var res = (HttpWebResponse)r.GetResponse()) return res.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    static string Edge()
    {
        foreach (var env in new[] { "ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA" })
        {
            var dir = Environment.GetEnvironmentVariable(env);
            if (dir == null) continue;
            var p = Path.Combine(dir, @"Microsoft\Edge\Application\msedge.exe");
            if (File.Exists(p)) return p;
        }
        return null;
    }

    static void Shortcut(string target, string at)
    {
        try
        {
            var t = Type.GetTypeFromProgID("WScript.Shell");
            var sh = Activator.CreateInstance(t);
            var lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, sh, new object[] { at });
            var lt = lnk.GetType();
            lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
            lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { Path.GetDirectoryName(target) });
            lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { target + ",0" });
            lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
        }
        catch { /* no shortcut: the exe still works */ }
    }

    [STAThread]
    static int Main(string[] args)
    {
        string exe = Assembly.GetExecutingAssembly().Location;
        string root = Path.GetDirectoryName(exe);
        string home = Path.Combine(root, "app");
        string data = Environment.GetEnvironmentVariable("OPENSPOTY_DATA");
        string local = data ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OpenSpoty");
        string library = data != null ? Path.Combine(data, "library")
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "OpenSpoty");
        Directory.CreateDirectory(local);
        bool background = args.Length > 0 && args[0] == "/background";

        Process bridge = null;
        if (!Up())
        {
            string py = Path.Combine(home, @"python\python.exe");
            string script = Path.Combine(home, @"bridge\stemkit_bridge.py");
            string log = Path.Combine(local, "bridge.log");
            var psi = new ProcessStartInfo("cmd.exe", "/c \"\"" + py + "\" -u \"" + script + "\" > \"" + log + "\" 2>&1\"");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.EnvironmentVariables["OPENSPOTY_HOME"] = home;
            psi.EnvironmentVariables["STEMKIT_APP_DIR"] = home;
            psi.EnvironmentVariables["STEMKIT_DATA_DIR"] = local;
            psi.EnvironmentVariables["STEMKIT_MOBILE_DIR"] = library;
            psi.EnvironmentVariables["STEMKIT_BRIDGE_PORT"] = port;
            psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
            psi.EnvironmentVariables["PYTHONUTF8"] = "1";
            bridge = Process.Start(psi);
            for (int i = 0; i < 60 && !Up(); i++)
            {
                if (bridge.HasExited) break;
                Thread.Sleep(500);
            }
            if (!Up())
            {
                string tail = "";
                try { tail = File.ReadAllText(log); if (tail.Length > 1500) tail = tail.Substring(tail.Length - 1500); } catch { }
                MessageBox.Show("OpenSpoty non è riuscito a partire.\n\n" + tail, "OpenSpoty", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Kill(bridge);
                return 1;
            }
        }
        if (background)
        {
            if (bridge != null) bridge.WaitForExit();
            return 0;
        }

        // the first time: a shortcut on the Desktop (never over one already there)
        string mark = Path.Combine(local, "shortcut-done");
        string lnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "OpenSpoty.lnk");
        if (!File.Exists(mark))
        {
            if (!File.Exists(lnk)) Shortcut(exe, lnk);
            try { File.WriteAllText(mark, "1"); } catch { }
        }

        string edge = Edge();
        string url = "http://127.0.0.1:" + port + "/";
        if (edge == null)
        {
            Process.Start(url); // no Edge: the default browser
            if (bridge != null) bridge.WaitForExit();
            return 0;
        }
        var win = Process.Start(edge, "--app=" + url + " --user-data-dir=\"" + Path.Combine(local, "edge") + "\""
            // a profile of its own: no first-run pages, no account sync dialog, no extensions
            + " --no-first-run --no-default-browser-check --disable-extensions --start-maximized"
            + " --disable-sync --disable-features=msImplicitSignin,msEdgeSyncConsent"
            + " --autoplay-policy=no-user-gesture-required");
        if (bridge != null)
        {
            // our own Edge profile: this process lives as long as the window
            win.WaitForExit();
            Kill(bridge);
        }
        return 0;
    }

    static void Kill(Process p)
    {
        try
        {
            var k = new ProcessStartInfo("taskkill", "/PID " + p.Id + " /T /F");
            k.UseShellExecute = false;
            k.CreateNoWindow = true;
            Process.Start(k).WaitForExit();
        }
        catch { }
    }
}
