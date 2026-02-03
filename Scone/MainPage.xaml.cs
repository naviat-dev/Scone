using Windows.Storage.Pickers;
#if WINDOWS
using WinRT.Interop;
#endif
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

#if WINDOWS
		nint hwnd = WindowNative.GetWindowHandle(App.MainWindow);
		InitializeWithWindow.Initialize(folderPicker, hwnd);
#endif

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

			// Set default output directory if not configured
			if (string.IsNullOrWhiteSpace(App.AppConfig.OutputDirectory))
			{
				App.AppConfig.OutputDirectory = Config.GetDefaultOutputDirectory();
				SaveConfig(); // Save the default
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

#if WINDOWS
		// Get the current window's handle (Windows only)
		nint hwnd = WindowNative.GetWindowHandle(App.MainWindow);
		InitializeWithWindow.Initialize(folderPicker, hwnd);
#endif

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
		GltfFormatToggle.IsChecked = true;
		Ac3dFormatToggle.IsChecked = true;
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

		// Determine the selected format from toggle buttons
		bool isGltf = GltfFormatToggle.IsChecked == true;
		bool isAc3d = Ac3dFormatToggle.IsChecked == true;

		// Validate that at least one format is selected
		if (!isGltf && !isAc3d)
		{
			ShowErrorDialog("Please select at least one output format.");
			return;
		}

		ConversionFormat format = ConversionFormat.Both;
		if (isGltf && !isAc3d)
			format = ConversionFormat.GltfOnly;
		else if (!isGltf && isAc3d)
			format = ConversionFormat.Ac3dOnly;

		// Add the new task
		DownloadTask newTask = new()
		{
			TaskName = taskName,
			TaskPath = folderPath,
			Progress = 0,
			ProgressText = "0%",
			Format = format
		};

		tasks.Add(newTask);
		UpdateEmptyState();

		// Hide the overlay and clear inputs
		AddTaskOverlay.Visibility = Visibility.Collapsed;
		FolderPathInput.Text = string.Empty;
		TaskNameInput.Text = string.Empty;
		GltfFormatToggle.IsChecked = true;
		Ac3dFormatToggle.IsChecked = true;

		// TODO: Start the actual download process for this task
		StartDownloadTask(newTask);
	}

	private void CancelAndSaveButton_Click(object sender, RoutedEventArgs e)
	{
		// Get the task from the button's DataContext
		if (sender is Button button && button.DataContext is DownloadTask task)
		{
			if (task.IsRunning)
			{
				task._converter.AbortAndSave = true;
			}
		}
	}

	private void CancelEntirelyButton_Click(object sender, RoutedEventArgs e)
	{
		// Get the task from the button's DataContext
		if (sender is Button button && button.DataContext is DownloadTask task)
		{
			if (task.IsRunning)
			{
				task._converter.AbortAndCancel = true;
			}
		}
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
			bool isGltf = task.Format == ConversionFormat.Both || task.Format == ConversionFormat.GltfOnly;
			bool isAc3d = task.Format == ConversionFormat.Both || task.Format == ConversionFormat.Ac3dOnly;

			Logger.Info($"Starting conversion task: {task.TaskName} (Path: {task.TaskPath}, Format: {task.Format})");
			await Task.Run(() =>
			{
				try
				{
					task._converter.ConvertScenery(task.TaskPath, App.AppConfig.OutputDirectory!, isGltf && !isAc3d, isAc3d && !isGltf);
				}
				catch (Exception innerEx)
				{
					Logger.Error($"Exception during conversion for task '{task.TaskName}'", innerEx);
					throw;
				}
			});

			// Conversion complete - remove task from UI
			Logger.Info($"Conversion completed successfully for task: {task.TaskName}");
			bool enqueued = DispatcherQueue.TryEnqueue(() =>
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

			if (!enqueued)
			{
				Logger.Warning("Failed to enqueue completion status to UI thread");
			}
		}
		catch (Exception ex)
		{
			Logger.Error($"Error in StartDownloadTask for '{task.TaskName}'", ex);
			bool enqueued = DispatcherQueue.TryEnqueue(() =>
			{
				task.IsRunning = false;
				task.Status = $"Error: {ex.Message}";
			});

			if (!enqueued)
			{
				Logger.Warning("Failed to enqueue error status to UI thread");
			}
		}
		finally
		{
			Logger.FlushToFile();
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
	private ConversionFormat _format = ConversionFormat.Both;
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
				if (_dispatcher != null)
				{
					bool enqueued = _dispatcher.TryEnqueue(() =>
					{
						try
						{
							OnPropertyChanged(nameof(Status));
						}
						catch (Exception ex)
						{
							Logger.Error("Error updating status property", ex);
						}
					});

					if (!enqueued)
					{
						Logger.Warning("Failed to enqueue status update to UI thread");
					}
				}
				else
				{
					Logger.Error("Dispatcher is null - cannot update UI");
				}
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

	public ConversionFormat Format
	{
		get => _format;
		set
		{
			_format = value;
			OnPropertyChanged();
		}
	}

	public event PropertyChangedEventHandler? PropertyChanged;

	protected void OnPropertyChanged([CallerMemberName] string? propertyName = null)
	{
		PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
	}
}

public enum ConversionFormat
{
	Both,
	GltfOnly,
	Ac3dOnly
}
