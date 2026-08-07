using System.Collections.Concurrent;

namespace Scone;

public enum LogLevel
{
	Debug = 0,
	Info = 1,
	Warning = 2,
	Error = 3
}

public static class Logger
{
	private static readonly object _lock = new();
	private static LogLevel _minimumLevel = LogLevel.Debug;
	private static readonly ConcurrentQueue<string> _logBuffer = new();
	private static readonly string _logFilePath;

	static Logger()
	{
		string logDir = Path.Combine(App.StorePath, "Logs");
		if (!Directory.Exists(logDir))
		{
            _ = Directory.CreateDirectory(logDir);
		}
		_logFilePath = Path.Combine(logDir, $"scone_{DateTime.Now:yyyyMMdd_HHmmss}.log");
	}

	public static void SetMinimumLevel(LogLevel level)
	{
		_minimumLevel = level;
	}

	public static void Debug(string message)
	{
		Log(LogLevel.Debug, message);
	}

	public static void Info(string message)
	{
		Log(LogLevel.Info, message);
	}

	public static void Warning(string message)
	{
		Log(LogLevel.Warning, message);
	}

	public static void Error(string message)
	{
		Log(LogLevel.Error, message);
	}

	public static void Error(string message, Exception ex)
	{
		Log(LogLevel.Error, $"{message}\nException: {ex.Message}\nStack Trace: {ex.StackTrace}");
	}

	private static void Log(LogLevel level, string message)
	{
		if (level < _minimumLevel)
			return;

		string timestamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff");
		int threadId = Environment.CurrentManagedThreadId;
		string levelStr = level switch
		{
			LogLevel.Debug => "DEBUG",
			LogLevel.Info => "INFO ",
			LogLevel.Warning => "WARN ",
			LogLevel.Error => "ERROR",
			_ => "UNKNOWN"
		};

		string logEntry = $"[{timestamp}] [{levelStr}] [T{threadId:D3}] {message}";

		// Write to console with color
		lock (_lock)
		{
			ConsoleColor originalColor = Console.ForegroundColor;
			Console.ForegroundColor = level switch
			{
				LogLevel.Debug => ConsoleColor.Gray,
				LogLevel.Info => ConsoleColor.White,
				LogLevel.Warning => ConsoleColor.Yellow,
				LogLevel.Error => ConsoleColor.Red,
				_ => ConsoleColor.White
			};
			Console.WriteLine(logEntry);
			Console.ForegroundColor = originalColor;
		}

		// Queue for file writing
		_logBuffer.Enqueue(logEntry);

		// Flush to file periodically
		if (_logBuffer.Count >= 10)
		{
			FlushToFile();
		}
	}

	public static void FlushToFile()
	{
		lock (_lock)
		{
			if (_logBuffer.IsEmpty)
				return;

			try
			{
				using StreamWriter writer = new(_logFilePath, append: true);
				while (_logBuffer.TryDequeue(out string? entry))
				{
					writer.WriteLine(entry);
				}
			}
			catch
			{
				// Silently fail if we can't write to log file
			}
		}
	}
}
