namespace Scone;

public struct Config
{
	public string? OutputDirectory = null;
	public int DarkMode = 2;

	public Config() { }

	public static string GetDefaultOutputDirectory()
	{
		// Cross-platform default: Documents/Scone/Output
		string documentsPath = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
		return Path.Combine(documentsPath, "Scone", "Output");
	}
}