using Uno.UI.Hosting;

namespace Scone;

internal class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        // CLI mode: scone --convert <inputPath> <outputPath> [--gltf] [--ac3d]
        // Bypasses the WinUI host so the converter can be exercised headlessly.
        if (args.Length > 0 && string.Equals(args[0], "--convert", StringComparison.OrdinalIgnoreCase))
        {
            RunConvertCli(args);
            return;
        }

        App.InitializeLogging();

        UnoPlatformHost host = UnoPlatformHostBuilder.Create()
            .App(() => new App())
            .UseX11()
            .UseLinuxFrameBuffer()
            .UseMacOS()
            .UseWin32()
            .Build();

        _ = host.RunAsync();
    }

    private static void RunConvertCli(string[] args)
    {
        if (args.Length < 3)
        {
            Console.WriteLine("Usage: Scone --convert <inputPath> <outputPath> [--gltf] [--ac3d]");
            Environment.ExitCode = 2;
            return;
        }

        string input = args[1];
        string output = args[2];
        bool isGltf = args.Skip(3).Any(a => string.Equals(a, "--gltf", StringComparison.OrdinalIgnoreCase));
        bool isAc3d = args.Skip(3).Any(a => string.Equals(a, "--ac3d", StringComparison.OrdinalIgnoreCase));
        if (!isGltf && !isAc3d)
        {
            // Default to glTF when no format flag was supplied.
            isGltf = true;
        }

        Console.WriteLine($"[Scone CLI] input  = {input}");
        Console.WriteLine($"[Scone CLI] output = {output}");
        Console.WriteLine($"[Scone CLI] gltf={isGltf} ac3d={isAc3d}");
        Console.WriteLine($"[Scone CLI] store  = {App.StorePath}");

        if (!Directory.Exists(App.StorePath))
        {
            Directory.CreateDirectory(App.StorePath);
        }
        if (!Directory.Exists(output))
        {
            Directory.CreateDirectory(output);
        }

        SceneryConverter converter = new();
        converter.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(SceneryConverter.Status))
            {
                Console.WriteLine($"[status] {converter.Status}");
            }
        };

        try
        {
            converter.ConvertScenery(input, output, isGltf, isAc3d);
            Console.WriteLine("[Scone CLI] done.");
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[Scone CLI] FAILED: {ex}");
            Environment.ExitCode = 1;
        }
    }
}
