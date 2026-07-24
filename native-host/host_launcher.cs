using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

internal static class __CLASS_NAME__
{
    private const string PythonExecutable = @"__PYTHON_EXECUTABLE__";
    private const string HostScript = @"__HOST_SCRIPT__";

    private static async Task RelayAsync(Stream source, Stream destination)
    {
        var buffer = new byte[4096];
        int bytesRead;
        while ((bytesRead = await source.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0)
        {
            await destination.WriteAsync(buffer, 0, bytesRead).ConfigureAwait(false);
            await destination.FlushAsync().ConfigureAwait(false);
        }
    }

    private static async Task<int> RunAsync()
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = PythonExecutable,
            Arguments = "\"" + HostScript.Replace("\"", "\\\"") + "\"",
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        using (var child = Process.Start(startInfo))
        {
            if (child == null) return 2;
            var stdinTask = Task.Run(async () =>
            {
                await RelayAsync(Console.OpenStandardInput(), child.StandardInput.BaseStream).ConfigureAwait(false);
                child.StandardInput.Close();
            });
            var stdoutTask = RelayAsync(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
            var stderrTask = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
            await Task.WhenAll(stdinTask, stdoutTask, stderrTask).ConfigureAwait(false);
            child.WaitForExit();
            return child.ExitCode;
        }
    }

    public static int Main()
    {
        try { return RunAsync().GetAwaiter().GetResult(); }
        catch (Exception exception)
        {
            Console.Error.WriteLine(exception);
            return 1;
        }
    }
}
