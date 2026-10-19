// One-file bootstrap for dubvibe_mini on Windows x64.
// Embeds the portable ZIP (csc /embedresource) and unpacks it on first run to
// %LOCALAPPDATA%\dubvibe_mini\app, then launches the regular launcher from there.
// __STAMP__ is replaced with a fresh GUID for every build; the extracted tree
// is re-unpacked whenever the stamp no longer matches.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

internal sealed class Bootstrap : Form
{
    private const string BuildStamp = "__STAMP__";
    private const string ResourceZip = "dubvibe_mini.resources.zip";

    private readonly Label status = new Label();

    public Bootstrap()
    {
        Text = "dubvibe_mini";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        ControlBox = false;
        MinimizeBox = false;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new System.Drawing.Size(360, 96);
        status.Dock = DockStyle.Fill;
        status.TextAlign = System.Drawing.ContentAlignment.MiddleCenter;
        status.Text = "Preparing files (first launch only)…";
        Controls.Add(status);
        Shown += delegate
        {
            try { Extract(); }
            catch (Exception error)
            {
                Log(error.ToString());
                MessageBox.Show("Could not prepare the application files.\n\n" + error.Message, "dubvibe_mini", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Environment.ExitCode = 1;
                Close();
            }
        };
    }

    internal static string AppRoot()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "dubvibe_mini", "app");
    }

    internal static bool UpToDate()
    {
        string app = AppRoot();
        string stamp = Path.Combine(app, "stamp.txt");
        try
        {
            return Directory.Exists(app) && File.Exists(stamp) && File.ReadAllText(stamp) == BuildStamp
                && File.Exists(Path.Combine(app, "dubvibe_mini.exe")) && File.Exists(Path.Combine(app, "resources/build.json"));
        }
        catch (IOException) { return false; }
    }

    internal static void Launch()
    {
        Process.Start(new ProcessStartInfo(Path.Combine(AppRoot(), "dubvibe_mini.exe"))
        {
            UseShellExecute = true,
            WorkingDirectory = AppRoot(),
        });
    }

    private void Extract()
    {
        string app = AppRoot();
        string data = Path.GetDirectoryName(app);
        string stamp = Path.Combine(app, "stamp.txt");
        if (UpToDate()) { Done(); return; }
        Directory.CreateDirectory(data);
        // One extractor at a time; late joiners wait for the finished stamp.
        FileStream guard;
        try { guard = new FileStream(Path.Combine(data, "extract.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException)
        {
            for (int wait = 0; wait < 600; wait++)
            {
                System.Threading.Thread.Sleep(1000);
                if (UpToDate()) { Done(); return; }
            }
            throw new TimeoutException("File preparation is taking unusually long.");
        }
        try
        {
            if (UpToDate()) { Done(); return; }
            if (Directory.Exists(app)) Directory.Delete(app, true);
            Directory.CreateDirectory(app);
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceZip))
            using (var archive = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                int total = archive.Entries.Count, done = 0;
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                    if (relative.Length == 0 || relative.EndsWith(Path.DirectorySeparatorChar.ToString())) continue;
                    int cut = relative.IndexOf(Path.DirectorySeparatorChar);
                    if (cut < 0) throw new IOException("Unexpected archive layout: " + entry.FullName);
                    relative = relative.Substring(cut + 1);
                    string target = Path.Combine(app, relative);
                    if (!target.StartsWith(app + Path.DirectorySeparatorChar)) throw new IOException("Unsafe archive entry: " + entry.FullName);
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (Stream source = entry.Open(), output = File.Create(target)) source.CopyTo(output);
                    if (++done % 64 == 0)
                    {
                        status.Text = "Extracting files… " + done + "/" + total;
                        Application.DoEvents();
                    }
                }
            }
            File.WriteAllText(stamp, BuildStamp);
            Done();
        }
        finally { guard.Dispose(); }
    }

    private void Done()
    {
        Close();
        Launch();
    }

    internal static void Log(string line)
    {
        try
        {
            string log = Path.Combine(AppRoot(), "..", "logs");
            Directory.CreateDirectory(log);
            File.AppendAllText(Path.Combine(log, "bootstrap.log"), DateTimeOffset.Now.ToString("o") + " " + line + Environment.NewLine);
        }
        catch { /* best effort */ }
    }
}

internal static class SelfExtract
{
    [STAThread]
    private static int Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            if (Bootstrap.UpToDate()) Bootstrap.Launch();
            else Application.Run(new Bootstrap());
            return 0;
        }
        catch (Exception error)
        {
            Bootstrap.Log(error.ToString());
            MessageBox.Show("Could not prepare the application files.\n\n" + error.Message, "dubvibe_mini", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
