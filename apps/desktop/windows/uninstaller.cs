// dubvibe_mini uninstaller (per user). Stage 1 runs from the install
// directory: removes the HKCU uninstall entry and shortcuts, then copies
// itself to %TEMP% because the running image keeps the install directory
// locked. Stage 2 (--purge) deletes the install directory and best-effort
// deletes itself. User data stays in %LOCALAPPDATA%\dubvibe_mini on purpose.
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Uninstaller
{
    private const string Key = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\dubvibe_mini";
    private static readonly string Install = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "dubvibe_mini");

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "--purge") { Purge(args[1]); return Environment.ExitCode; }
            Registry.CurrentUser.DeleteSubKeyTree(Key, false);
            var shortcuts = new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Microsoft", "Windows", "Start Menu", "Programs", "dubvibe_mini.lnk"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "dubvibe_mini.lnk"),
            };
            foreach (string path in shortcuts) { try { File.Delete(path); } catch (IOException) { } }
            var temp = Path.Combine(Path.GetTempPath(), "dubvibe_mini-uninstall.exe");
            File.Copy(Process.GetCurrentProcess().MainModule.FileName, temp, true);
            Process.Start(new ProcessStartInfo(temp, "--purge \"" + Install + "\"") { UseShellExecute = false, CreateNoWindow = true });
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show("The removal failed.\n\n" + error.Message, "dubvibe_mini", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static void Purge(string directory)
    {
        if (!Directory.Exists(directory)) return;
        for (int attempt = 0; attempt < 5; attempt++)
        {
            try { Directory.Delete(directory, true); return; }
            catch (IOException) { }
            System.Threading.Thread.Sleep(1500);
        }
        Environment.ExitCode = 1;
    }
}
