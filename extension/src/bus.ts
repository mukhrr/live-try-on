// The engine (offscreen document: camera, JoyAI socket, encoder) and the viewers (floating mirror on the
// shop page, full-screen window) talk over one BroadcastChannel. Viewers decode and draw the downlink
// themselves, so any number can watch one session and expanding to full screen needs no restart.
// Offscreen documents only get chrome.runtime, so viewers also hand the engine product and settings.

import type { OutputMeta } from "./mirror/codec";
import type { Status } from "./mirror/joyai";
import type { FrameSize } from "./mirror/media";
import type { Product } from "./types";

export const BUS_NAME = "toshoyna";

export type EnginePhase =
  | { kind: "waking"; seconds: number }
  | { kind: "camera" }
  | { kind: "needs-camera" }
  | { kind: "error"; message: string }
  | Status;

export type NetStats = { rtt: number | null; upMbit: number; downMbit: number };

export type ViewerSettings = {
  size: FrameSize;
  product: Product | null;
  serverUrl: string;
  prompt: string | null;
};

export type EngineMessage =
  | { from: "engine"; type: "phase"; phase: EnginePhase }
  | { from: "engine"; type: "frame"; data: ArrayBuffer; meta: OutputMeta }
  | { from: "engine"; type: "stats"; net: NetStats };

export type ViewerMessage =
  | { from: "viewer"; type: "hello"; viewerId: string; settings: ViewerSettings }
  | { from: "viewer"; type: "settings"; viewerId: string; settings: ViewerSettings }
  | { from: "viewer"; type: "heartbeat"; viewerId: string }
  | { from: "viewer"; type: "bye"; viewerId: string }
  | { from: "viewer"; type: "retry" }
  | { from: "permission"; type: "camera-granted" };

export type BusMessage = EngineMessage | ViewerMessage;
