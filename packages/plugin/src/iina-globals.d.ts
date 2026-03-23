/** Ambient type declarations for the IINA plugin runtime global. */

interface IINAOverlay {
  loadFile(path: string): void;
  postMessage(name: string, data: unknown): void;
  onMessage(name: string, callback: (data: unknown) => void): void;
}

interface IINASidebar {
  loadFile(path: string): void;
  postMessage(name: string, data: unknown): void;
  onMessage(name: string, callback: (data: unknown) => void): void;
}

interface IINAConsole {
  log(...args: unknown[]): void;
}

interface IINAStatus {
  paused: boolean;
  idle: boolean;
  position: number;
  duration: number;
  speed: number;
  url: string;
  title: string;
  isNetworkResource: boolean;
}

interface IINACore {
  status: IINAStatus;
  pause(): void;
  resume(): void;
  seek(seconds: number, exact: boolean): void;
  seekTo(seconds: number): void;
  setSpeed(speed: number): void;
  stop(): void;
}

interface IINAPreferences {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

interface IINAОSD {
  show(message: string): void;
}

interface IINAEvent {
  on(event: string, callback: (...args: unknown[]) => void): void;
}

interface IINAMpv {
  getFlag(name: string): boolean;
  getNumber(name: string): number;
  getString(name: string): string;
}

declare const iina: {
  overlay: IINAOverlay;
  sidebar: IINASidebar;
  console: IINAConsole;
  core: IINACore;
  preferences: IINAPreferences;
  osd: IINAОSD;
  event: IINAEvent;
  mpv: IINAMpv;
};
