namespace Scone;

public struct Config
{
	public string? fgdataPath = "C:\\Users\\sriem\\Documents\\Aviation\\fgdata\\fgdata_2024_1";
	public string? fgelevPath = "C:\\Program Files\\FlightGear 2024.1\\bin\\fgelev.exe";
	public string? TerraSyncTerrainPath = null;
	public string? OutputDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
	public int DarkMode = 2;

	public Config() { }
}
