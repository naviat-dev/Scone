enum LogLevel {
	Debug,
    Info,
    Warning,
    Error
}

export function log(level: LogLevel, message: string, file: string) {
    switch (level) {
        case LogLevel.Debug:
            console.debug(message);
            break;
        case LogLevel.Info:
            console.info(message);
            break;
        case LogLevel.Warning:
            console.warn(message);
            break;
        case LogLevel.Error:
            console.error(message);
            break;
    }
}