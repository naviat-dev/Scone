import * as fs from 'fs';
export enum LogLevel {
	Debug,
    Info,
    Warning,
    Error
}

export function log(level: LogLevel, message: string, file: string) {
    switch (level) {
        case LogLevel.Debug:
            console.debug(message);
			fs.appendFileSync(file, `[DEBUG] ${new Date().toISOString()} ${message}\n`);
            break;
        case LogLevel.Info:
            console.info(message);
			fs.appendFileSync(file, `[INFO ] ${new Date().toISOString()} ${message}\n`);
            break;
        case LogLevel.Warning:
            console.warn(message);
			fs.appendFileSync(file, `[WARN ] ${new Date().toISOString()} ${message}\n`);
            break;
        case LogLevel.Error:
            console.error(message);
			fs.appendFileSync(file, `[ERROR] ${new Date().toISOString()} ${message}\n`);
            break;
    }
}