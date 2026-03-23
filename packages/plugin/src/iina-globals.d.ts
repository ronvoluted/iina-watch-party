/** Ambient type declarations for the IINA plugin runtime global. */

interface IINAOverlay {
  loadFile(path: string): void;
}

interface IINASidebar {
  loadFile(path: string): void;
}

interface IINAConsole {
  log(...args: unknown[]): void;
}

declare const iina: {
  overlay: IINAOverlay;
  sidebar: IINASidebar;
  console: IINAConsole;
};
