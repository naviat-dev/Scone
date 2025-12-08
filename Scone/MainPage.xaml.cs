using Windows.Storage.Pickers;
using WinRT.Interop;

namespace Scone;

public sealed partial class MainPage : Page
{
	private ObservableCollection<DownloadTask> tasks = [];

	public MainPage()
	{
		InitializeComponent();
		TasksList.ItemsSource = tasks;
		UpdateEmptyState();
	}

	private void AddTaskButton_Click(object sender, RoutedEventArgs e)
	{
		// Show the overlay dialog
		AddTaskOverlay.Visibility = Visibility.Visible;
		FolderPathInput.Focus(FocusState.Programmatic);
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
			TaskPath = folderPath,
			Progress = 0,
			ProgressText = "0%"
		};

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

		await dialog.ShowAsync();
	}

	private async void StartDownloadTask(DownloadTask task)
	{
		// Placeholder for actual download logic
		// This simulates progress for demonstration
		await Task.Run(async () =>
		{
			task._converter.ConvertScenery(task.TaskPath, App.AppConfig.OutputDirectory!);
		});
	}
}

// Model class for download tasks
public class DownloadTask : INotifyPropertyChanged
{
	private string _taskName = string.Empty;
	private string _taskPath = string.Empty;
	public readonly SceneryConverter _converter = new();
	private string _taskStatus = "";
	private double _progress;
	private string _progressText = "0%";

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
