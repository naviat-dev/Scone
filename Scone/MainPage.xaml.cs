using Windows.Storage.Pickers;
using WinRT.Interop;
using System.Text.Json;
using Microsoft.UI.Dispatching;

namespace Scone;

public sealed partial class MainPage : Page
{
	private ObservableCollection<DownloadTask> tasks = [];
	private const string ConfigFileName = "config.json";

	public MainPage()
	{
		InitializeComponent();
		TasksList.ItemsSource = tasks;
		LoadConfig();
		UpdateEmptyState();
	}

	private void SettingsButton_Click(object sender, RoutedEventArgs e)
	{
		OutputDirectoryInput.Text = App.AppConfig.OutputDirectory ?? "";
		SettingsOverlay.Visibility = Visibility.Visible;
		_ = OutputDirectoryInput.Focus(FocusState.Programmatic);
	}

	private async void BrowseOutputButton_Click(object sender, RoutedEventArgs e)
	{
		FolderPicker folderPicker = new()
		{
			SuggestedStartLocation = PickerLocationId.DocumentsLibrary
		};
		folderPicker.FileTypeFilter.Add("*");

		nint hwnd = WindowNative.GetWindowHandle(App.MainWindow);
		InitializeWithWindow.Initialize(folderPicker, hwnd);

		StorageFolder folder = await folderPicker.PickSingleFolderAsync();
		if (folder != null)
		{
			OutputDirectoryInput.Text = folder.Path;
		}
	}

	private void CancelSettingsButton_Click(object sender, RoutedEventArgs e)
	{
		SettingsOverlay.Visibility = Visibility.Collapsed;
	}

	private void SaveSettingsButton_Click(object sender, RoutedEventArgs e)
	{
		string outputDir = OutputDirectoryInput.Text?.Trim() ?? "";

		if (string.IsNullOrWhiteSpace(outputDir))
		{
			ShowErrorDialog("Please select an output directory.");
			return;
		}

		if (!Directory.Exists(outputDir))
		{
			try
			{
				Directory.CreateDirectory(outputDir);
			}
			catch (Exception ex)
			{
				ShowErrorDialog($"Could not create directory: {ex.Message}");
				return;
			}
		}

		App.AppConfig.OutputDirectory = outputDir;
		SaveConfig();
		SettingsOverlay.Visibility = Visibility.Collapsed;
	}

	private void LoadConfig()
	{
		try
		{
			string configPath = Path.Combine(ApplicationData.Current.LocalFolder.Path, ConfigFileName);
			if (File.Exists(configPath))
			{
				string json = File.ReadAllText(configPath);
				Config? config = JsonSerializer.Deserialize<Config>(json);
				if (config.HasValue)
				{
					App.AppConfig = config.Value;
				}
			}
		}
		catch { /* Ignore errors loading config */ }
	}

	private void SaveConfig()
	{
		try
		{
			string configPath = Path.Combine(ApplicationData.Current.LocalFolder.Path, ConfigFileName);
			string json = JsonSerializer.Serialize(App.AppConfig, new JsonSerializerOptions { WriteIndented = true });
			File.WriteAllText(configPath, json);
		}
		catch { /* Ignore errors saving config */ }
	}

	private void AddTaskButton_Click(object sender, RoutedEventArgs e)
	{
		if (string.IsNullOrWhiteSpace(App.AppConfig.OutputDirectory))
		{
			ShowErrorDialog("Please configure an output directory in Settings first.");
			return;
		}

		// Show the overlay dialog
		AddTaskOverlay.Visibility = Visibility.Visible;
        _ = FolderPathInput.Focus(FocusState.Programmatic);
	}

	private async void BrowseButton_Click(object sender, RoutedEventArgs e)
	{
		FolderPicker folderPicker = new()

		{
			SuggestedStartLocation = PickerLocationId.DocumentsLibrary
		};
		folderPicker.FileTypeFilter.Add("*");

		// Get the current window's handle
		nint hwnd = WindowNative.GetWindowHandle(App.MainWindow);
		InitializeWithWindow.Initialize(folderPicker, hwnd);

		StorageFolder folder = await folderPicker.PickSingleFolderAsync();
		if (folder != null)
		{
			FolderPathInput.Text = folder.Path;

			// Auto-generate task name from folder name if not specified
			if (string.IsNullOrWhiteSpace(TaskNameInput.Text))
			{
				TaskNameInput.Text = folder.Name;
			}
		}
	}

	private void CancelTaskButton_Click(object sender, RoutedEventArgs e)
	{
		// Hide the overlay dialog and clear inputs
		AddTaskOverlay.Visibility = Visibility.Collapsed;
		FolderPathInput.Text = string.Empty;
		TaskNameInput.Text = string.Empty;
	}

	private void ConfirmTaskButton_Click(object sender, RoutedEventArgs e)
	{
		string folderPath = FolderPathInput.Text!.Trim();

		if (string.IsNullOrWhiteSpace(folderPath))
		{
			// Show error - folder path is required
			ShowErrorDialog("Please enter or select a folder path.");
			return;
		}

		string taskName = TaskNameInput.Text!.Trim();
		if (string.IsNullOrWhiteSpace(taskName))
		{
			// Auto-generate task name from path
			taskName = Path.GetFileName(folderPath);
			if (string.IsNullOrWhiteSpace(taskName))
			{
				taskName = folderPath;
			}
		}

		// Add the new task
		DownloadTask newTask = new()
		{
			TaskName = taskName,
			TaskPath = folderPath
		};

		newTask.Progress = 0;
		newTask.ProgressText = "0%";

		tasks.Add(newTask);
		UpdateEmptyState();

		// Hide the overlay and clear inputs
		AddTaskOverlay.Visibility = Visibility.Collapsed;
		FolderPathInput.Text = string.Empty;
		TaskNameInput.Text = string.Empty;

		// TODO: Start the actual download process for this task
		StartDownloadTask(newTask);
	}

	private void UpdateEmptyState()
	{
		EmptyState.Visibility = tasks.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
	}

	private async void ShowErrorDialog(string message)
	{
		ContentDialog dialog = new()
		{
			Title = "Error",
			Content = message,
			CloseButtonText = "OK",
			XamlRoot = XamlRoot
		};

        _ = await dialog.ShowAsync();
	}

	private async void StartDownloadTask(DownloadTask task)
	{
		task.IsRunning = true;
		task.Status = "Starting conversion...";

		try
		{
			await Task.Run(() =>
			{
				task._converter.ConvertScenery(task.TaskPath, App.AppConfig.OutputDirectory!);
			});

			// Conversion complete - remove task from UI
			DispatcherQueue.TryEnqueue(() =>
			{
				task.IsRunning = false;
				task.Status = "Completed!";

				// Remove after a brief delay so user can see completion
				_ = Task.Delay(2000).ContinueWith(_ =>
				{
					DispatcherQueue.TryEnqueue(() =>
					{
						tasks.Remove(task);
						UpdateEmptyState();
					});
				});
			});
		}
		catch (Exception ex)
		{
			DispatcherQueue.TryEnqueue(() =>
			{
				task.IsRunning = false;
				task.Status = $"Error: {ex.Message}";
			});
		}
	}
}

// Model class for download tasks
public class DownloadTask : INotifyPropertyChanged
{
	private string _taskName = string.Empty;
	private string _taskPath = string.Empty;
	public readonly SceneryConverter _converter = new();
	private bool _isRunning = false;
	private double _progress = 0;
	private string _progressText = "0%";
	private readonly DispatcherQueue _dispatcher;

	public DownloadTask()
	{
		// Get the current dispatcher for UI thread marshaling
		_dispatcher = DispatcherQueue.GetForCurrentThread();

		// Subscribe to converter status changes and marshal to UI thread
		_converter.PropertyChanged += (s, e) =>
		{
			if (e.PropertyName == nameof(SceneryConverter.Status))
			{
				// Marshal the property change notification to the UI thread
				_dispatcher?.TryEnqueue(() =>
				{
					OnPropertyChanged(nameof(Status));
				});
			}
		};
	}

	public string TaskName
	{
		get => _taskName;
		set
		{
			_taskName = value;
			OnPropertyChanged();
		}
	}

	public string TaskPath
	{
		get => _taskPath;
		set
		{
			_taskPath = value;
			OnPropertyChanged();
		}
	}

	public bool IsRunning
	{
		get => _isRunning;
		set
		{
			_isRunning = value;
			OnPropertyChanged();
		}
	}

	public string Status
	{
		get => _converter.Status;
		set
		{
			// Allow manual override of status (e.g., for errors)
			if (_converter.Status != value)
			{
				// Use reflection to set the private backing field
				var @field = typeof(SceneryConverter).GetField("_status", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
				@field?.SetValue(_converter, value);
				OnPropertyChanged();
			}
		}
	}

	public double Progress
	{
		get => _progress;
		set
		{
			_progress = value;
			OnPropertyChanged();
		}
	}

	public string ProgressText
	{
		get => _progressText;
		set
		{
			_progressText = value;
			OnPropertyChanged();
		}
	}

	public event PropertyChangedEventHandler? PropertyChanged;

	protected void OnPropertyChanged([CallerMemberName] string? propertyName = null)
	{
		PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
	}
}
