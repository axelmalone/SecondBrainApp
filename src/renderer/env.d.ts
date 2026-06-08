import type { SecondBrainAPI } from "../shared/ipc.js";

declare global {
  interface Window {
    secondBrain: SecondBrainAPI;
  }
}

export {};
