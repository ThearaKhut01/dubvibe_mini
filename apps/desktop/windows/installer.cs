// Per-user setup and uninstaller for dubvibe_mini on Windows x64.
// installer.cs embeds the portable ZIP (csc /resource) plus a compiled
// uninstall.exe, installs to %LOCALAPPDATA%\Programs\dubvibe_mini, creates
// Start Menu + Desktop shortcuts, and registers an uninstall entry in HKCU.
// __STAMP__ and __VERSION__ are replaced for every build; a differing stamp
// re-extracts (that is the upgrade path), and shortcuts stay pointing at the
// install directory. Models and tasks stay in %LOCALAPPDATA%\dubvibe_mini
// regardless of how the app is installed.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

internal sealed class SetupWindow : Form
{
    private const string BuildStamp = "__STAMP__";
    private const string BuildVersion = "__VERSION__";
    private const string BundleZip = "dubvibe_mini.resources.zip";
    private const string UninstallerResource = "dubvibe_mini.uninstall.exe";
    private static readonly string Install = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "dubvibe_mini");
    private static readonly string Data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "dubvibe_mini");

    private readonly Label status = new Label();

    public SetupWindow()
    {
        Text = "dubvibe_mini setup";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        ControlBox = false;
        MinimizeBox = false;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new System.Drawing.Size(420, 96);
        status.Dock = DockStyle.Fill;
        status.TextAlign = System.Drawing.ContentAlignment.MiddleCenter;
        status.Text = "Installing dubvibe_mini (first run only)…";
        Controls.Add(status);
        Shown += delegate
        {
            try { InstallOrUpdate(); }
            catch (Exception error)
            {
                MessageBox.Show("The installation failed.\n\n" + error.Message, "dubvibe_mini", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Environment.ExitCode = 1;
                Close();
            }
        };
    }

    private static string StartMenu()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Microsoft", "Windows", "Start Menu", "Programs", "dubvibe_mini.lnk");
    }

    private static string DesktopShortcut()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "dubvibe_mini.lnk");
    }

    private static bool UpToDate()
    {
        string stamp = Path.Combine(Install, "stamp.txt");
        try
        {
            return Directory.Exists(Install) && File.Exists(stamp) && File.ReadAllText(stamp) == BuildStamp
                && File.Exists(Path.Combine(Install, "dubvibe_mini.exe")) && File.Exists(Path.Combine(Install, "resources/build.json"));
        }
        catch (IOException) { return false; }
    }

    private void InstallOrUpdate()
    {
        if (UpToDate()) { Finish(); return; }
        Directory.CreateDirectory(Install);
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(BundleZip))
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
                string target = Path.Combine(Install, relative);
                if (!target.StartsWith(Install + Path.DirectorySeparatorChar)) throw new IOException("Unsafe archive entry: " + entry.FullName);
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                using (Stream source = entry.Open(), output = File.Create(target)) source.CopyTo(output);
                if (++done % 64 == 0)
                {
                    status.Text = "Extracting files… " + done + "/" + total;
                    Application.DoEvents();
                }
            }
        }
        File.WriteAllText(Path.Combine(Install, "stamp.txt"), BuildStamp);
        CopyUninstaller();
        Finish();
    }

    private void CopyUninstaller()
    {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(UninstallerResource))
        using (var output = File.Create(Path.Combine(Install, "uninstall.exe")))
        {
            byte[] bytes = new byte[stream.Length];
            for (long copied = 0; copied < stream.Length; copied += bytes.Length)
            {
                int read = stream.Read(bytes, 0, bytes.Length);
                output.Write(bytes, 0, read);
            }
        }
    }

    private void RegisterUninstall()
    {
        try
        {
            var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\dubvibe_mini");
            key.SetValue("DisplayName", "dubvibe_mini");
            key.SetValue("DisplayVersion", BuildVersion);
            key.SetValue("Publisher", "dubvibe_mini");
            key.SetValue("DisplayIcon", Path.Combine(Install, "dubvibe_mini.exe"));
            key.SetValue("InstallLocation", Path.Combine(Install, "dubvibe_mini.exe"));
            key.SetValue("UninstallString", Path.Combine(Install, "uninstall.exe"));
            key.SetValue("DisplaySize", "KB" + Math.Round((Directory.Exists(Install) ? DirectorySize(new DirectoryInfo(Install)) : 0) / 1024.0));
            key.Close();
        }
        catch (Exception error) { Log("uninstall registration: " + error.Message); }
    }

    private static long DirectorySize(DirectoryInfo directory)
    {
        long total = 0;
        foreach (var info in directory.GetFiles()) total += info.Length;
        foreach (var child in directory.GetDirectories()) total += DirectorySize(child);
        return total;
    }

    private void CreateShortcuts()
    {
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        foreach (string path in new[] { StartMenu(), DesktopShortcut() })
        {
            var link = shell.CreateShortcut(path);
            link.TargetPath = Path.Combine(Install, "dubvibe_mini.exe");
            link.WorkingDirectory = Install;
            link.Description = "dubvibe_mini";
            link.Save();
        }
    }

    private void Finish()
    {
        CreateShortcuts();
        RegisterUninstall();
        status.Text = "Installation ready, starting dubvibe_mini…";
        Application.DoEvents();
        Process.Start(new ProcessStartInfo(Path.Combine(Install, "dubvibe_mini.exe"))
        {
            UseShellExecute = true,
            WorkingDirectory = Install,
        });
        Close();
    }

    internal static void Log(string line)
    {
        try
        {
            string log = Path.Combine(Data, "logs");
            Directory.CreateDirectory(log);
            File.AppendAllText(Path.Combine(log, "setup.log"), DateTimeOffset.Now.ToString("o") + " " + line + Environment.NewLine);
        }
        catch { /* best effort */ }
    }
}

internal static class SetupProgram
{
    [STAThread]
    private static int Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try { Application.Run(new SetupWindow()); return 0; }
        catch (Exception error)
        {
            SetupWindow.Log(error.ToString());
            MessageBox.Show("The installation failed.\n\n" + error.Message, "dubvibe_mini", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
