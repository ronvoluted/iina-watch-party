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

declare const iina: {
  overlay: IINAOverlay;
  sidebar: IINASidebar;
  console: IINAConsole;
};
